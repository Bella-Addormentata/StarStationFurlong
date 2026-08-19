/**
 * Air hockey engine — issue #115 (two-player air hockey table).
 *
 * Pure functions over plain-JSON state: no DOM, no THREE, no Yjs — the same
 * layering contract as checkers.ts/chess.ts. Three concerns live here so they
 * are unit-testable in isolation (airHockey.test.ts):
 *
 *  1. THE DOC STATE (AirHockeyState) — claims/ready/fees/score/lifecycle,
 *     stored whole-value in the room doc's `games` map keyed by the table's
 *     furniture item id (games/gamesDoc.ts). Every transition is
 *     read → pure helper here → transacted write, LWW per table key.
 *     The puck and mallets are deliberately NOT in the doc: per-frame state
 *     never belongs in a CRDT (STUDY-Architecture §8.1) — they ride the
 *     datagram tick lane below.
 *
 *  2. THE PHYSICS (stepPuck) — fixed-substep 2D circle sim in the table's
 *     LOCAL frame (x across, z along; +z is side 'b'). Only the current
 *     OPERATOR client runs it (airHockeySession.ts elects one); everyone
 *     else renders from puck ticks.
 *
 *  3. THE TICK CODEC — mallet/puck datagrams reuse the 13-byte MovementTick
 *     wire format with flags bits 6–7 as the lane kind (network/protocol.ts):
 *     the node relays any 13-byte datagram verbatim, so no Rust changes.
 *     Coordinates on the wire are WORLD-space so receivers can route a tick
 *     to its table by containment, and a pre-#115 client that misparses one
 *     as movement shows an avatar over the table rather than teleporting.
 */

import type { MovementTick } from '../network/protocol';
import {
  TICK_KIND_AH_MALLET,
  TICK_KIND_AH_PUCK,
  packTickKind,
} from '../network/protocol';

// ── Table geometry (LOCAL frame, rot 0 — shared with the furniture builder) ──
// Footprint is 2×3 m (the issue's "2x3 layout"); the cabinet is inset so the
// stand points at z ±1.9 have walkable clearance, like the craps-table stands.

/** Playing-surface height above the floor (m) — real tables sit ~0.78. */
export const AH_SURFACE_Y = 0.8;
/** Playfield half-width inside the rails (local x). */
export const AH_HALF_W = 0.76;
/** Playfield half-length inside the rails (local z). */
export const AH_HALF_L = 1.26;
/** Goal-mouth half-width at each z end (0.60 m opening). */
export const AH_GOAL_HALF_W = 0.3;
/** Puck radius (m). */
export const AH_PUCK_R = 0.055;
/** Mallet radius (m). */
export const AH_MALLET_R = 0.1;

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Hard puck speed cap (m/s) — also the tick codec's quantization range. */
export const AH_PUCK_MAX_SPEED = 6.0;
/** Exponential speed-decay rate (s⁻¹) — low, it floats on an air cushion. */
const FRICTION_RATE = 0.28;
/** Rail bounce energy retention. */
const WALL_RESTITUTION = 0.94;
/** Mallet-strike bounciness (restitution on the relative normal velocity). */
const MALLET_RESTITUTION = 0.9;
/** Fixed physics substep (s): 6 m/s × 1/240 = 0.025 m ≪ puck radius, so a
 *  substep can never tunnel a rail; mallet hits are resolved per substep. */
const SIM_DT = 1 / 240;
/** Substep cap per frame — a background-tab dt spike must not spiral. */
const MAX_SUBSTEPS = 60;
/** FP slack on the goal-line test (m). A back-rail mallet ejection lands the
 *  puck centre at ±(AH_HALF_L + AH_PUCK_R) up to rounding; the goal must
 *  swallow that ulp noise or the puck settles dead on the line. A nanometre
 *  is physically meaningless yet orders of magnitude above the error. */
const GOAL_LINE_EPS = 1e-9;

/** First side to this score wins a versus match. */
export const AH_GOALS_TO_WIN = 7;
/** Pause after a goal before the next serve (ms). */
export const AH_GOAL_PAUSE_MS = 1600;
/** Delay between match start and the first serve (ms). */
export const AH_SERVE_DELAY_MS = 1200;
/** A puck slower than this for AH_STUCK_TIMEOUT_MS gets re-served. */
export const AH_STUCK_SPEED = 0.05;
export const AH_STUCK_TIMEOUT_MS = 8000;
/** Owner-set per-player fee ceiling (chips) — see casinoDoc.ts. */
export const AH_MAX_FEE = 500;

// ── Doc state ────────────────────────────────────────────────────────────────

/** Side 'a' defends the −z goal, side 'b' the +z goal (local frame). */
export type AirHockeySide = 'a' | 'b';
export type AirHockeyStatus = 'waiting' | 'playing' | 'ended';

/**
 * Doc-synced table state — plain JSON, whole-value LWW per table key.
 * `kind` discriminates it inside the shared `games` map (chess precedent).
 */
export interface AirHockeyState {
  kind: 'airhockey';
  /** Side claims — S2 player ids, claimed on walk-up. */
  players: { a: string | null; b: string | null };
  /** Ready flags — both true flips status to 'playing'. */
  ready: { a: boolean; b: boolean };
  /** Chips each side paid at ready-up (0 = free) — refunded on un-ready,
   *  final once startedAt is set. */
  paid: { a: number; b: number };
  score: { a: number; b: number };
  status: AirHockeyStatus;
  /** Who receives the next serve (the side just scored on, per convention). */
  servingSide: AirHockeySide;
  /** Wall-clock ms when the operator serves next, 0 = no serve scheduled. */
  serveAt: number;
  /** Wall-clock ms the match started, 0 = not started (fees refundable). */
  startedAt: number;
  winner: AirHockeySide | null;
}

export function initialAirHockeyState(): AirHockeyState {
  return {
    kind: 'airhockey',
    players: { a: null, b: null },
    ready: { a: false, b: false },
    paid: { a: 0, b: 0 },
    score: { a: 0, b: 0 },
    status: 'waiting',
    servingSide: 'a',
    serveAt: 0,
    startedAt: 0,
    winner: null,
  };
}

export function otherSide(side: AirHockeySide): AirHockeySide {
  return side === 'a' ? 'b' : 'a';
}

/** True when a doc-read value has the AirHockeyState shape (defensive: any
 *  peer can write the `games` map; malformed entries render as "no game"). */
export function isAirHockeyState(value: unknown): value is AirHockeyState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<AirHockeyState>;
  const playerOk = (p: unknown) =>
    p === null || (typeof p === 'string' && p.length > 0 && p.length <= 128);
  const sideRecord = (r: unknown, ok: (v: unknown) => boolean) =>
    typeof r === 'object' && r !== null
    && ok((r as Record<string, unknown>).a) && ok((r as Record<string, unknown>).b);
  const boolOk = (v: unknown) => typeof v === 'boolean';
  // Fee/score/time fields must be SAFE non-negative integers: a peer-written
  // fractional or astronomically large number would otherwise flow into chip
  // arithmetic and countdown math (the checkers guard F2 lesson).
  const countOk = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 0;
  return s.kind === 'airhockey'
    && sideRecord(s.players, playerOk)
    && sideRecord(s.ready, boolOk)
    && sideRecord(s.paid, countOk)
    && sideRecord(s.score, countOk)
    && (s.status === 'waiting' || s.status === 'playing' || s.status === 'ended')
    && (s.servingSide === 'a' || s.servingSide === 'b')
    && countOk(s.serveAt)
    && countOk(s.startedAt)
    && (s.winner === null || s.winner === 'a' || s.winner === 'b');
}

// ── Fee config (lives in the CASINO map, key `ah-fee:<tableId>`) ─────────────

/**
 * Owner-set pay-to-play config (#115 "optionally can enable a fee to start a
 * game / set by owner"). Stored beside the chip balances so fees "use the same
 * machine as casino chips" — casinoDoc.ts owns the reads/writes/transfers.
 */
export interface AirHockeyFeeConfig {
  enabled: boolean;
  /** Chips per player per match, 0..AH_MAX_FEE. */
  feeAmount: number;
  /** Room owner the fee is paid to; the owner plays their own table free. */
  ownerId: string;
}

/** Shape guard for peer-written fee configs (slots/roulette guard pattern). */
export function isAirHockeyFeeConfig(value: unknown): value is AirHockeyFeeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<AirHockeyFeeConfig>;
  return typeof c.enabled === 'boolean'
    && Number.isSafeInteger(c.feeAmount)
    && (c.feeAmount as number) >= 0 && (c.feeAmount as number) <= AH_MAX_FEE
    && typeof c.ownerId === 'string' && c.ownerId.length > 0 && c.ownerId.length <= 128;
}

// ── Fee escrow record (CASINO map, key `ah-paid:<tableId>:<playerId>`) ───────

/**
 * One player's escrowed entry fee for one table. Created by the PAYER (their
 * own balance debited in the same transaction), refunded by the payer while
 * 'held', promoted to 'final' by the payer when they observe the match start,
 * and swept (credited + deleted) by the recorded owner once 'final'. Every
 * lifecycle phase has exactly ONE writer, so per-key LWW can neither mint nor
 * destroy chips — see casinoDoc.ts for the money moves.
 */
export interface AirHockeyPaidRecord {
  /** Chips debited from the payer at creation — the refund/sweep amount. */
  amount: number;
  /** Fee recipient captured at pay time (the validated config's ownerId). */
  ownerId: string;
  /** 'held' = refundable by the payer; 'final' = sweepable by the owner. */
  state: 'held' | 'final';
}

/** Shape guard for peer-written escrow records. The AH_MAX_FEE cap bounds
 *  what a forged record could ever move in a sweep (hostile peers sit outside
 *  the casino map's trust model, but a bound costs nothing). */
export function isAirHockeyPaidRecord(value: unknown): value is AirHockeyPaidRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<AirHockeyPaidRecord>;
  return Number.isSafeInteger(r.amount)
    && (r.amount as number) > 0 && (r.amount as number) <= AH_MAX_FEE
    && typeof r.ownerId === 'string' && r.ownerId.length > 0 && r.ownerId.length <= 128
    && (r.state === 'held' || r.state === 'final');
}

/** What the PAYER should do with their own escrow record right now. */
export type AirHockeyEscrowAction = 'none' | 'refund' | 'finalize';

/**
 * Pure reconciler predicate: given MY record and the table's current state,
 * decide the payer-side action. Run on the start transition and on a slow
 * timer (airHockeySession), it self-heals every orphan a crash, reset, kick,
 * or table removal can strand — without ever touching another player's keys.
 *
 * Arms, in precedence order:
 *  - 'final' records are the OWNER's business (sweep) — the payer never
 *    touches them again ("fees become final once the match starts");
 *  - no table state → the table was cleared/removed pre-start → refund;
 *  - not seated → reset/kick/release happened → refund;
 *  - startedAt stamped while seated → the match ran (playing OR already
 *    ended) → finalize (covers a crash between start and the normal
 *    finalize hook);
 *  - seated + ready, not started → the legitimate waiting escrow → none;
 *  - seated, NOT ready → the pay landed but the ready write never did
 *    (crash between the two) → refund.
 *
 * Ties break toward the PLAYER: a stale 'held' record refunds rather than
 * finalizes whenever the state cannot prove the match ran.
 */
export function airHockeyEscrowAction(
  record: AirHockeyPaidRecord,
  s: AirHockeyState | null,
  playerId: string,
): AirHockeyEscrowAction {
  if (record.state === 'final') return 'none';
  if (!s) return 'refund';
  const side = s.players.a === playerId ? 'a' : s.players.b === playerId ? 'b' : null;
  if (side === null) return 'refund';
  if (s.startedAt > 0) return 'finalize';
  if (s.ready[side]) return 'none';
  return 'refund';
}

// ── Doc-state transitions (pure — callers wrap in read → here → write) ───────

/** Claim an open side pre-game. Returns the new state, or null (no-op). */
export function claimSide(
  s: AirHockeyState,
  side: AirHockeySide,
  playerId: string,
): AirHockeyState | null {
  if (s.status !== 'waiting') return null;
  if (s.players[side] !== null && s.players[side] !== playerId) return null;
  if (s.players[otherSide(side)] === playerId) return null; // one side each
  if (s.players[side] === playerId) return null;            // already mine
  return { ...s, players: { ...s.players, [side]: playerId } };
}

/** Release a side pre-game (walk-away/un-claim); ready + paid reset with it. */
export function releaseSide(
  s: AirHockeyState,
  side: AirHockeySide,
  playerId: string,
): AirHockeyState | null {
  if (s.status !== 'waiting' || s.players[side] !== playerId) return null;
  return {
    ...s,
    players: { ...s.players, [side]: null },
    ready: { ...s.ready, [side]: false },
    paid: { ...s.paid, [side]: 0 },
  };
}

/** Mark a claimed side ready, recording the fee it paid (0 = free). */
export function setReady(
  s: AirHockeyState,
  side: AirHockeySide,
  playerId: string,
  paidAmount: number,
): AirHockeyState | null {
  if (s.status !== 'waiting' || s.players[side] !== playerId) return null;
  if (s.ready[side]) return null;
  if (!Number.isSafeInteger(paidAmount) || paidAmount < 0) return null;
  return {
    ...s,
    ready: { ...s.ready, [side]: true },
    paid: { ...s.paid, [side]: paidAmount },
  };
}

/** Un-ready a side pre-start. The caller refunds the player's escrow record
 *  after the write (casinoDoc.refundAirHockeyFee — self-credit, refused
 *  only by its MAX_SAFE_INTEGER overflow guard, which keeps the record for
 *  a later retry); `paid` here is display/guard state only. */
export function setUnready(
  s: AirHockeyState,
  side: AirHockeySide,
  playerId: string,
): AirHockeyState | null {
  if (s.status !== 'waiting' || s.players[side] !== playerId) return null;
  if (!s.ready[side]) return null;
  return {
    ...s,
    ready: { ...s.ready, [side]: false },
    paid: { ...s.paid, [side]: 0 },
  };
}

/** Both sides ready → the match begins. Idempotent-safe on the LWW ready
 *  race: both clients compute the same transition, identical writes converge. */
export function startIfReady(s: AirHockeyState, now: number): AirHockeyState | null {
  if (s.status !== 'waiting' || !s.ready.a || !s.ready.b) return null;
  if (!s.players.a || !s.players.b) return null;
  return {
    ...s,
    status: 'playing',
    score: { a: 0, b: 0 },
    servingSide: 'a',
    serveAt: now + AH_SERVE_DELAY_MS,
    startedAt: now,
    winner: null,
  };
}

/** Solo practice: one claimant free-plays (no win condition, fee still due). */
export function startPractice(
  s: AirHockeyState,
  side: AirHockeySide,
  playerId: string,
  paidAmount: number,
  now: number,
): AirHockeyState | null {
  if (s.status !== 'waiting' || s.players[side] !== playerId) return null;
  if (s.players[otherSide(side)] !== null) return null; // versus takes priority
  if (!Number.isSafeInteger(paidAmount) || paidAmount < 0) return null;
  return {
    ...s,
    ready: { ...s.ready, [side]: true },
    paid: { ...s.paid, [side]: paidAmount },
    status: 'playing',
    score: { a: 0, b: 0 },
    servingSide: side,
    serveAt: now + AH_SERVE_DELAY_MS,
    startedAt: now,
    winner: null,
  };
}

/** True when this is a versus match (both sides claimed) — practice has no
 *  win condition and serves from the table centre. */
export function isVersus(s: AirHockeyState): boolean {
  return s.players.a !== null && s.players.b !== null;
}

/** A goal against `scoredOn`: score, win check, schedule the next serve to
 *  the scored-on side (standard air hockey possession rule). */
export function withGoal(
  s: AirHockeyState,
  scoredOn: AirHockeySide,
  now: number,
): AirHockeyState | null {
  if (s.status !== 'playing') return null;
  const scorer = otherSide(scoredOn);
  const score = { ...s.score, [scorer]: s.score[scorer] + 1 };
  const won = isVersus(s) && score[scorer] >= AH_GOALS_TO_WIN;
  return {
    ...s,
    score,
    status: won ? 'ended' : 'playing',
    winner: won ? scorer : null,
    servingSide: scoredOn,
    serveAt: won ? 0 : now + AH_GOAL_PAUSE_MS,
  };
}

/** Mid-match walkover: `winner` takes the match (opponent left/forfeited). */
export function withForfeit(
  s: AirHockeyState,
  winner: AirHockeySide,
): AirHockeyState | null {
  if (s.status !== 'playing' || !isVersus(s)) return null;
  return { ...s, status: 'ended', winner, serveAt: 0 };
}

// ── Physics (operator-only; LOCAL table frame) ───────────────────────────────

/** Transient puck sim — never doc-synced; broadcast via puck ticks. */
export interface PuckSim {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** One mallet as the sim sees it this frame (already in local frame). */
export interface MalletInput {
  x: number;
  z: number;
  /** Velocity estimate (m/s) — transferred into the puck on contact. */
  vx: number;
  vz: number;
  /** Issue #115: holding the mouse places the mallet DOWN on the table;
   *  a lifted mallet neither blocks nor strikes the puck. */
  down: boolean;
}

/** Clamp a mallet centre to its own half, fully inside the rails. */
export function clampMallet(
  side: AirHockeySide,
  x: number,
  z: number,
): { x: number; z: number } {
  const cx = Math.max(-(AH_HALF_W - AH_MALLET_R), Math.min(AH_HALF_W - AH_MALLET_R, x));
  const zNear = AH_HALF_L - AH_MALLET_R; // own back rail
  const cz = side === 'a'
    ? Math.max(-zNear, Math.min(-AH_MALLET_R, z)) // may not cross centre line
    : Math.max(AH_MALLET_R, Math.min(zNear, z));
  return { x: cx, z: cz };
}

/** Serve spot: centre of the receiving side's half (table centre in practice). */
export function servePosition(s: AirHockeyState): { x: number; z: number } {
  if (!isVersus(s)) return { x: 0, z: 0 };
  return { x: 0, z: s.servingSide === 'a' ? -AH_HALF_L / 2 : AH_HALF_L / 2 };
}

/** True when the puck centre is inside a goal-mouth band (no end rail there). */
function inGoalMouth(x: number): boolean {
  return Math.abs(x) < AH_GOAL_HALF_W;
}

/**
 * Advance the puck by `dt` seconds against the given mallets, mutating `sim`.
 * Returns the side whose goal was breached ('a' = −z goal), or null.
 * On a goal the puck is left where it crossed; the caller re-serves.
 */
export function stepPuck(
  sim: PuckSim,
  mallets: MalletInput[],
  dt: number,
): AirHockeySide | null {
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(0, dt) / SIM_DT)));
  const h = Math.max(0, dt) / steps;
  const decay = Math.exp(-FRICTION_RATE * h);
  for (let i = 0; i < steps; i++) {
    sim.x += sim.vx * h;
    sim.z += sim.vz * h;
    sim.vx *= decay;
    sim.vz *= decay;

    // Side rails (x) — always solid.
    const xMax = AH_HALF_W - AH_PUCK_R;
    if (sim.x > xMax) { sim.x = xMax; sim.vx = -Math.abs(sim.vx) * WALL_RESTITUTION; }
    else if (sim.x < -xMax) { sim.x = -xMax; sim.vx = Math.abs(sim.vx) * WALL_RESTITUTION; }

    // End rails (z) — solid outside the goal mouth; inside it the puck sails
    // on and scores once FULLY past the goal line. The test is inclusive with
    // GOAL_LINE_EPS slack: a back-rail-clamped mallet ejects an overlapped
    // puck to ±(AH_HALF_L + AH_PUCK_R) up to rounding, and that push must
    // count — a strict exact test let it settle dead on the line until the
    // stuck-puck watchdog re-served.
    const zMax = AH_HALF_L - AH_PUCK_R;
    if (sim.z > zMax) {
      if (!inGoalMouth(sim.x)) {
        sim.z = zMax;
        sim.vz = -Math.abs(sim.vz) * WALL_RESTITUTION;
      } else if (sim.z >= AH_HALF_L + AH_PUCK_R - GOAL_LINE_EPS) {
        return 'b';
      }
    } else if (sim.z < -zMax) {
      if (!inGoalMouth(sim.x)) {
        sim.z = -zMax;
        sim.vz = Math.abs(sim.vz) * WALL_RESTITUTION;
      } else if (sim.z <= -(AH_HALF_L + AH_PUCK_R - GOAL_LINE_EPS)) {
        return 'a';
      }
    }

    // Mallet contacts — circle vs circle, resolved by pushing the puck out
    // along the contact normal and reflecting the relative approach velocity.
    // Substeps are short enough that discrete overlap checks cannot tunnel
    // at the capped speeds (max closing ≈12 m/s × 1/240 s ≈ 5 cm < radii sum).
    for (const m of mallets) {
      if (!m.down) continue;
      const dx = sim.x - m.x;
      const dz = sim.z - m.z;
      const minDist = AH_PUCK_R + AH_MALLET_R;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;
      const dist = Math.sqrt(distSq);
      // Coincident centres (dist 0) would yield a NaN normal — eject along +z
      // toward the table centre-agnostic axis instead.
      const nx = dist > 1e-6 ? dx / dist : 0;
      const nz = dist > 1e-6 ? dz / dist : 1;
      sim.x = m.x + nx * minDist;
      sim.z = m.z + nz * minDist;
      // A rail-clamped mallet plus the full radii-sum push can eject the
      // centre past a rail line for one substep. Contain it here: side rails
      // are always solid; the end line is solid only outside the goal mouth
      // (inside it any overshoot belongs to the goal test above — a fully
      // crossed puck must score, not snap back). Position hygiene only: the
      // rail branches keep owning velocity reflection.
      const ejectXMax = AH_HALF_W - AH_PUCK_R;
      if (sim.x > ejectXMax) sim.x = ejectXMax;
      else if (sim.x < -ejectXMax) sim.x = -ejectXMax;
      if (!inGoalMouth(sim.x)) {
        const ejectZMax = AH_HALF_L - AH_PUCK_R;
        if (sim.z > ejectZMax) sim.z = ejectZMax;
        else if (sim.z < -ejectZMax) sim.z = -ejectZMax;
      }
      const relVn = (sim.vx - m.vx) * nx + (sim.vz - m.vz) * nz;
      if (relVn < 0) {
        // Reflecting the RELATIVE approach velocity is the whole strike model:
        // a stationary puck hit at v·n leaves at ≈(1+e)·v·n, so the mallet's
        // motion transfers with no separate impulse term (one would double-
        // count). Tangential slip is free — it's an air table.
        sim.vx -= (1 + MALLET_RESTITUTION) * relVn * nx;
        sim.vz -= (1 + MALLET_RESTITUTION) * relVn * nz;
      }
      const speed = Math.hypot(sim.vx, sim.vz);
      if (speed > AH_PUCK_MAX_SPEED) {
        const k = AH_PUCK_MAX_SPEED / speed;
        sim.vx *= k;
        sim.vz *= k;
      }
    }

    // Global cap (rail math cannot exceed it, but mallet stacking could).
    const speed = Math.hypot(sim.vx, sim.vz);
    if (speed > AH_PUCK_MAX_SPEED) {
      const k = AH_PUCK_MAX_SPEED / speed;
      sim.vx *= k;
      sim.vz *= k;
    }
  }
  return null;
}

// ── Tick codec (13-byte lane — see network/protocol.ts kind bits) ────────────

/** Quantized speed range: 5 bits (0–31) across 0..AH_PUCK_MAX_SPEED. */
const SPEED_QUANT_MAX = 31;
/** Puck-tick flag bit 5: puck live on the table (0 = held for a serve). */
const PUCK_ACTIVE_BIT = 32;

export interface AirHockeyMalletTick {
  /** World-space mallet position (see module header). */
  x: number;
  z: number;
  down: boolean;
  seq: number;
}

export interface AirHockeyPuckTick {
  /** World-space puck position. */
  x: number;
  z: number;
  /** Velocity as heading (radians) + speed (m/s) for extrapolation. */
  heading: number;
  speed: number;
  /** False while the puck is held for a serve countdown. */
  active: boolean;
  seq: number;
}

/** Mallet → MovementTick (bit0 = down; yaw unused). */
export function malletToTick(t: AirHockeyMalletTick): MovementTick {
  return {
    flags: packTickKind(TICK_KIND_AH_MALLET) | (t.down ? 1 : 0),
    x: t.x,
    z: t.z,
    yaw: 0,
    seq: t.seq & 0xffff,
  };
}

export function malletFromTick(t: MovementTick): AirHockeyMalletTick {
  return { x: t.x, z: t.z, down: (t.flags & 1) === 1, seq: t.seq };
}

/** Puck → MovementTick (bits0–4 speed, bit5 active; yaw = heading). */
export function puckToTick(t: AirHockeyPuckTick): MovementTick {
  const q = Math.max(0, Math.min(SPEED_QUANT_MAX,
    Math.round((t.speed / AH_PUCK_MAX_SPEED) * SPEED_QUANT_MAX)));
  return {
    flags: packTickKind(TICK_KIND_AH_PUCK) | (t.active ? PUCK_ACTIVE_BIT : 0) | q,
    x: t.x,
    z: t.z,
    yaw: ((t.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    seq: t.seq & 0xffff,
  };
}

export function puckFromTick(t: MovementTick): AirHockeyPuckTick {
  const q = t.flags & SPEED_QUANT_MAX;
  return {
    x: t.x,
    z: t.z,
    heading: t.yaw,
    speed: (q / SPEED_QUANT_MAX) * AH_PUCK_MAX_SPEED,
    active: (t.flags & PUCK_ACTIVE_BIT) !== 0,
    seq: t.seq,
  };
}
