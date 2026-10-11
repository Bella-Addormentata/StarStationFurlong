/**
 * Insatiable Alligators engine — issue #185 (2–8 player round table).
 *
 * Pure functions over plain-JSON state: no DOM, no THREE, no Yjs — the same
 * layering contract as airHockey.ts (whose mechanics this game is built on).
 * Three concerns live here so they are unit-testable in isolation
 * (alligators.test.ts):
 *
 *  1. THE DOC STATE (AlligatorsState) — seat claims/ready/lifecycle and which
 *     alligator ate which ball, stored whole-value in the room doc's `games`
 *     map keyed by the table's furniture item id (games/gamesDoc.ts). Every
 *     transition is read → pure helper here → transacted write, LWW per key.
 *     Ball positions and head poses are deliberately NOT in the doc: per-frame
 *     state never belongs in a CRDT (STUDY-Architecture §8.1) — they ride the
 *     datagram tick lane below. What a bite ATE is an outcome, so it is a doc
 *     write (by the operator, the one page that runs the balls).
 *
 *  2. THE PHYSICS (stepBalls) and HEAD GEOMETRY — fixed-substep 2D circle sim
 *     in the table's LOCAL frame (x/z, centre at the origin). Balls roll on a
 *     gently domed round table, bounce off the rim, each other and the heads'
 *     base housings, and get dragged round when the table spins. Heads swing
 *     about a pivot on the rim, lunge forward along their swing, and block
 *     each other (resolveHeadPose).
 *
 *  3. THE TICK CODEC — head and ball datagrams reuse the 13-byte MovementTick
 *     wire format as lane kind 3 (network/protocol.ts), with flags bit 5
 *     telling a head (0) from a ball (1). The node relays any 13-byte datagram
 *     verbatim, so no Rust changes. Coordinates on the wire are WORLD-space so
 *     receivers route a tick to its table by containment (the #115 rule).
 */

import type { MovementTick } from '../network/protocol';
import { TICK_KIND_ALLIGATORS, packTickKind } from '../network/protocol';

// ── Table geometry (LOCAL frame, rot 0 — shared with the furniture builder) ──
// Footprint is 3×3 m; a round playfield of radius 1 m inside a rim, eight
// head pivots on the rim, a bird on a counter display between each pair.

/** Playing-surface height above the floor (m) — air hockey's height. */
export const IA_SURFACE_Y = 0.8;
/** Playfield radius inside the rim (m). */
export const IA_TABLE_R = 1.0;
/** Seats (head positions) round the table — the issue's 8-player maximum. */
export const IA_SEATS = 8;
/** Fewest claimed seats for a versus round (solo is PRACTICE). */
export const IA_MIN_PLAYERS = 2;
/** Balls per player in a round (issue #185: "10 balls per player"). */
export const IA_BALLS_PER_PLAYER = 10;
/** Most balls a round can hold (8 × 10) — also the tick codec's index range. */
export const IA_MAX_BALLS = IA_SEATS * IA_BALLS_PER_PLAYER;
/** Ball radius (m). */
export const IA_BALL_R = 0.045;
/** Head pivot distance from the centre — ON the rim line. */
export const IA_PIVOT_R = IA_TABLE_R;
/** Radius of each head's base housing (the little hands): a solid bumper
 *  round the pivot, so a ball can never wedge under a neck out of reach. */
export const IA_BASE_R = 0.24;
/** Pivot → mouth-centre distance at rest (m). */
export const IA_HEAD_LEN = 0.44;
/** Radius of the mouth's footprint: a ball whose centre lies inside it when
 *  the jaw comes down is eaten. */
export const IA_MOUTH_R = 0.13;
/** Extra reach of a full lunge (m). */
export const IA_LUNGE = 0.22;
/** Furthest a head swings either way from pointing at the centre (rad). */
export const IA_SWING_MAX = 1.0;
/** Snout half-width for head-vs-head blocking (capsule radius, m). */
export const IA_HEAD_HALF_W = 0.1;
/** Where the snout capsule starts, out from the pivot (m) — the neck behind
 *  it sits over the base housing and never meets a neighbour. */
const HEAD_NECK = 0.16;

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Hard ball speed cap (m/s) — also the tick codec's quantization range. */
export const IA_BALL_MAX_SPEED = 3.0;
/** Exponential speed-decay rate (s⁻¹) — balls roll, they don't float. */
const FRICTION_RATE = 0.9;
/** Outward acceleration per metre from the centre (s⁻²): the table is a
 *  shallow dome, so no ball can park at the dead centre, out of every reach. */
const DOME_K = 0.45;
/** A ball this still, this near the centre, is nudged off it (m, m/s). */
const CENTRE_EPS = 1e-3;
/** …to this offset (m), from which the dome carries it out in seconds. */
const CENTRE_NUDGE = 0.01;
/** Rim / base-housing bounce energy retention. */
const WALL_RESTITUTION = 0.75;
/** Ball-on-ball bounce. */
const BALL_RESTITUTION = 0.9;
/** How hard a spinning table drags a ball toward its surface speed (s⁻¹). */
const SPIN_GRIP = 3.5;
/** Fixed physics substep (s): 3 m/s × 1/180 ≈ 1.7 cm < ball radius. */
const SIM_DT = 1 / 180;
/** Substep cap per frame — a background-tab dt spike must not spiral. */
const MAX_SUBSTEPS = 45;

/** Issue #185: "The table will spin briefly every 10 seconds." */
export const IA_SPIN_EVERY_MS = 10000;
/** How long one spin lasts (ms). */
export const IA_SPIN_MS = 1500;
/** Peak spin rate (rad/s); successive spins alternate direction. */
export const IA_SPIN_PEAK = 2.4;
/** First egg is laid this long after the round starts (ms). */
export const IA_LAY_START_MS = 1500;
/** Each bird lays its next egg this long after its last (ms). */
export const IA_LAY_WAVE_MS = 450;
/** Birds within a wave lay a beat apart, round the table (ms). */
const LAY_STAGGER_MS = 40;

/** Each seat's accent colour (display digits, HUD chips, head collar) and
 *  its name — the builder and the HUD read the same table. */
export const IA_SEAT_COLORS: readonly number[] = [
  0x35c8e8, 0xe8933a, 0x8be04a, 0xe84a9a, 0xf0d040, 0xa070f0, 0x4ae0b0, 0xf06050,
];
export const IA_SEAT_NAMES: readonly string[] = [
  'CYAN', 'ORANGE', 'LIME', 'PINK', 'GOLD', 'VIOLET', 'MINT', 'CORAL',
];

// ── Seat geometry ────────────────────────────────────────────────────────────

/** Outward angle of seat i, measured atan2(z, x): seat 0 sits at local −z
 *  (air hockey's side-'a' end), the rest follow every 45°. */
export function seatAngle(seat: number): number {
  return -Math.PI / 2 + seat * (2 * Math.PI / IA_SEATS);
}

/** Bird j sits between seat j and seat j+1, on top of seat j's display. */
export function birdAngle(bird: number): number {
  return seatAngle(bird) + Math.PI / IA_SEATS;
}

/** Seat i's head pivot on the rim (LOCAL). */
export function pivotOf(seat: number): { x: number; z: number } {
  const a = seatAngle(seat);
  return { x: Math.cos(a) * IA_PIVOT_R, z: Math.sin(a) * IA_PIVOT_R };
}

/** A head's pose: swing (rad, + toward the seated player's screen-right) and
 *  lunge extension (m, 0 at rest). */
export interface HeadPose {
  swing: number;
  ext: number;
}

/** Unit vector a head points along at `swing`. Inward f = −outward; the
 *  seated player's screen-right is r = (−f.z, f.x) (the camera looks along f,
 *  right = f × up) — so +swing turns the snout toward screen-right. */
export function headDir(seat: number, swing: number): { x: number; z: number } {
  const a = seatAngle(seat);
  const fx = -Math.cos(a);
  const fz = -Math.sin(a);
  const rx = -fz;
  const rz = fx;
  const c = Math.cos(swing);
  const s = Math.sin(swing);
  return { x: c * fx + s * rx, z: c * fz + s * rz };
}

/** Mouth-centre position (LOCAL) for a seat's pose. */
export function mouthOf(seat: number, pose: HeadPose): { x: number; z: number } {
  const p = pivotOf(seat);
  const d = headDir(seat, pose.swing);
  const len = IA_HEAD_LEN + pose.ext;
  return { x: p.x + d.x * len, z: p.z + d.z * len };
}

/** Inverse of mouthOf: the pose whose mouth sits at (x, z), clamped to the
 *  head's legal range (a peer's tick can carry any point). */
export function poseFromMouth(seat: number, x: number, z: number): HeadPose {
  const p = pivotOf(seat);
  const dx = x - p.x;
  const dz = z - p.z;
  const a = seatAngle(seat);
  const fx = -Math.cos(a);
  const fz = -Math.sin(a);
  // Components along f and r (r = (−fz, fx)).
  const along = dx * fx + dz * fz;
  const across = dx * -fz + dz * fx;
  return clampPose({
    swing: Math.atan2(across, along),
    ext: Math.hypot(dx, dz) - IA_HEAD_LEN,
  });
}

/** Clamp a pose to the swing and lunge limits. */
export function clampPose(pose: HeadPose): HeadPose {
  const swing = Number.isFinite(pose.swing) ? pose.swing : 0;
  const ext = Number.isFinite(pose.ext) ? pose.ext : 0;
  return {
    swing: Math.max(-IA_SWING_MAX, Math.min(IA_SWING_MAX, swing)),
    ext: Math.max(0, Math.min(IA_LUNGE, ext)),
  };
}

/** Closest distance between segments p1–q1 and p2–q2 (2D). */
function segmentDistance(
  p1x: number, p1z: number, q1x: number, q1z: number,
  p2x: number, p2z: number, q2x: number, q2z: number,
): number {
  const d1x = q1x - p1x; const d1z = q1z - p1z;
  const d2x = q2x - p2x; const d2z = q2z - p2z;
  const rx = p1x - p2x; const rz = p1z - p2z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) return Math.hypot(rx, rz);
  if (a <= 1e-12) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-12) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const cx = p1x + d1x * s - (p2x + d2x * t);
  const cz = p1z + d1z * s - (p2z + d2z * t);
  return Math.hypot(cx, cz);
}

/** The snout capsule's spine (LOCAL): from the neck to the mouth centre. */
function snoutSegment(seat: number, pose: HeadPose): [number, number, number, number] {
  const p = pivotOf(seat);
  const d = headDir(seat, pose.swing);
  const len = IA_HEAD_LEN + pose.ext;
  return [p.x + d.x * HEAD_NECK, p.z + d.z * HEAD_NECK, p.x + d.x * len, p.z + d.z * len];
}

/** Gap between two heads' snouts (m) — negative when they overlap. */
export function headGap(seatA: number, a: HeadPose, seatB: number, b: HeadPose): number {
  const [ax, az, bx, bz] = snoutSegment(seatA, a);
  const [cx, cz, dx, dz] = snoutSegment(seatB, b);
  return segmentDistance(ax, az, bx, bz, cx, cz, dx, dz) - 2 * IA_HEAD_HALF_W;
}

/** Another head on the table, as this page last saw it. */
export interface OtherHead {
  seat: number;
  pose: HeadPose;
}

function clearance(seat: number, pose: HeadPose, others: OtherHead[]): number {
  let min = Infinity;
  for (const o of others) {
    if (o.seat === seat) continue;
    min = Math.min(min, headGap(seat, pose, o.seat, o.pose));
  }
  return min;
}

/**
 * Move a head from `from` toward `to`, stopping where it meets another head
 * (issue #185: "the alligator heads will collide and can't overlap or move
 * further until the other player moves away"). A head that already overlaps
 * one (the other moved into it) may still move in any way that doesn't close
 * the gap further — so two locked heads always come apart.
 */
export function resolveHeadPose(
  seat: number,
  from: HeadPose,
  to: HeadPose,
  others: OtherHead[],
): HeadPose {
  const target = clampPose(to);
  const start = clampPose(from);
  const cTo = clearance(seat, target, others);
  if (cTo >= 0) return target;
  const cFrom = clearance(seat, start, others);
  if (cFrom < 0) return cTo >= cFrom ? target : start;
  // Binary search the last free point on the straight line from → to.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = {
      swing: start.swing + (target.swing - start.swing) * mid,
      ext: start.ext + (target.ext - start.ext) * mid,
    };
    if (clearance(seat, p, others) >= 0) lo = mid;
    else hi = mid;
  }
  return {
    swing: start.swing + (target.swing - start.swing) * lo,
    ext: start.ext + (target.ext - start.ext) * lo,
  };
}

// ── Bite timeline (shared by the session and the in-world head) ──────────────

/** Seconds from the click until the jaw lands on the table (the bite). */
export const IA_BITE_LAND_S = 0.09;
/** Seconds from the click until the jaw starts to lift again. */
export const IA_BITE_HOLD_S = 0.22;
/** Seconds from the click until the next bite may start. */
export const IA_BITE_DONE_S = 0.38;

/** Jaw openness (1 open … 0 shut on the table) `t` seconds into a bite. */
export function biteJawOpen(t: number): number {
  if (t < 0 || t >= IA_BITE_DONE_S) return 1;
  if (t < IA_BITE_LAND_S) return 1 - t / IA_BITE_LAND_S;
  if (t < IA_BITE_HOLD_S) return 0;
  return (t - IA_BITE_HOLD_S) / (IA_BITE_DONE_S - IA_BITE_HOLD_S);
}

/** Lunge extension `t` seconds into a lunging bite (0 when not lunging). */
export function biteLungeExt(t: number): number {
  if (t < 0 || t >= IA_BITE_DONE_S) return 0;
  if (t < IA_BITE_LAND_S) return IA_LUNGE * (t / IA_BITE_LAND_S);
  if (t < IA_BITE_HOLD_S) return IA_LUNGE;
  return IA_LUNGE * (1 - (t - IA_BITE_HOLD_S) / (IA_BITE_DONE_S - IA_BITE_HOLD_S));
}

// ── Doc state ────────────────────────────────────────────────────────────────

export type AlligatorsStatus = 'waiting' | 'playing' | 'ended';

/** Ball not yet eaten (an `eaten` entry). */
export const IA_LIVE = -1;

/**
 * Doc-synced table state — plain JSON, whole-value LWW per table key.
 * `kind` discriminates it inside the shared `games` map (chess precedent).
 * Every per-seat array has exactly IA_SEATS entries.
 */
export interface AlligatorsState {
  kind: 'alligators';
  /** Seat claims — S2 player ids, claimed on walk-up. */
  players: (string | null)[];
  /** The page that plays each claimed seat (air hockey's seat rule: a player
   *  id is shared by every tab and device of that player, so only the page
   *  holding a seat drives its head). */
  seats: (string | null)[];
  /** Ready flags — every claimed seat ready (and ≥ 2 of them) starts a round. */
  ready: boolean[];
  status: AlligatorsStatus;
  /** Per ball of this round: IA_LIVE, or the seat whose alligator ate it.
   *  Its length is the round's ball count (10 per player); [] while waiting. */
  eaten: number[];
  /** Wall-clock ms the round started, 0 = not started. Laying and spinning
   *  are scheduled from it. */
  startedAt: number;
  /** Seats with the most balls once every ball is eaten (ties share it). */
  winners: number[];
}

const emptySeats = <T>(v: T): T[] => Array.from({ length: IA_SEATS }, () => v);

export function initialAlligatorsState(): AlligatorsState {
  return {
    kind: 'alligators',
    players: emptySeats<string | null>(null),
    seats: emptySeats<string | null>(null),
    ready: emptySeats(false),
    status: 'waiting',
    eaten: [],
    startedAt: 0,
    winners: [],
  };
}

/** True when a doc-read value has the AlligatorsState shape (defensive: any
 *  peer can write the `games` map; malformed entries render as "no game"). */
export function isAlligatorsState(value: unknown): value is AlligatorsState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<AlligatorsState>;
  const idOk = (p: unknown) =>
    p === null || (typeof p === 'string' && p.length > 0 && p.length <= 128);
  const seatArray = (r: unknown, ok: (v: unknown) => boolean) =>
    Array.isArray(r) && r.length === IA_SEATS && r.every(ok);
  const seatIdx = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < IA_SEATS;
  return s.kind === 'alligators'
    && seatArray(s.players, idOk)
    && seatArray(s.seats, idOk)
    && seatArray(s.ready, (v) => typeof v === 'boolean')
    && (s.status === 'waiting' || s.status === 'playing' || s.status === 'ended')
    && Array.isArray(s.eaten) && s.eaten.length <= IA_MAX_BALLS
    && s.eaten.every((v) => v === IA_LIVE || seatIdx(v))
    && Number.isSafeInteger(s.startedAt) && (s.startedAt as number) >= 0
    && Array.isArray(s.winners) && s.winners.length <= IA_SEATS && s.winners.every(seatIdx);
}

/** Claimed seat indices, in seat order. */
export function claimedSeats(s: AlligatorsState): number[] {
  const out: number[] = [];
  for (let i = 0; i < IA_SEATS; i++) if (s.players[i] !== null) out.push(i);
  return out;
}

/** The seat `playerId` holds, or −1. */
export function seatOfPlayer(s: AlligatorsState, playerId: string): number {
  return s.players.indexOf(playerId);
}

/** Balls each seat has eaten this round. */
export function scores(s: AlligatorsState): number[] {
  const out = emptySeats(0);
  for (const e of s.eaten) if (e !== IA_LIVE) out[e] += 1;
  return out;
}

/** A solo round (one claimed seat) — no winner, just eat them all. */
export function isPractice(s: AlligatorsState): boolean {
  return claimedSeats(s).length < IA_MIN_PLAYERS;
}

// ── Doc-state transitions (pure — callers wrap in read → here → write) ───────

const validSeat = (seat: number) => Number.isInteger(seat) && seat >= 0 && seat < IA_SEATS;

function withSeatValue<T>(arr: T[], seat: number, v: T): T[] {
  const out = arr.slice();
  out[seat] = v;
  return out;
}

/** Claim an open seat pre-round, played from `page` (the claiming page). */
export function claimSeat(
  s: AlligatorsState,
  seat: number,
  playerId: string,
  page: string,
): AlligatorsState | null {
  if (!validSeat(seat) || s.status !== 'waiting') return null;
  if (s.players[seat] !== null) return null;                // taken (or mine)
  if (seatOfPlayer(s, playerId) !== -1) return null;        // one seat each
  return {
    ...s,
    players: withSeatValue(s.players, seat, playerId),
    seats: withSeatValue(s.seats, seat, page),
    ready: withSeatValue(s.ready, seat, false),
  };
}

/** Play a seat its player already holds from `page` instead (PLAY HERE). */
export function takeSeat(
  s: AlligatorsState,
  seat: number,
  playerId: string,
  page: string,
): AlligatorsState | null {
  if (!validSeat(seat) || s.status === 'ended' || s.players[seat] !== playerId) return null;
  if (s.seats[seat] === page) return null;
  return { ...s, seats: withSeatValue(s.seats, seat, page) };
}

/** Release a seat pre-round (walk-away / LEAVE); its head folds away. */
export function releaseSeat(
  s: AlligatorsState,
  seat: number,
  playerId: string,
): AlligatorsState | null {
  if (!validSeat(seat) || s.status !== 'waiting' || s.players[seat] !== playerId) return null;
  return {
    ...s,
    players: withSeatValue(s.players, seat, null),
    seats: withSeatValue(s.seats, seat, null),
    ready: withSeatValue(s.ready, seat, false),
  };
}

export function setReady(
  s: AlligatorsState,
  seat: number,
  playerId: string,
  ready: boolean,
): AlligatorsState | null {
  if (!validSeat(seat) || s.status !== 'waiting' || s.players[seat] !== playerId) return null;
  if (s.ready[seat] === ready) return null;
  return { ...s, ready: withSeatValue(s.ready, seat, ready) };
}

function startRound(s: AlligatorsState, players: number, now: number): AlligatorsState {
  return {
    ...s,
    status: 'playing',
    eaten: Array.from({ length: players * IA_BALLS_PER_PLAYER }, () => IA_LIVE),
    startedAt: now,
    winners: [],
  };
}

/** Every claimed seat ready, and at least two of them → the round begins with
 *  10 balls per player. Idempotent-safe on the LWW race: every client
 *  computes the same transition (startedAt aside), and one write wins. */
export function startIfReady(s: AlligatorsState, now: number): AlligatorsState | null {
  if (s.status !== 'waiting') return null;
  const claimed = claimedSeats(s);
  if (claimed.length < IA_MIN_PLAYERS) return null;
  if (!claimed.every((i) => s.ready[i])) return null;
  return startRound(s, claimed.length, now);
}

/** Solo practice: the only claimant plays a 10-ball round on their own. */
export function startPractice(
  s: AlligatorsState,
  seat: number,
  playerId: string,
  now: number,
): AlligatorsState | null {
  if (!validSeat(seat) || s.status !== 'waiting' || s.players[seat] !== playerId) return null;
  if (claimedSeats(s).length !== 1) return null; // versus takes priority
  return startRound({ ...s, ready: withSeatValue(s.ready, seat, true) }, 1, now);
}

/** Seats holding the top count (empty while nobody ate anything). */
export function topSeats(s: AlligatorsState): number[] {
  const sc = scores(s);
  const best = Math.max(...sc);
  if (best <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < IA_SEATS; i++) if (sc[i] === best) out.push(i);
  return out;
}

/** `seat` ate `balls`: record them; the last ball eaten ends the round.
 *  Balls already eaten (a racing bite) and out-of-range indices are ignored;
 *  null when nothing changed. */
export function withBites(
  s: AlligatorsState,
  seat: number,
  balls: number[],
): AlligatorsState | null {
  if (!validSeat(seat) || s.status !== 'playing' || s.players[seat] === null) return null;
  const eaten = s.eaten.slice();
  let changed = false;
  for (const k of balls) {
    if (Number.isInteger(k) && k >= 0 && k < eaten.length && eaten[k] === IA_LIVE) {
      eaten[k] = seat;
      changed = true;
    }
  }
  if (!changed) return null;
  const next = { ...s, eaten };
  if (eaten.every((e) => e !== IA_LIVE)) {
    return { ...next, status: 'ended', winners: isPractice(next) ? [] : topSeats(next) };
  }
  return next;
}

/** PLAY AGAIN: an ended round goes back to waiting with every seat kept and
 *  nobody ready. */
export function nextRound(s: AlligatorsState): AlligatorsState | null {
  if (s.status !== 'ended') return null;
  return {
    ...s,
    status: 'waiting',
    ready: emptySeats(false),
    eaten: [],
    startedAt: 0,
    winners: [],
  };
}

// ── Round schedule (deterministic from the start — every client agrees) ──────

/** ms after the start when ball `k` is laid. */
export function layTimeMs(k: number): number {
  return IA_LAY_START_MS + Math.floor(k / IA_SEATS) * IA_LAY_WAVE_MS + (k % IA_SEATS) * LAY_STAGGER_MS;
}

/** The bird that lays ball `k`. */
export function birdOf(k: number): number {
  return k % IA_SEATS;
}

/** Deterministic [0, 1) hash — the per-ball jitter of a round. */
function hash01(k: number, salt: number): number {
  let h = (Math.imul(k + 1, 0x9e3779b1) ^ Math.imul((salt >>> 0) + 0x632be5ab, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** Where and how ball `k` pops out of its bird (LOCAL): just inside the rim
 *  below the bird, rolling inward with a little per-round jitter. */
export function eggSpawn(k: number, startedAt: number): BallSim {
  const a = birdAngle(birdOf(k));
  const r = IA_TABLE_R - IA_BALL_R - 0.02;
  const aim = a + Math.PI + (hash01(k, startedAt) - 0.5) * 0.7;
  const speed = 0.8 + hash01(k + 1000, startedAt) * 0.6;
  return {
    x: Math.cos(a) * r,
    z: Math.sin(a) * r,
    vx: Math.cos(aim) * speed,
    vz: Math.sin(aim) * speed,
  };
}

/** Table spin rate (rad/s) `t` ms into the round: a brief sine-shaped spin
 *  every IA_SPIN_EVERY_MS (not at the start), alternating direction. */
export function spinRate(t: number): number {
  if (t < IA_SPIN_EVERY_MS) return 0;
  const k = Math.floor(t / IA_SPIN_EVERY_MS);
  const u = (t - k * IA_SPIN_EVERY_MS) / IA_SPIN_MS;
  if (u >= 1) return 0;
  return (k % 2 === 1 ? 1 : -1) * IA_SPIN_PEAK * Math.sin(Math.PI * u);
}

/** The table top's turn (rad) `t` ms into the round — the integral of
 *  spinRate. Alternate spins cancel, so it never winds up. */
export function spinAngle(t: number): number {
  if (t < IA_SPIN_EVERY_MS) return 0;
  const k = Math.floor(t / IA_SPIN_EVERY_MS);
  const full = IA_SPIN_PEAK * (IA_SPIN_MS / 1000) * (2 / Math.PI);
  // Completed spins 1..k-1 alternate +,−,+…: an odd count leaves one +full.
  const done = (k - 1) % 2 === 1 ? full : 0;
  const u = Math.min(1, (t - k * IA_SPIN_EVERY_MS) / IA_SPIN_MS);
  const part = IA_SPIN_PEAK * (IA_SPIN_MS / 1000 / Math.PI) * (1 - Math.cos(Math.PI * u));
  return done + (k % 2 === 1 ? 1 : -1) * part;
}

// ── Physics (operator-only; LOCAL table frame) ───────────────────────────────

/** Transient ball sim — never doc-synced; broadcast via ball ticks. */
export interface BallSim {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

function capSpeed(b: BallSim): void {
  const sp = Math.hypot(b.vx, b.vz);
  if (sp > IA_BALL_MAX_SPEED) {
    const k = IA_BALL_MAX_SPEED / sp;
    b.vx *= k;
    b.vz *= k;
  }
}

/** Push a ball out of a circular obstacle (centre cx/cz, radius r) and
 *  reflect its approach — the base housings round each pivot. */
function bounceOffCircle(b: BallSim, cx: number, cz: number, r: number): void {
  const dx = b.x - cx;
  const dz = b.z - cz;
  const min = r + IA_BALL_R;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2);
  const nx = d > 1e-9 ? dx / d : -cx / (Math.hypot(cx, cz) || 1);
  const nz = d > 1e-9 ? dz / d : -cz / (Math.hypot(cx, cz) || 1);
  b.x = cx + nx * min;
  b.z = cz + nz * min;
  const vn = b.vx * nx + b.vz * nz;
  if (vn < 0) {
    b.vx -= (1 + WALL_RESTITUTION) * vn * nx;
    b.vz -= (1 + WALL_RESTITUTION) * vn * nz;
  }
}

/**
 * Advance every live ball by `dt` seconds, mutating them. `live[k]` false
 * skips ball k entirely (eaten, or not laid yet). `omega` is the table's spin
 * rate this frame (rad/s, spinRate) — a spinning surface drags balls round.
 */
export function stepBalls(
  balls: BallSim[],
  live: boolean[],
  dt: number,
  omega = 0,
): void {
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(0, dt) / SIM_DT)));
  const h = Math.max(0, dt) / steps;
  const decay = Math.exp(-FRICTION_RATE * h);
  const rimMax = IA_TABLE_R - IA_BALL_R;
  const pivots = Array.from({ length: IA_SEATS }, (_, i) => pivotOf(i));
  for (let step = 0; step < steps; step++) {
    for (let k = 0; k < balls.length; k++) {
      if (!live[k]) continue;
      const b = balls[k];
      // The dome's push is zero at the exact centre, out of every mouth's
      // reach: a ball resting there would never leave and the round could
      // not end. Nudge it off, always the same way, so every page agrees.
      if (Math.abs(b.x) < CENTRE_EPS && Math.abs(b.z) < CENTRE_EPS
        && Math.abs(b.vx) < CENTRE_EPS && Math.abs(b.vz) < CENTRE_EPS) {
        b.x = CENTRE_NUDGE;
      }
      // Dome: outward push proportional to the distance from the centre.
      let ax = DOME_K * b.x;
      let az = DOME_K * b.z;
      if (omega !== 0) {
        // Surface velocity ω × r — the felt drags the ball toward it.
        ax += SPIN_GRIP * (-omega * b.z - b.vx);
        az += SPIN_GRIP * (omega * b.x - b.vz);
      }
      b.vx = (b.vx + ax * h) * decay;
      b.vz = (b.vz + az * h) * decay;
      b.x += b.vx * h;
      b.z += b.vz * h;

      // Rim — a solid circle.
      const r = Math.hypot(b.x, b.z);
      if (r > rimMax) {
        const nx = b.x / r;
        const nz = b.z / r;
        b.x = nx * rimMax;
        b.z = nz * rimMax;
        const vn = b.vx * nx + b.vz * nz;
        if (vn > 0) {
          b.vx -= (1 + WALL_RESTITUTION) * vn * nx;
          b.vz -= (1 + WALL_RESTITUTION) * vn * nz;
        }
      }
      // Base housings round every pivot (stowed heads' housings too).
      for (const p of pivots) bounceOffCircle(b, p.x, p.z, IA_BASE_R);
    }

    // Ball-on-ball: equal masses, split the overlap, exchange the normal
    // approach velocity. Substeps keep overlaps tiny; O(n²) on ≤ 80 balls.
    const min = 2 * IA_BALL_R;
    for (let i = 0; i < balls.length; i++) {
      if (!live[i]) continue;
      const a = balls[i];
      for (let j = i + 1; j < balls.length; j++) {
        if (!live[j]) continue;
        const b = balls[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2);
        // Coincident centres (two eggs laid on one spot) part along x.
        const nx = d > 1e-9 ? dx / d : 1;
        const nz = d > 1e-9 ? dz / d : 0;
        const push = (min - d) / 2;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rel < 0) {
          const imp = ((1 + BALL_RESTITUTION) / 2) * rel;
          a.vx += imp * nx;
          a.vz += imp * nz;
          b.vx -= imp * nx;
          b.vz -= imp * nz;
        }
      }
    }
    for (let k = 0; k < balls.length; k++) if (live[k]) capSpeed(balls[k]);
  }
  // Position hygiene: a ball shoved by a neighbour after its rim test this
  // substep may sit a hair outside the rim — pull it back in.
  for (let k = 0; k < balls.length; k++) {
    if (!live[k]) continue;
    const b = balls[k];
    const r = Math.hypot(b.x, b.z);
    if (r > rimMax) {
      b.x *= rimMax / r;
      b.z *= rimMax / r;
    }
  }
}

/** Indices of the live balls under a mouth that just came down at (mx, mz). */
export function ballsUnderMouth(
  balls: BallSim[],
  live: boolean[],
  mx: number,
  mz: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k < balls.length; k++) {
    if (!live[k]) continue;
    if (Math.hypot(balls[k].x - mx, balls[k].z - mz) <= IA_MOUTH_R) out.push(k);
  }
  return out;
}

// ── Tick codec (13-byte lane kind 3 — see network/protocol.ts) ───────────────

/** Flags bit 5: 0 = head tick, 1 = ball tick. */
const BALL_BIT = 32;
/** Head tick flags bit 0: the jaw is down on the table (a bite landing). */
const JAW_BIT = 1;
/** Head tick flags bits 2–4: the seat. */
const SEAT_SHIFT = 2;
/** Ball tick: bits 0–4 quantized speed across 0..IA_BALL_MAX_SPEED. */
const SPEED_QUANT_MAX = 31;
/** Ball tick seq field: high 7 bits ball index, low 9 bits a per-ball
 *  wrapping counter (the field is u16; there is no other room for the index). */
const BALL_SEQ_BITS = 9;
export const IA_BALL_SEQ_MASK = (1 << BALL_SEQ_BITS) - 1;

/** Tick lane kind-3 subtype of a received tick. */
export function isBallTick(t: MovementTick): boolean {
  return (t.flags & BALL_BIT) !== 0;
}

export interface AlligatorHeadTick {
  /** World-space mouth centre (see module header). */
  x: number;
  z: number;
  seat: number;
  jawDown: boolean;
  seq: number;
}

export interface AlligatorBallTick {
  /** World-space ball centre. */
  x: number;
  z: number;
  heading: number;
  speed: number;
  index: number;
  /** Per-ball counter (IA_BALL_SEQ_MASK wide). */
  seq: number;
}

export function headToTick(t: AlligatorHeadTick): MovementTick {
  return {
    flags: packTickKind(TICK_KIND_ALLIGATORS)
      | (t.jawDown ? JAW_BIT : 0)
      | ((t.seat & 7) << SEAT_SHIFT),
    x: t.x,
    z: t.z,
    yaw: 0,
    seq: t.seq & 0xffff,
  };
}

export function headFromTick(t: MovementTick): AlligatorHeadTick {
  return {
    x: t.x,
    z: t.z,
    seat: (t.flags >> SEAT_SHIFT) & 7,
    jawDown: (t.flags & JAW_BIT) !== 0,
    seq: t.seq,
  };
}

export function ballToTick(t: AlligatorBallTick): MovementTick {
  const q = Math.max(0, Math.min(SPEED_QUANT_MAX,
    Math.round((t.speed / IA_BALL_MAX_SPEED) * SPEED_QUANT_MAX)));
  return {
    flags: packTickKind(TICK_KIND_ALLIGATORS) | BALL_BIT | q,
    x: t.x,
    z: t.z,
    yaw: ((t.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    seq: (((t.index & 0x7f) << BALL_SEQ_BITS) | (t.seq & IA_BALL_SEQ_MASK)) & 0xffff,
  };
}

export function ballFromTick(t: MovementTick): AlligatorBallTick {
  return {
    x: t.x,
    z: t.z,
    heading: t.yaw,
    speed: ((t.flags & SPEED_QUANT_MAX) / SPEED_QUANT_MAX) * IA_BALL_MAX_SPEED,
    index: (t.seq >> BALL_SEQ_BITS) & 0x7f,
    seq: t.seq & IA_BALL_SEQ_MASK,
  };
}
