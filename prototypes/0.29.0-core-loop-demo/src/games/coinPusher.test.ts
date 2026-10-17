/**
 * 🪙 Coin pusher engine tests (issue #135).
 *
 * These vitest specs exercise the pure engine surface of coinPusher.ts:
 *   • shape guard accepts valid + rejects hostile peer states
 *   • the drop board is deterministic per (hole, timing bucket, seed), and
 *     every coin gets out of it
 *   • a coin lands standing on its edge, and tips over when pushed
 *   • the sweep pusher advances chips forward monotonically, never sideways
 *   • chips stack at the same spot (piles)
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
  CHUTE_MS,
  ENTRY_MS,
  CHIP_R,
  computeConservation,
  currentPusherPhase,
  DROP_PHASE_MATCH_MS,
  emptyMachine,
  hashInts,
  hasRoomForDrop,
  BOARD_MAX_MS,
  BOARD_PEGS,
  CHIP_T,
  contactSpacing,
  dropStartMs,
  FIELD_HALF_W,
  HOLE_US,
  LIP_SLIDE,
  initialCoinPusherState,
  insertOnPlatform,
  isCoinPusherState,
  isPusherDoorResult,
  isPusherEmptyRequest,
  isPusherInsertRequest,
  isPusherResult,
  MACHINE_MAX_CHIPS,
  MAX_DROP_LAG_MS,
  MAX_DROP_LEAD_MS,
  MAX_STACK_HEIGHT,
  MAX_TIMESTAMP_MS,
  normalizeCoinPusherState,
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
  simulateBoard,
  stepMachine,
  TICKS_PER_DROP,
  traceDrop,
  U_MAX,
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
function pileN(x: number, count: number, next: { id: number }, u = 0): Pile {
  const chipIds: number[] = [];
  for (let i = 0; i < count; i++) chipIds.push(next.id++);
  return { x, u, count, chipIds };
}

/** One chip standing on its edge at (x, u). */
function standingAt(x: number, next: { id: number }, u = 0): Pile {
  return { x, u, count: 1, chipIds: [next.id++], standing: true };
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

/** `perPlatform` piles of 8 chips on each platform, packed a pile apart in
 *  rows of five from each platform's back edge, the rows a pile apart
 *  across the table, with a balanced ledger. */
function fullMachine(perPlatform: number): CoinPusherState {
  const next = { id: 1 };
  const row = (from: number): Pile[] =>
    Array.from({ length: perPlatform }, (_, i) =>
      pileN(from + CHIP_R + (i % 5) * PILE_STEP, 8, next, -U_MAX + Math.floor(i / 5) * PILE_STEP));
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
      upper: [{ x: 0.30, u: 0, count: 2, chipIds: [1] }], // count != length
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
      upper: [{ x: 0.30, u: 0, count: megaChips.length, chipIds: megaChips }],
    };
    expect(isCoinPusherState(bad)).toBe(false);
  });

  it('rejects a state holding more chips than the cabinet can (aggregate cap)', () => {
    // Every pile sits on its platform and within its own limit, and the
    // ledger balances, but the total does not fit: 34 piles × 8 = 272.
    const over = fullMachine(17);
    expect(chipsInMachine(over)).toBe(272);
    expect(isCoinPusherState(over)).toBe(false);
    // …while a machine at exactly the cap is accepted.
    const atCap = fullMachine(16);
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
    expect(isPusherResult({ ...refused, reason: 'balance-full' })).toBe(true);
    expect(isPusherResult({ ...refused, reason: 'jammed' })).toBe(true);
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

  it('refuses every timestamp outside the Date range, where the phase arithmetic overflows', () => {
    const s = initialCoinPusherState(OWNER, 0);
    const drop = {
      requestId: 'r1', player: PLAYER1, hole: 1, chipId: 1, landedX: 0.3,
      paid: 0, phase: 0.25, honored: true, atMs: 5,
    };
    const answer = { kind: 'drop', requestId: 'r1', paid: 2, honored: true, atMs: 5 };
    const insert = { requestId: 'r1', player: PLAYER1, hole: 1, phase: 0.5, requestedAt: 0 };
    const door = { requestId: 'd1', requester: OWNER, requestedAt: 0 };
    const doorAnswer = { kind: 'opened', requestId: 'd1', emptied: 3, atMs: 5 };
    for (const t of [MAX_TIMESTAMP_MS, -MAX_TIMESTAMP_MS]) {
      expect(isCoinPusherState({ ...s, pusherAtMs: t })).toBe(true);
      expect(isPusherInsertRequest({ ...insert, requestedAt: t })).toBe(true);
    }
    for (const t of [Number.MAX_VALUE, -Number.MAX_VALUE, MAX_TIMESTAMP_MS * 2, -MAX_TIMESTAMP_MS - 1]) {
      expect(isCoinPusherState({ ...s, pusherAtMs: t })).toBe(false);
      expect(isCoinPusherState({ ...s, lastDrop: { ...drop, atMs: t } })).toBe(false);
      expect(isPusherResult({ ...answer, atMs: t })).toBe(false);
      expect(isPusherDoorResult({ ...doorAnswer, atMs: t })).toBe(false);
      expect(isPusherInsertRequest({ ...insert, requestedAt: t })).toBe(false);
      expect(isPusherEmptyRequest({ ...door, requestedAt: t })).toBe(false);
    }
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
    const replayable = { ...fill(5), recentDrops: [{ chipId: 4, hole: 2, phase: 0.25, atMs: 900, seed: 7, extra: 1 }] };
    expect(normalizeCoinPusherState(replayable)!.recentDrops)
      .toEqual([{ chipId: 4, hole: 2, phase: 0.25, atMs: 900, seed: 7 }]);
  });
});

// ── Recent drops (the cabinet's drop lights) ─────────────────────────────────

describe('recent drops', () => {
  const base = fill(6); // nextChipId 7
  const marks = (...holes: PusherHole[]) =>
    holes.map((hole, i) => ({ chipId: base.nextChipId - holes.length + i, hole }));

  it('the guard takes up to RECENT_DROPS_MAX well-formed marks and nothing else', () => {
    expect(isCoinPusherState({ ...base, recentDrops: marks(0, 1, 2) })).toBe(true);
    expect(isCoinPusherState({ ...base, recentDrops: [{ chipId: 1, hole: 0, phase: 0.5, atMs: 10, seed: 3 }] })).toBe(true);
    const many = Array.from({ length: RECENT_DROPS_MAX + 1 }, (_, i) => ({ chipId: i, hole: 0 }));
    for (const bad of [
      many,
      [{ chipId: 1, hole: 3 }],
      [{ chipId: -1, hole: 0 }],
      [{ chipId: 1.5, hole: 1 }],
      [{ hole: 1 }],
      // A mark for a chip the machine hasn't dropped.
      [{ chipId: base.nextChipId, hole: 0 }],
      // What replays it, malformed.
      [{ chipId: 1, hole: 0, phase: 1.5 }],
      [{ chipId: 1, hole: 0, atMs: Infinity }],
      [{ chipId: 1, hole: 0, seed: 2 ** 32 }],
      [{ chipId: 1, hole: 0, seed: 0.5 }],
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

  it('stays a phase for any two times in the Date range, however far apart', () => {
    for (const anchor of [-MAX_TIMESTAMP_MS, 0, MAX_TIMESTAMP_MS]) {
      const s = { ...initialCoinPusherState(OWNER, 0), pusherAtMs: anchor, pusherPhase: 0.4 };
      expect(isCoinPusherState(s)).toBe(true);
      for (const t of [-MAX_TIMESTAMP_MS, 0, MAX_TIMESTAMP_MS]) {
        const p = currentPusherPhase(s, t);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1);
      }
    }
    // Past the range the arithmetic is gone (MAX_VALUE − −MAX_VALUE is
    // Infinity): such a time is refused, and the anchor's own phase kept.
    const s = { ...initialCoinPusherState(OWNER, 0), pusherPhase: 0.4 };
    expect(currentPusherPhase(s, Number.MAX_VALUE)).toBe(0.4);
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

  it('holds every pile its half-depth ahead of the pusher face', () => {
    const n = { id: 1 };
    const piles = [pileN(0.02, 1, n), pileN(0.03, 1, n, 0.15)];
    const { piles: r, toppled } = settlePiles(piles, 0.10, PLAT_UP_FRONT);
    expect(r.map((p) => p.x)).toEqual([0.10 + CHIP_R, 0.10 + CHIP_R]);
    // The bar spans the table: a pile anywhere across it is pushed, and no
    // pile moves sideways.
    expect(r.map((p) => p.u)).toEqual([0, 0.15]);
    expect(toppled).toEqual([]);
  });

  it('only piles that touch across the table push each other', () => {
    const n = { id: 1 };
    // Side by side, a coin and a half apart across: no contact at all.
    const apart = settlePiles([pileN(0.30, 1, n), pileN(0.30, 1, n, 2 * CHIP_R)], -Infinity, PLAT_UP_FRONT);
    expect(apart.piles.map((p) => p.x)).toEqual([0.30, 0.30]);
    // Half a coin across: the front one sits where the two discs touch.
    const du = CHIP_R;
    const glancing = settlePiles([pileN(0.30, 1, n), pileN(0.30, 1, n, du)], -Infinity, PLAT_UP_FRONT);
    expect(glancing.piles[1].x - glancing.piles[0].x).toBeCloseTo(Math.sqrt(4 * CHIP_R * CHIP_R - du * du), 12);
    expect(glancing.piles[1].u).toBe(du);
  });

  it('tips a standing chip forward onto its face when it is pushed', () => {
    const n = { id: 1 };
    const coin = standingAt(0.20, n, 0.05);
    const { piles: r, toppled } = settlePiles([coin], 0.25, PLAT_UP_FRONT);
    expect(toppled).toEqual(coin.chipIds);
    expect(r).toHaveLength(1);
    expect(r[0].standing).toBeUndefined();
    // It is shoved to the face, then falls over its front edge.
    expect(r[0].x).toBeCloseTo(0.25 + CHIP_T / 2 + CHIP_T / 2 + CHIP_R, 12);
    expect(r[0].u).toBe(0.05);
  });

  it('leaves a standing chip standing when nothing reaches it', () => {
    const n = { id: 1 };
    const coin = standingAt(0.30, n);
    const { piles: r, toppled } = settlePiles([coin, pileN(0.45, 2, n)], 0.30 - CHIP_T / 2, PLAT_UP_FRONT);
    expect(toppled).toEqual([]);
    expect(r[0]).toEqual(coin);
  });

  it('a tipped chip that falls onto a flat pile stacks on it, and pushes on through it', () => {
    const n = { id: 1 };
    const coin = standingAt(0.20, n);
    // Flat pile centred where the coin's centre lands when it tips over.
    const target = pileN(0.20 + CHIP_T / 2 + CHIP_R, 2, n);
    const { piles: r } = settlePiles([coin, target], -Infinity, PLAT_UP_FRONT);
    // Untouched, it stands…
    expect(r.find((p) => p.standing)).toBeDefined();
    const pushed = settlePiles([coin, target], 0.21, PLAT_UP_FRONT);
    // …pushed, it falls onto the pile: three high there now.
    expect(pushed.toppled).toEqual(coin.chipIds);
    const stack = pushed.piles.find((p) => p.chipIds.includes(coin.chipIds[0]))!;
    expect(stack.chipIds).toEqual([...target.chipIds, ...coin.chipIds]);
  });

  it('a standing chip is a thin slab: a coin behind it reaches its face', () => {
    const n = { id: 1 };
    const flat = pileN(0.10, 1, n);
    const coin = standingAt(0.10, n);
    expect(contactSpacing(flat, coin)).toBeCloseTo(CHIP_R + CHIP_T / 2, 12);
    expect(contactSpacing(coin, flat)).toBeCloseTo(CHIP_R + CHIP_T / 2, 12);
    expect(contactSpacing(coin, standingAt(0.10, n))).toBe(CHIP_T);
    // Off to the side by more than a radius, a disc meets the slab's end.
    const side = pileN(0.10, 1, n, 1.5 * CHIP_R);
    const d = 0.5 * CHIP_R;
    expect(contactSpacing(coin, side)).toBeCloseTo(Math.sqrt(CHIP_R * CHIP_R - d * d) + CHIP_T / 2, 12);
    expect(contactSpacing(coin, pileN(0.10, 1, n, 2 * CHIP_R))).toBe(-Infinity);
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
    const { piles, fallen } = insertOnPlatform([], 0.30, 0, [1], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].chipIds).toEqual([1]);
    expect(fallen).toHaveLength(0);
  });

  it('stacks (merges) when landing atop an existing pile', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    const { piles } = insertOnPlatform(base, 0.30, 0, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].count).toBe(2);
    expect(piles[0].chipIds).toEqual([1, 2]);
  });

  it('stacks when landing within CHIP_R of an existing pile (snap tolerance)', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    const { piles } = insertOnPlatform(base, 0.30 + CHIP_R * 0.9, 0, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(1);
    expect(piles[0].count).toBe(2);
  });

  it('opens a distinct pile when landing beyond CHIP_R of any pile', () => {
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n)];
    // > CHIP_R off the existing centre → not a stack.
    const { piles } = insertOnPlatform(base, 0.30 + CHIP_R * 1.5, 0, [n.id++], PLAT_UP_FRONT);
    expect(piles).toHaveLength(2);
  });

  it('shoves an abutting front pile forward when a chip stacks (contact impulse)', () => {
    // Two piles almost touching. New chip lands on the back pile; front pile
    // gets shoved forward by the landing impulse (chipCount × CHIP_R / 2).
    const n = { id: 1 };
    const base = [pileN(0.30, 1, n), pileN(0.30 + PILE_STEP * 0.9, 1, n)];
    const startFrontX = base[1].x;
    const { piles } = insertOnPlatform(base, 0.30, 0, [n.id++], PLAT_UP_FRONT);
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
    const { piles, fallen } = insertOnPlatform(base, back.x, 0, [n.id++], PLAT_UP_FRONT);
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
    const { piles } = insertOnPlatform(base, 0.30, 0, [n.id++], PLAT_UP_FRONT);
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
    const { piles, fallen } = insertOnPlatform(base, 0.30, 0, [n.id++], PLAT_UP_FRONT);
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
    const { piles, fallen } = insertOnPlatform(base, startX, 0, [n.id++], PLAT_UP_FRONT);
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
    const { piles, fallen } = insertOnPlatform([], 0.80, 0, tall.chipIds, PLAT_LOW_FRONT);
    expect(fallen).toEqual([]);
    expect(piles.map((p) => p.count)).toEqual([MAX_STACK_HEIGHT, 2]);
    expect(piles[1].x).toBeCloseTo(0.80 + PILE_STEP, 12);
    expect(piles.flatMap((p) => p.chipIds)).toEqual(tall.chipIds);
  });
});

// ── simulateBoard ────────────────────────────────────────────────────────────

describe('simulateBoard', () => {
  it('is deterministic for the same (hole, timing, seed)', () => {
    for (const h of [0, 1, 2] as const) {
      for (const t of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(simulateBoard(h, t, 12345, true)).toEqual(simulateBoard(h, t, 12345, true));
      }
    }
  });

  it('different seeds usually yield different paths', () => {
    let diff = 0;
    for (let s = 0; s < 20; s++) {
      if (simulateBoard(1, 0.5, s).exitU !== simulateBoard(1, 0.5, s + 1000).exitU) diff++;
    }
    expect(diff).toBeGreaterThan(15);
  });

  it('every coin gets out between the rails, and none is held up on a peg', () => {
    const rand = lcg(5);
    let slowest = 0;
    for (let i = 0; i < 600; i++) {
      const run = simulateBoard((i % 3) as PusherHole, rand(), (rand() * 2 ** 32) >>> 0);
      expect(Math.abs(run.exitU)).toBeLessThanOrEqual(FIELD_HALF_W - CHIP_R + 1e-12);
      slowest = Math.max(slowest, run.fallMs);
    }
    // Well inside the cap that would let a stuck coin out.
    expect(slowest).toBeLessThan(BOARD_MAX_MS / 2);
  });

  it('bounces off the pegs: coins spread across the board, and each hole leans its own way', () => {
    const rand = lcg(17);
    const lanes = new Set<number>();
    const mean = [0, 0, 0];
    const N = 300;
    for (const h of [0, 1, 2] as const) {
      for (let i = 0; i < N; i++) {
        const u = simulateBoard(h, rand(), (rand() * 2 ** 32) >>> 0).exitU;
        mean[h] += u / N;
        lanes.add(Math.floor((u + FIELD_HALF_W) / (2 * CHIP_R)));
      }
    }
    // Seven coin-widths across, and coins come out of every one of them.
    expect(lanes.size).toBe(7);
    expect(mean[0]).toBeLessThan(mean[1]);
    expect(mean[1]).toBeLessThan(mean[2]);
  });

  it('never leaves a coin inside a peg', () => {
    const rand = lcg(23);
    for (let i = 0; i < 60; i++) {
      const run = simulateBoard((i % 3) as PusherHole, rand(), (rand() * 2 ** 32) >>> 0, true);
      for (const p of run.path!) {
        for (const peg of BOARD_PEGS) {
          expect(Math.hypot(p.u - peg.u, p.h - peg.h)).toBeGreaterThan(CHIP_R);
        }
      }
    }
  });

  it('traces the path from the hole to the bottom edge', () => {
    const run = simulateBoard(2, 0.4, 99, true);
    const path = run.path!;
    expect(path[0].t).toBe(0);
    expect(Math.abs(path[0].u - HOLE_US[2])).toBeLessThan(0.02);
    expect(path[path.length - 1]).toMatchObject({ t: run.fallMs, u: run.exitU, h: 0 });
    for (let i = 1; i < path.length; i++) expect(path[i].t).toBeGreaterThan(path[i - 1].t);
    // Asked for no path, it keeps none, and the outcome is the same.
    expect(simulateBoard(2, 0.4, 99)).toEqual({ exitU: run.exitU, fallMs: run.fallMs });
  });

  it('handles out-of-range timing safely (clamps)', () => {
    for (const t of [-0.5, 2, NaN]) {
      const run = simulateBoard(1, t, 7);
      expect(Number.isFinite(run.exitU)).toBe(true);
      expect(run.fallMs).toBeGreaterThan(0);
    }
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
    const full = fullMachine(16);
    expect(chipsInMachine(full)).toBe(MACHINE_MAX_CHIPS);
    expect(() => processInsert(full, PLAYER1, 1, 0.5, 42)).toThrow(/full/);
  });

  it('moves tick by TICKS_PER_DROP, and refuses a drop its counters have no room for', () => {
    const s0 = fill(10);
    const r = processInsert(s0, PLAYER1, 1, 0.5, 42);
    expect(r.state.tick - s0.tick).toBe(TICKS_PER_DROP);
    expect(r.state.nextChipId - s0.nextChipId).toBe(1);
    expect(r.state.totalInserted - s0.totalInserted).toBe(PUSHER_ANTE);
    // Right at the edge the drop still fits, and its state still reads.
    const edge = { ...s0, tick: Number.MAX_SAFE_INTEGER - TICKS_PER_DROP };
    expect(hasRoomForDrop(edge)).toBe(true);
    expect(isCoinPusherState(processInsert(edge, PLAYER1, 1, 0.5, 42).state)).toBe(true);
    // One further, for each counter a drop moves, it doesn't.
    const full: CoinPusherState[] = [
      { ...s0, tick: Number.MAX_SAFE_INTEGER - TICKS_PER_DROP + 1 },
      { ...s0, nextChipId: Number.MAX_SAFE_INTEGER },
      { ...s0, totalInserted: Number.MAX_SAFE_INTEGER },
    ];
    for (const s of full) {
      expect(hasRoomForDrop(s)).toBe(false);
      expect(() => processInsert(s, PLAYER1, 1, 0.5, 42)).toThrow(/no room/);
    }
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

// ── Standing coins, replays and older records ────────────────────────────────

describe('the drop lands standing', () => {
  /** The drop phase whose coin lands with the bar's face at `landPhase`. */
  const dropPhaseFor = (hole: PusherHole, seed: number, landPhase: number): number => {
    // The fall depends on the drop's own phase only through the hash, so
    // look for a phase whose coin lands where it is wanted.
    for (let i = 0; i < 1000; i++) {
      const p = i / 1000;
      const fall = ENTRY_MS + simulateBoard(hole, p, seed).fallMs + CHUTE_MS;
      const at = (p + fall / PUSHER_PERIOD_MS) % 1;
      if (Math.abs(at - landPhase) < 0.004) return p;
    }
    throw new Error('no such phase');
  };

  it('in front of the bar, at the spot across the table it left the board', () => {
    const s0 = fill(20);
    const r = processInsert(s0, PLAYER1, 0, 0.3, 4242, true);
    const board = simulateBoard(0, 0.3, 4242);
    expect(r.landedU).toBe(Math.max(-U_MAX, Math.min(U_MAX, board.exitU)));
    expect(r.trace!.landMs).toBe(ENTRY_MS + board.fallMs + CHUTE_MS);
    const landed = r.trace!.frames[0].upper.find((p) => p.chipIds.includes(r.chipId))!;
    expect(landed).toMatchObject({ standing: true, count: 1, u: r.landedU, x: r.landedX });
  });

  it('stays standing when it lands as the bar reaches the front, and is never reached by it', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    const phase = dropPhaseFor(1, 31, 0.5);
    const r = processInsert(s0, PLAYER1, 1, phase, 31);
    expect(r.landedX).toBe(PUSHER_MAX_X + CHIP_T / 2);
    expect(r.state.upper).toEqual([{ x: r.landedX, u: r.landedU, count: 1, chipIds: [r.chipId], standing: true }]);
    // A further cycle leaves it as it is.
    const idle = advanceSim(r.state, SETTLE_MS);
    expect(idle.state.upper).toEqual(r.state.upper);
    expect(LIP_SLIDE).toBeGreaterThan(0);
  });

  it('is knocked over when it lands with the bar going back: the bar comes forward and tips it', () => {
    const s0 = initialCoinPusherState(OWNER, 0);
    const phase = dropPhaseFor(1, 31, 0.75);
    const r = processInsert(s0, PLAYER1, 1, phase, 31, true);
    const frames = r.trace!.frames;
    const tippedAt = frames.findIndex((f) => f.upper.some((p) => p.chipIds.includes(r.chipId) && !p.standing));
    expect(frames[0].upper[0].standing).toBe(true);
    // It stood for a while before the bar came back for it…
    expect(tippedAt).toBeGreaterThan(5);
    // …and lies flat ahead of the bar's furthest reach.
    expect(r.state.upper).toEqual([{ x: expect.any(Number), u: r.landedU, count: 1, chipIds: [r.chipId] }]);
    expect(r.state.upper[0].x).toBeGreaterThanOrEqual(PUSHER_MAX_X + CHIP_R);
  });

  it('machines at rest keep some coins standing', () => {
    const rand = lcg(41);
    let s = initialCoinPusherState(OWNER, 0);
    let standing = 0;
    for (let i = 0; i < 300; i++) {
      s = processInsert(s, PLAYER1, Math.floor(rand() * 3) as PusherHole, rand() * 0.999, (rand() * 2 ** 32) >>> 0).state;
      standing += s.upper.filter((p) => p.standing).length;
      expect(isCoinPusherState(s)).toBe(true);
    }
    expect(standing).toBeGreaterThan(30);
  });
});

describe('traceDrop', () => {
  const dropOf = (r: ReturnType<typeof processInsert>, hole: PusherHole, phase: number, seed?: number) => ({
    requestId: 'r', player: PLAYER1, hole, chipId: r.chipId, landedX: r.landedX, landedU: r.landedU,
    paid: r.paid, phase, honored: true, atMs: 5_000, ...(seed === undefined ? {} : { seed }),
  });

  it('replays a drop from the record before it to exactly the record after it', () => {
    const s0 = fill(80);
    const r = processInsert(s0, PLAYER1, 2, 0.61, 2024);
    const trace = traceDrop(s0, dropOf(r, 2, 0.61, 2024))!;
    const last = trace.frames[trace.frames.length - 1];
    expect(last.upper).toEqual(r.state.upper);
    expect(last.lower).toEqual(r.state.lower);
    expect(trace.frames.flatMap((f) => f.paid)).toEqual(r.paidChipIds);
    expect(trace.board[trace.board.length - 1].t).toBe(trace.fallMs);
    expect(trace.chipId).toBe(r.chipId);
  });

  it("is null for a drop it can't replay: no seed, or not the next drop", () => {
    const s0 = fill(10);
    const r = processInsert(s0, PLAYER1, 1, 0.2, 5);
    expect(traceDrop(s0, dropOf(r, 1, 0.2))).toBeNull();
    expect(traceDrop(fill(11), dropOf(r, 1, 0.2, 5))).toBeNull();
  });

  it('dates the drop to when its coin went in, on the shared sweep clock', () => {
    const s0 = { ...initialCoinPusherState(OWNER, 1_000), pusherPhase: 0.3 };
    // A press stamped up to MAX_DROP_LEAD_MS ahead of the operator's clock
    // is in the future when it settles: the drop starts then, not a cycle back.
    for (const lag of [-MAX_DROP_LEAD_MS, -200, 0, 250, 990]) {
      const pressed = 7_777;
      const phase = currentPusherPhase(s0, pressed);
      const r = processInsert(s0, PLAYER1, 0, phase, 1);
      const start = dropStartMs(r.state, { ...dropOf(r, 0, phase, 1), atMs: pressed + lag });
      expect(start).toBeCloseTo(pressed, 6);
    }
    // The furthest lead the operator honours, with the phase off by as much
    // as it lets pass, still starts then.
    const pressed = 9_999;
    const ahead = { phase: (currentPusherPhase(s0, pressed) + DROP_PHASE_MATCH_MS / PUSHER_PERIOD_MS / 2) % 1, atMs: pressed - MAX_DROP_LEAD_MS };
    expect(Math.abs(dropStartMs(s0, ahead) - pressed)).toBeLessThan(DROP_PHASE_MATCH_MS);
  });
});

describe('records from before the drop board', () => {
  it('read with every pile on the centre line', () => {
    const s = fill(30);
    const old = {
      ...s,
      upper: s.upper.filter((p) => !p.standing).map(({ x, count, chipIds }) => ({ x, count, chipIds })),
      lower: s.lower.map(({ x, count, chipIds }) => ({ x, count, chipIds })),
    };
    old.totalInserted = chipsInMachine(old as CoinPusherState) + old.totalPaid + old.totalEmptied;
    expect(isCoinPusherState(old)).toBe(true);
    const lifted = normalizeCoinPusherState(old)!;
    expect([...lifted.upper, ...lifted.lower].every((p) => p.u === 0)).toBe(true);
    // And a drop plays on it.
    expect(isCoinPusherState(processInsert(lifted, PLAYER1, 1, 0.5, 3).state)).toBe(true);
  });

  it('the guard refuses a pile off the table across, or a standing pile that is not one chip', () => {
    const s = fill(30);
    const p0 = s.lower[0];
    for (const u of [U_MAX + 0.001, -U_MAX - 0.001, Number.NaN, Infinity]) {
      expect(isCoinPusherState({ ...s, lower: [{ ...p0, u }, ...s.lower.slice(1)] }), `u ${u}`).toBe(false);
    }
    const two = { x: 0.3, u: 0, count: 2, chipIds: [1, 2], standing: true };
    expect(isCoinPusherState({ ...s, upper: [two] })).toBe(false);
    expect(isCoinPusherState({ ...s, upper: [{ ...two, count: 1, chipIds: [1], standing: false }] })).toBe(false);
  });

  it("the guard checks a drop record's seed", () => {
    const s = fill(5);
    const d = { requestId: 'r', player: PLAYER1, hole: 1, chipId: 1, landedX: 0.3, paid: 0, phase: 0.5, honored: true, atMs: 1 };
    expect(isCoinPusherState({ ...s, lastDrop: d })).toBe(true);
    expect(isCoinPusherState({ ...s, lastDrop: { ...d, seed: 7, landedU: 0.1 } })).toBe(true);
    for (const seed of [-1, 2 ** 32, 1.5, '7']) {
      expect(isCoinPusherState({ ...s, lastDrop: { ...d, seed } }), `seed ${seed}`).toBe(false);
    }
  });
});
