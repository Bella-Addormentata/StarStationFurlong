/**
 * 🐊 Insatiable-alligators session (#185) — the LIVE layer between the pure
 * engine (games/alligators.ts) and everything it touches. It follows the
 * air-hockey session (airHockeySession.ts) piece for piece:
 *
 *  - the room doc (games/gamesDoc.ts `games` map): seat claims, ready state,
 *    the round's start and which alligator ate which ball — every transition
 *    is read → pure engine → transacted whole-value write;
 *  - the 13-byte tick lane, kind 3 (network/protocol.ts): head ticks at
 *    30 Hz (plus one the instant a jaw lands) and ball ticks under a shared
 *    budget, moving balls first. Positions travel in WORLD space, so ticks
 *    route to their table by containment;
 *  - the in-world table meshes (furniture.ts → AlligatorsVisualHandle): the
 *    SAME heads/balls/displays serve players and spectators — the DOM is
 *    only a HUD (standings, seat card, pointer-lock prompt).
 *
 * AUTHORITY MODEL (single operator, doc-recorded outcomes — air hockey's):
 *  - Exactly one page SIMULATES the balls: the engaged claimant of the
 *    lowest claimed seat whose head is live. A seat whose head ticks go
 *    silent for 1 s hands over to the next one up. Everyone else renders the
 *    balls from ball ticks.
 *  - A bite is a jaw LANDING: the biter's page sends a head tick with the jaw
 *    down, and the operator eats whatever lies under that mouth in its sim,
 *    writing the result to the doc (withBites). The operator's own bites go
 *    straight in. The doc is the only record that matters; ticks are cosmetic
 *    physics from untrusted peers, range-guarded and clamped on decode.
 *
 * ISSUE #185 CONTROLS: focusing the table walks to the nearest free seat and
 * enters its first-person view (world.ts 'alligators' branch). Clicking the
 * view grabs POINTER LOCK: moving the mouse side to side swings the head
 * about its pivot on the rim, a click bites, and pushing the mouse forward as
 * you click lunges for extra reach. Neighbouring heads block each other.
 * Esc once releases the pointer; Esc again steps back from the table.
 */

import {
  IA_BALL_MAX_SPEED, IA_BALL_R, IA_BALL_SEQ_MASK, IA_BITE_DONE_S, IA_BITE_HOLD_S,
  IA_BITE_LAND_S, IA_LAY_START_MS, IA_LIVE, IA_MAX_BALLS, IA_MIN_PLAYERS,
  IA_SEATS, IA_SEAT_COLORS, IA_SEAT_NAMES, IA_SPIN_EVERY_MS, IA_SPIN_MS,
  IA_TABLE_R, ballFromTick, ballToTick, ballsUnderMouth, biteJawOpen,
  biteLungeExt, birdOf, claimSeat, claimedSeats, clampPose, eggSpawn,
  headFromTick, headToTick, initialAlligatorsState, isBallTick, isPractice,
  layTimeMs, mouthOf, nextRound, poseFromMouth, releaseSeat, resolveHeadPose,
  scores, setReady, spinAngle, spinRate, startIfReady, startPractice,
  stepBalls, takeSeat, withBites,
} from './games/alligators';
import type {
  AlligatorsState, BallSim, HeadPose, OtherHead,
} from './games/alligators';
import {
  readAlligators, readPlayerDisplayName, readRoomOwner, subscribeGames,
  writeGame,
} from './games/gamesDoc';
import { casinoDocEpoch } from './casinoDoc';
import { escapeHtml } from './htmlEscape';
import { getPlayerId, PLAYER_NAME_MAX_LENGTH } from './identity';
import { packTick, tickKind, TICK_KIND_ALLIGATORS } from './network/protocol';
import type { MovementTick } from './network/protocol';
import { FURNITURE, rotXZ } from './furniture';
import type { Rot } from './furniture';
import type { AlligatorsVisualHandle, DeviceUI } from './devices';
import { activeRoomId } from './roomInventory';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Head broadcast rate — presence, pose and the jaw (a landing also sends one
 *  at once, so a bite never waits for the next slot). */
const HEAD_SEND_HZ = 30;
/** Ball ticks per second the operator may send in all (≈5 KB/s): 80 balls
 *  can't each go at puck rate, so the budget goes to the most overdue. */
const BALL_SEND_BUDGET_HZ = 240;
/** A rolling ball is re-sent this often; a resting one only this often. */
const BALL_MOVING_INTERVAL_S = 1 / 12;
const BALL_REST_INTERVAL_S = 0.75;
/** Below this speed (m/s) a ball counts as resting for the send schedule. */
const BALL_REST_SPEED = 0.04;
/** Radians of head swing per pixel of pointer-locked mouse movement. */
const SWING_SENS = 0.0032;
/** Forward mouse travel (px) that turns a click into a LUNGE, within
 *  LUNGE_WINDOW_MS before the click or before the jaw lands. */
const LUNGE_PUSH_PX = 26;
const LUNGE_WINDOW_MS = 180;
/** A remote head with no tick this long rests at its seat. */
const REMOTE_STALE_MS = 2000;
/** A remote ball with no tick this long is hidden (resting balls are re-sent
 *  only every BALL_REST_INTERVAL_S, so this is longer than a head's). */
const BALL_STALE_MS = 3000;
/** The next seat up runs the balls when the operator's head is silent this long. */
const OPERATOR_TAKEOVER_MS = 1000;
/** Exponential approach rates (1/s) smoothing ticks to 60 fps. */
const HEAD_DISPLAY_RATE = 22;
const BALL_DISPLAY_RATE = 18;
const JAW_DISPLAY_RATE = 30;
/** Furthest ahead a remote ball is dead-reckoned (covers a dropped tick). */
const BALL_EXTRAPOLATE_MAX_S = 0.25;

// ── Per-table runtime state ──────────────────────────────────────────────────

/** Where a furniture item sits — converts LOCAL table coords ⇄ WORLD ticks. */
interface TablePose {
  x: number;
  z: number;
  rot: Rot;
}

/** Latest remote head sample for one seat (LOCAL pose). */
interface RemoteHead {
  pose: HeadPose;
  /** Smoothed display pose. */
  disp: HeadPose;
  jawDown: boolean;
  /** Smoothed jaw openness (1 open … 0 shut). */
  jawDisp: number;
  seq: number;
  lastAt: number;
  sender: string;
}

/** Latest remote ball sample (non-operators), in LOCAL table coords. */
interface RemoteBall {
  x: number;
  z: number;
  vx: number;
  vz: number;
  dispX: number;
  dispZ: number;
  seq: number;
  lastAt: number;
  sender: string;
}

/** A jaw that landed, waiting for the operator to eat what's under it. */
interface PendingBite {
  seat: number;
  /** LOCAL mouth centre where the jaw came down. */
  x: number;
  z: number;
}

/** Local player's live input while focused at one seat. */
interface EngagedInput {
  seat: number;
  /** The head's pose this frame (after blocking). */
  pose: HeadPose;
  /** Where the mouse is steering the swing. */
  aim: number;
  /** Seconds into the current bite, or null between bites. */
  biteT: number | null;
  lunge: boolean;
  /** This bite's jaw has landed (its eat request is out). */
  landed: boolean;
  /** Recent forward mouse movement: [performance.now(), px] pairs. */
  pushes: Array<[number, number]>;
  /** Forward travel since the click (a lunge may follow the click). */
  pushSinceClick: number;
  /** Pointer lock currently held by this table's capture layer. */
  locked: boolean;
}

interface TableSession {
  handle: AlligatorsVisualHandle;
  pose: TablePose;
  /** The room doc this session began in (casinoDocEpoch). */
  docEpoch: number;
  remoteHeads: (RemoteHead | null)[];
  remoteBalls: (RemoteBall | null)[];
  pendingBites: PendingBite[];
  engaged: EngagedInput | null;
  /** Operator-only authoritative sim (LOCAL coords), one per ball. */
  balls: BallSim[];
  /** Operator-only: ball k is in the sim (laid, or adopted from ticks). */
  inSim: boolean[];
  /** Wall-clock ms this page last stepped its own sim (0 = never this round). */
  simAt: number;
  wasOperator: boolean;
  lastFrameAt: number;
  /** Wall-clock ms of the last head evidence per seat — operator election. */
  lastHeadAt: number[];
  /** startedAt last seen — a change is a fresh round: reset transient state. */
  seenStartedAt: number | null;
  /** The round's start as this page anchors it (roundClock). */
  startSeen: { startedAt: number; at: number } | null;
  /** Eggs whose laying this page has animated. */
  laidUpTo: number;
  headSendAccum: number;
  headSeq: number;
  lastSentJaw: boolean;
  ballSeq: number[];
  /** Wall-clock ms ball k was last sent (operator). */
  ballSentAt: number[];
  ballBudget: number;
}

const sessions = new Map<string, TableSession>();

/** This page's seat token (AlligatorsState.seats) — air hockey's PAGE_SEAT:
 *  only the page holding a seat drives its head. Fresh on every page load. */
const PAGE = mintPage();

function mintPage(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to the non-crypto shape */ }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** This page's token (tests and debugging). */
export function alligatorsPage(): string {
  return PAGE;
}

/** Does this page play `seat`? Its player holds the seat, from this page. */
function playsSeat(s: AlligatorsState, seat: number, myId: string): boolean {
  return s.players[seat] === myId && s.seats[seat] === PAGE;
}

/** Outbound datagram seam — main.ts wires NetworkProvider.sendTick here. */
let sendTickBuf: ((buf: Uint8Array) => void) | null = null;

export function setAlligatorsSender(fn: ((buf: Uint8Array) => void) | null): void {
  sendTickBuf = fn;
}

/** Register (or re-register after a rebuild) a built table's handle + pose. */
export function registerAlligatorsVisual(
  itemId: string,
  handle: AlligatorsVisualHandle,
  pose: TablePose,
): void {
  const existing = sessions.get(itemId);
  if (existing && existing.docEpoch === casinoDocEpoch()) {
    existing.handle = handle;
    existing.pose = pose;
    return;
  }
  sessions.set(itemId, freshSession(handle, pose));
}

/** The table's session in the room's current doc (air hockey's sessionFor:
 *  a session begun in another room's doc starts afresh on the same handle). */
function sessionFor(itemId: string): TableSession | null {
  const st = sessions.get(itemId);
  if (!st || st.docEpoch === casinoDocEpoch()) return st ?? null;
  const fresh = freshSession(st.handle, st.pose);
  sessions.set(itemId, fresh);
  return fresh;
}

function freshSession(handle: AlligatorsVisualHandle, pose: TablePose): TableSession {
  return {
    handle,
    pose,
    docEpoch: casinoDocEpoch(),
    remoteHeads: Array.from({ length: IA_SEATS }, () => null),
    remoteBalls: Array.from({ length: IA_MAX_BALLS }, () => null),
    pendingBites: [],
    engaged: null,
    balls: [],
    inSim: [],
    simAt: 0,
    wasOperator: false,
    lastFrameAt: 0,
    lastHeadAt: Array.from({ length: IA_SEATS }, () => 0),
    seenStartedAt: null,
    startSeen: null,
    laidUpTo: 0,
    headSendAccum: 0,
    headSeq: 0,
    lastSentJaw: false,
    ballSeq: Array.from({ length: IA_MAX_BALLS }, () => 0),
    ballSentAt: Array.from({ length: IA_MAX_BALLS }, () => 0),
    ballBudget: 0,
  };
}

/** Drop a removed table's runtime state (world.ts removeFurnitureVisuals). */
export function closeAlligatorsTable(itemId: string): void {
  sessions.delete(itemId);
}

// ── Coordinate conversion (LOCAL table frame ⇄ WORLD tick frame) ─────────────

function invRot(rot: Rot): Rot {
  return ((4 - rot) % 4) as Rot;
}

function localToWorld(pose: TablePose, x: number, z: number): { x: number; z: number } {
  const r = rotXZ(x, z, pose.rot);
  return { x: pose.x + r.x, z: pose.z + r.z };
}

function worldToLocal(pose: TablePose, x: number, z: number): { x: number; z: number } {
  return rotXZ(x - pose.x, z - pose.z, invRot(pose.rot));
}

// ── Round clock ──────────────────────────────────────────────────────────────

/**
 * ms into the round on THIS page's clock. `startedAt` is its writer's wall
 * clock, and devices' clocks aren't synchronised: a start written by a clock
 * running ahead would hold every egg and every spin. So the round is taken to
 * have started no later than when this page first saw it (air hockey's
 * servesAt rule). A start from a clock running behind just lays early.
 */
function roundClock(st: TableSession, s: AlligatorsState, now: number): number {
  if (s.startedAt <= 0) {
    st.startSeen = null;
    return 0;
  }
  if (st.startSeen?.startedAt !== s.startedAt) st.startSeen = { startedAt: s.startedAt, at: now };
  return Math.max(0, now - Math.min(s.startedAt, st.startSeen.at));
}

// ── Inbound tick routing (called from main.ts for every kind-3 tick) ─────────

function seqNewer(next: number, prev: number): boolean {
  const d = (next - prev) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** Serial arithmetic on a ball tick's 9-bit counter. */
function ballSeqNewer(next: number, prev: number): boolean {
  const d = (next - prev) & IA_BALL_SEQ_MASK;
  return d !== 0 && d < (IA_BALL_SEQ_MASK + 1) / 2;
}

/** The registered table under the world point (position IS the address). */
function tableAtWorld(x: number, z: number): { id: string; st: TableSession } | null {
  let best: { id: string; st: TableSession } | null = null;
  let bestD = Infinity;
  for (const id of sessions.keys()) {
    const st = sessionFor(id)!;
    const l = worldToLocal(st.pose, x, z);
    const d = Math.hypot(l.x, l.z);
    if (d > IA_TABLE_R + 0.6) continue;
    if (d < bestD) {
      bestD = d;
      best = { id, st };
    }
  }
  return best;
}

/**
 * Route one already-unpacked kind-3 tick from a peer. main.ts calls this
 * BEFORE its avatar bookkeeping, so game ticks never mint phantom avatars.
 */
export function routeAlligatorsTick(senderId: string, tick: MovementTick): void {
  if (tickKind(tick.flags) !== TICK_KIND_ALLIGATORS) return;
  if (!Number.isFinite(tick.x) || !Number.isFinite(tick.z)) return;
  const found = tableAtWorld(tick.x, tick.z);
  if (!found) return;
  const { id, st } = found;
  const now = Date.now();

  if (!isBallTick(tick)) {
    const h = headFromTick(tick);
    const seat = h.seat;
    // Self-echo guard: while I play a seat its head is MINE.
    if (st.engaged?.seat === seat) {
      const s = readAlligators(id);
      if (s && playsSeat(s, seat, getPlayerId())) return;
    }
    const prev = st.remoteHeads[seat];
    const fresh = !prev || prev.sender !== senderId || now - prev.lastAt > REMOTE_STALE_MS;
    if (!fresh && prev && !seqNewer(h.seq, prev.seq)) return; // stale/dup datagram
    const l = worldToLocal(st.pose, h.x, h.z);
    const pose = poseFromMouth(seat, l.x, l.z);
    // A jaw coming DOWN is a bite: queue it for the operator, at the mouth
    // the head actually holds (the clamped pose, not the raw point).
    if (h.jawDown && (fresh || !prev?.jawDown)) {
      const m = mouthOf(seat, pose);
      st.pendingBites.push({ seat, x: m.x, z: m.z });
    }
    st.remoteHeads[seat] = {
      pose,
      disp: fresh ? { ...pose } : prev!.disp,
      jawDown: h.jawDown,
      jawDisp: fresh ? (h.jawDown ? 0 : 1) : prev!.jawDisp,
      seq: h.seq,
      lastAt: now,
      sender: senderId,
    };
    st.lastHeadAt[seat] = now;
    return;
  }

  // Ball tick. While I'm the operator MY sim is truth (a page whose frames
  // have stopped isn't operating — air hockey's rule).
  if (st.wasOperator && now - st.lastFrameAt <= OPERATOR_TAKEOVER_MS) return;
  const b = ballFromTick(tick);
  if (b.index >= IA_MAX_BALLS) return;
  const l = worldToLocal(st.pose, b.x, b.z);
  const rimMax = IA_TABLE_R - IA_BALL_R;
  const r = Math.hypot(l.x, l.z);
  const k = r > rimMax ? rimMax / r : 1;
  const lx = l.x * k;
  const lz = l.z * k;
  const wv = rotXZ(Math.cos(b.heading) * b.speed, Math.sin(b.heading) * b.speed, invRot(st.pose.rot));
  const prev = st.remoteBalls[b.index];
  const fresh = !prev || prev.sender !== senderId || now - prev.lastAt > BALL_STALE_MS;
  if (!fresh && prev && !ballSeqNewer(b.seq, prev.seq)) return;
  st.remoteBalls[b.index] = {
    x: lx,
    z: lz,
    vx: wv.x,
    vz: wv.z,
    dispX: fresh ? lx : prev!.dispX,
    dispZ: fresh ? lz : prev!.dispZ,
    seq: b.seq,
    lastAt: now,
    sender: senderId,
  };
}

// ── Outbound sends ───────────────────────────────────────────────────────────

function jawDownOf(input: EngagedInput): boolean {
  return input.biteT !== null && input.biteT >= IA_BITE_LAND_S && input.biteT < IA_BITE_HOLD_S;
}

function sendHeadTick(st: TableSession, input: EngagedInput): void {
  st.lastSentJaw = jawDownOf(input);
  if (!sendTickBuf) return;
  const m = mouthOf(input.seat, input.pose);
  const w = localToWorld(st.pose, m.x, m.z);
  st.headSeq = (st.headSeq + 1) & 0xffff;
  sendTickBuf(packTick(headToTick({
    x: w.x, z: w.z, seat: input.seat, jawDown: st.lastSentJaw, seq: st.headSeq,
  })));
}

function sendBallTick(st: TableSession, k: number, now: number): void {
  st.ballSentAt[k] = now;
  if (!sendTickBuf) return;
  const b = st.balls[k];
  const w = localToWorld(st.pose, b.x, b.z);
  const wv = rotXZ(b.vx, b.vz, st.pose.rot);
  const speed = Math.min(IA_BALL_MAX_SPEED, Math.hypot(wv.x, wv.z));
  st.ballSeq[k] = (st.ballSeq[k] + 1) & IA_BALL_SEQ_MASK;
  sendTickBuf(packTick(ballToTick({
    x: w.x,
    z: w.z,
    heading: speed > 1e-6 ? Math.atan2(wv.z, wv.x) : 0,
    speed,
    index: k,
    seq: st.ballSeq[k],
  })));
}

// ── Operator election ────────────────────────────────────────────────────────

/** One sim at a time: the engaged claimant of the lowest claimed seat whose
 *  head is live. Only the page holding a seat counts as its claimant;
 *  spectators and a player's other pages never simulate. */
function amIOperator(st: TableSession, s: AlligatorsState, myId: string, now: number): boolean {
  const input = st.engaged;
  if (!input || s.status !== 'playing') return false;
  if (!playsSeat(s, input.seat, myId)) return false;
  for (const seat of claimedSeats(s)) {
    if (seat >= input.seat) break;
    if (now - st.lastHeadAt[seat] <= OPERATOR_TAKEOVER_MS) return false;
  }
  return true;
}

/** Fresh remote heads of claimed seats other than `exclude` (what blocks). */
function otherHeads(st: TableSession, s: AlligatorsState | null, exclude: number, now: number): OtherHead[] {
  const out: OtherHead[] = [];
  if (!s) return out;
  for (let i = 0; i < IA_SEATS; i++) {
    if (i === exclude || s.players[i] === null) continue;
    const rh = st.remoteHeads[i];
    out.push({ seat: i, pose: rh && now - rh.lastAt < REMOTE_STALE_MS ? rh.pose : { swing: 0, ext: 0 } });
  }
  return out;
}

// ── Per-frame drive (called from World.update for ALL tables, every frame) ───

/**
 * Advance every registered table one frame: the local head (bite timeline,
 * lunge, blocking), the operator sim (laying, spinning, bites → doc writes),
 * tick sends, remote smoothing and the in-world visuals.
 */
export function alligatorsFrame(dt: number): void {
  if (sessions.size === 0) return;
  const now = Date.now();
  const myId = getPlayerId();

  for (const itemId of sessions.keys()) {
    const st = sessionFor(itemId)!;
    // Follow furniture moves (air hockey: edit mode re-poses the group).
    const item = FURNITURE.find((i) => i.id === itemId);
    if (item) {
      st.pose.x = item.pos.x;
      st.pose.z = item.pos.z;
      st.pose.rot = item.rot;
    }

    // Frames stopped past a takeover's grace: another seat ran the balls
    // meanwhile, so this page comes back as a fresh operator. Landings the
    // network queued during the stall were judged by that other seat
    // already; replaying them on adopted positions would eat phantom balls.
    if (now - st.lastFrameAt > OPERATOR_TAKEOVER_MS) {
      st.wasOperator = false;
      st.pendingBites = [];
    }
    st.lastFrameAt = now;

    const s = readAlligators(itemId);
    const round = s && s.status !== 'waiting' ? roundClock(st, s, now) : 0;

    // Fresh round (or table cleared): reset grace clocks + transient state.
    const startedAt = s ? s.startedAt : null;
    if (startedAt !== st.seenStartedAt) {
      st.seenStartedAt = startedAt;
      st.lastHeadAt = st.lastHeadAt.map(() => now);
      st.wasOperator = false;
      st.remoteBalls = st.remoteBalls.map(() => null);
      st.balls = [];
      st.inSim = [];
      st.simAt = 0;
      st.ballSentAt = st.ballSentAt.map(() => 0);
      st.laidUpTo = 0;
    }

    const input = st.engaged;
    const iAmClaimant = input !== null && s !== null && playsSeat(s, input.seat, myId);

    // ── Local head: bite timeline, lunge, blocking ──
    if (input) {
      if (input.biteT !== null) {
        input.biteT += Math.max(0, dt);
        if (!input.lunge && input.biteT < IA_BITE_LAND_S && input.pushSinceClick >= LUNGE_PUSH_PX) {
          input.lunge = true; // pushed forward just after the click
        }
      }
      const biting = input.biteT !== null && input.biteT < IA_BITE_DONE_S;
      const desired: HeadPose = {
        swing: input.aim,
        ext: biting && input.lunge ? biteLungeExt(input.biteT!) : 0,
      };
      input.pose = resolveHeadPose(input.seat, input.pose, desired, otherHeads(st, s, input.seat, now));
      input.aim = input.pose.swing; // a blocked swing doesn't bank mouse travel
      if (input.biteT !== null && !input.landed && input.biteT >= IA_BITE_LAND_S) {
        input.landed = true;
        if (iAmClaimant && s?.status === 'playing') {
          const m = mouthOf(input.seat, input.pose);
          st.pendingBites.push({ seat: input.seat, x: m.x, z: m.z });
        }
      }
      if (input.biteT !== null && input.biteT >= IA_BITE_DONE_S) {
        input.biteT = null;
        input.lunge = false;
        input.landed = false;
      }
      if (iAmClaimant) st.lastHeadAt[input.seat] = now;
    }

    // ── Start promotion: any engaged claimant flips waiting → playing once
    // every claimed seat is ready (the doc write is idempotent-safe). ──
    if (iAmClaimant && s && s.status === 'waiting') {
      const ns = startIfReady(s, now);
      if (ns) writeGame(itemId, ns);
    }

    // ── Operator sim ──
    const operator = s !== null && amIOperator(st, s, myId, now);
    if (operator && s) {
      const n = s.eaten.length;
      if (!st.wasOperator) {
        // Rising edge (round start, takeover, or this page's frames coming
        // back after a stall): take each ball from whichever is newer — the
        // last operator's ticks, or this page's own sim (a lone practice
        // has no other operator to hear from). A laid ball neither knows of
        // is laid afresh below.
        for (let k = 0; k < n; k++) {
          const rb = st.remoteBalls[k];
          if (rb && rb.lastAt > st.simAt) {
            st.balls[k] = { x: rb.x, z: rb.z, vx: rb.vx, vz: rb.vz };
            st.inSim[k] = true;
          } else if (!st.inSim[k]) {
            st.balls[k] = { x: 0, z: 0, vx: 0, vz: 0 };
            st.inSim[k] = false;
          }
        }
        st.ballSentAt = st.ballSentAt.map(() => 0);
      }
      // Lay the eggs that have fallen due.
      const simLive: boolean[] = [];
      for (let k = 0; k < n; k++) {
        if (!st.inSim[k] && round >= layTimeMs(k) && s.eaten[k] === IA_LIVE) {
          st.balls[k] = eggSpawn(k, s.startedAt);
          st.inSim[k] = true;
        }
        simLive.push(st.inSim[k] && s.eaten[k] === IA_LIVE);
      }
      stepBalls(st.balls, simLive, dt, spinRate(round));
      st.simAt = now;

      // Bites: eat whatever lies under each landed mouth, one doc write each.
      for (const bite of st.pendingBites) {
        const eaten = ballsUnderMouth(st.balls, simLive, bite.x, bite.z);
        if (eaten.length === 0) continue;
        const current = readAlligators(itemId);
        const ns = current ? withBites(current, bite.seat, eaten) : null;
        if (ns) writeGame(itemId, ns);
        for (const k of eaten) simLive[k] = false;
      }

      // Ball broadcast: a shared budget, most overdue first; a rolling ball
      // is due far sooner than a resting one.
      st.ballBudget = Math.min(BALL_SEND_BUDGET_HZ / 6, st.ballBudget + dt * BALL_SEND_BUDGET_HZ);
      const due: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) {
        if (!simLive[k]) continue;
        const b = st.balls[k];
        const interval = Math.hypot(b.vx, b.vz) > BALL_REST_SPEED ? BALL_MOVING_INTERVAL_S : BALL_REST_INTERVAL_S;
        const overdue = (now - st.ballSentAt[k]) / 1000 - interval;
        if (overdue >= 0) due.push([overdue, k]);
      }
      due.sort((a, b) => b[0] - a[0]);
      for (const [, k] of due) {
        if (st.ballBudget < 1) break;
        st.ballBudget -= 1;
        sendBallTick(st, k, now);
      }
    }
    st.pendingBites = [];
    st.wasOperator = operator;

    // ── Head broadcast at 30 Hz while engaged as a claimant (waiting too —
    // presence for the operator election), plus at once when the jaw lands. ──
    if (input && iAmClaimant && s && s.status !== 'ended') {
      st.headSendAccum += dt;
      const interval = 1 / HEAD_SEND_HZ;
      if (jawDownOf(input) !== st.lastSentJaw) {
        st.headSendAccum = 0;
        sendHeadTick(st, input);
      } else if (st.headSendAccum >= interval) {
        st.headSendAccum = st.headSendAccum > 0.2 ? 0 : st.headSendAccum - interval;
        sendHeadTick(st, input);
      }
    }

    // ── Visuals: heads ──
    for (let seat = 0; seat < IA_SEATS; seat++) {
      const claimed = s !== null && s.players[seat] !== null;
      if (input?.seat === seat && iAmClaimant) {
        const jaw = input.biteT !== null ? biteJawOpen(input.biteT) : 1;
        st.handle.setHead(seat, true, input.pose.swing, input.pose.ext, jaw);
        continue;
      }
      const rh = st.remoteHeads[seat];
      if (rh && claimed && now - rh.lastAt < REMOTE_STALE_MS) {
        const k = 1 - Math.exp(-HEAD_DISPLAY_RATE * dt);
        rh.disp.swing += (rh.pose.swing - rh.disp.swing) * k;
        rh.disp.ext += (rh.pose.ext - rh.disp.ext) * k;
        const kj = 1 - Math.exp(-JAW_DISPLAY_RATE * dt);
        rh.jawDisp += ((rh.jawDown ? 0 : 1) - rh.jawDisp) * kj;
        st.handle.setHead(seat, true, rh.disp.swing, rh.disp.ext, rh.jawDisp);
      } else {
        st.handle.setHead(seat, claimed, 0, 0, 1);
      }
    }

    // ── Visuals: balls ──
    const playing = s !== null && s.status === 'playing';
    const count = playing ? s.eaten.length : 0;
    for (let k = 0; k < IA_MAX_BALLS; k++) {
      const alive = k < count && s!.eaten[k] === IA_LIVE;
      if (alive && operator && st.inSim[k]) {
        st.handle.setBall(k, st.balls[k].x, st.balls[k].z, true);
        continue;
      }
      const rb = st.remoteBalls[k];
      if (alive && !operator && rb && now - rb.lastAt < BALL_STALE_MS) {
        const age = Math.min(BALL_EXTRAPOLATE_MAX_S, Math.max(0, (now - rb.lastAt) / 1000));
        let tx = rb.x + rb.vx * age;
        let tz = rb.z + rb.vz * age;
        const r = Math.hypot(tx, tz);
        const rimMax = IA_TABLE_R - IA_BALL_R;
        if (r > rimMax) {
          tx *= rimMax / r;
          tz *= rimMax / r;
        }
        const kb = 1 - Math.exp(-BALL_DISPLAY_RATE * dt);
        rb.dispX += (tx - rb.dispX) * kb;
        rb.dispZ += (tz - rb.dispZ) * kb;
        st.handle.setBall(k, rb.dispX, rb.dispZ, true);
      } else {
        st.handle.setBall(k, 0, 0, false);
      }
    }

    // ── Visuals: the spinning top, the birds laying, the displays ──
    st.handle.setSpin(playing ? spinAngle(round) : 0);
    if (playing) {
      while (st.laidUpTo < count && layTimeMs(st.laidUpTo) <= round) {
        // A page arriving mid-round doesn't replay every egg at once.
        if (round - layTimeMs(st.laidUpTo) < 1000) st.handle.layEgg(birdOf(st.laidUpTo));
        st.laidUpTo += 1;
      }
    }
    const sc = s ? scores(s) : null;
    for (let seat = 0; seat < IA_SEATS; seat++) {
      const lit = s !== null && s.players[seat] !== null;
      const flashing = s !== null && s.status === 'ended' && s.winners.includes(seat);
      st.handle.setDisplay(seat, sc ? sc[seat] : 0, lit, flashing);
    }

    st.handle.update(dt);
  }
}

// ── Focused DOM UI (HUD only — the game lives on the in-world table) ─────────

export interface AlligatorsUIDeps {
  /** Furniture item id — doc key + session key. */
  itemId: string;
  /** The seat the player walked to (world.ts picks the free stand). */
  seat: number;
}

const UI_GOLD = '#d4a84b';
const UI_GOLD_BRIGHT = '#F0C060';

const seatName = (seat: number): string => IA_SEAT_NAMES[seat] ?? `SEAT ${seat + 1}`;
const seatColor = (seat: number): string =>
  `#${(IA_SEAT_COLORS[seat] ?? 0xd4a84b).toString(16).padStart(6, '0')}`;

/**
 * One seat chip of the focused HUD: the markup the card's innerHTML takes.
 * The player's display name is peer-writable, so it is cut to the name limit
 * and escaped before it reaches the DOM (air hockey's #116 XSS fix).
 */
export function alligatorsSeatChipHtml(
  s: AlligatorsState | null,
  seat: number,
  thisSeat: number,
  myId: string,
  displayName: (playerId: string) => string,
): string {
  const pid = s?.players[seat] ?? null;
  const name = pid ? displayName(pid).slice(0, PLAYER_NAME_MAX_LENGTH) : '';
  const count = s ? scores(s)[seat] : 0;
  const label = pid
    ? `${escapeHtml(name.toUpperCase())}${pid === myId ? ' (YOU)' : ''}${s?.status === 'waiting' && s.ready[seat] ? ' · READY' : ''}${s && s.status !== 'waiting' ? ` · ${count}` : ''}`
    : 'OPEN';
  return `
      <div style="display:flex; align-items:center; gap:6px; border:1px solid rgba(212,168,75,${seat === thisSeat ? '0.5' : '0.18'}); border-radius:6px; padding:4px 8px; min-width:0;">
        <span style="width:9px; height:9px; border-radius:50%; background:${seatColor(seat)}; flex:none; opacity:${pid ? 1 : 0.35};"></span>
        <span style="font-size:9px; letter-spacing:1px; color:${UI_GOLD}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${seatName(seat)} — ${label}</span>
      </div>`;
}

/** Standings line for the top bar and the end card. */
function standings(s: AlligatorsState): string {
  const sc = scores(s);
  return claimedSeats(s)
    .map((seat) => `<span style="color:${seatColor(seat)}; font-weight:800;">${seatName(seat)} ${sc[seat]}</span>`)
    .join('<span style="color:rgba(212,168,75,0.5);"> · </span>');
}

/** The round's one-line status (also used by tests). */
export function alligatorsStatusLine(s: AlligatorsState | null, roundMs: number): string {
  if (!s || (s.status === 'waiting' && claimedSeats(s).length === 0)) return 'TAKE A SEAT TO PLAY';
  if (s.status === 'waiting') {
    const n = claimedSeats(s).length;
    return n < IA_MIN_PLAYERS ? `WAITING FOR PLAYERS (${IA_MIN_PLAYERS}–${IA_SEATS})` : 'READY UP TO START';
  }
  if (s.status === 'ended') {
    if (s.winners.length === 0) return isPractice(s) ? 'ALL EATEN — PRACTICE OVER' : 'ROUND OVER';
    const names = s.winners.map(seatName).join(' & ');
    return s.winners.length > 1 ? `TIE: ${names}` : `${names} WINS`;
  }
  if (roundMs < IA_LAY_START_MS) return 'THE BIRDS ARE LAYING…';
  const phase = roundMs % IA_SPIN_EVERY_MS;
  if (roundMs >= IA_SPIN_EVERY_MS && phase < IA_SPIN_MS) return 'THE TABLE SPINS!';
  const left = s.eaten.filter((e) => e === IA_LIVE).length;
  return `${left} BALL${left === 1 ? '' : 'S'} LEFT${isPractice(s) ? ' · PRACTICE' : ''}`;
}

/**
 * The focused first-person HUD for one seat: seat card at the bottom,
 * standings on top, and the pointer-lock capture layer that turns the mouse
 * into the head (#185's control scheme). ALL shared state lives in the doc —
 * the panel re-renders from observers, never from local truth.
 */
export function createAlligatorsUI(deps: AlligatorsUIDeps): DeviceUI {
  const myId = getPlayerId();
  const seat = deps.seat;
  let panel: HTMLDivElement | null = null;
  let captureLayer: HTMLDivElement | null = null;
  let topBar: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let prompt: HTMLDivElement | null = null;
  let unsubGames: (() => void) | null = null;
  let lastTopHtml = '';
  let lastCardHtml = '';

  /** The room this panel opened in, and that room's doc (air hockey's rule:
   *  while another room is bound the panel reads and writes nothing). */
  let mountRoom: string | null = null;
  let mountEpoch = -1;
  const live = (): boolean => {
    if (mountRoom === null) return false;
    if (mountEpoch === casinoDocEpoch()) return true;
    if (activeRoomId() !== mountRoom) return false;
    mountEpoch = casinoDocEpoch();
    engage();
    return true;
  };
  const st = (): TableSession | null => (live() ? sessionFor(deps.itemId) : null);
  const state = (): AlligatorsState | null => (live() ? readAlligators(deps.itemId) : null);

  const plays = (s: AlligatorsState | null): s is AlligatorsState =>
    s !== null && playsSeat(s, seat, myId);

  /** May I drive the head right now? Claimed my seat, round not over. */
  const canDrive = (): boolean => {
    const s = state();
    return plays(s) && s.status !== 'ended';
  };

  const locked = (): boolean =>
    captureLayer !== null && document.pointerLockElement === captureLayer;

  const engage = (): void => {
    const session = sessionFor(deps.itemId);
    if (!session) return;
    session.engaged = {
      seat,
      pose: clampPose({ swing: 0, ext: 0 }),
      aim: 0,
      biteT: null,
      lunge: false,
      landed: false,
      pushes: [],
      pushSinceClick: 0,
      locked: locked(),
    };
  };

  // ── Doc transitions (read → pure engine → transacted write) ────────────────

  const doClaim = (): void => {
    if (!live()) return;
    const ns = claimSeat(state() ?? initialAlligatorsState(), seat, myId, PAGE);
    if (ns) writeGame(deps.itemId, ns);
  };

  const doPlayHere = (): void => {
    const s = state();
    const ns = s ? takeSeat(s, seat, myId, PAGE) : null;
    if (ns) writeGame(deps.itemId, ns);
  };

  const doReady = (ready: boolean): void => {
    const s = state();
    if (!plays(s)) return;
    const ns = setReady(s, seat, myId, ready);
    if (!ns) return;
    writeGame(deps.itemId, ns);
    if (ready) {
      // The last readier starts the round directly (frame loop is the backstop).
      const started = startIfReady(ns, Date.now());
      if (started) writeGame(deps.itemId, started);
    }
  };

  const doPractice = (): void => {
    const s = state();
    if (!plays(s)) return;
    const ns = startPractice(s, seat, myId, Date.now());
    if (ns) writeGame(deps.itemId, ns);
  };

  const doEndPractice = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'playing' || !isPractice(s)) return;
    writeGame(deps.itemId, initialAlligatorsState());
  };

  /** RESET TABLE gate (air hockey's canReset): anyone once a round ended;
   *  seated players or the room owner otherwise (frees seats players left). */
  const canReset = (s: AlligatorsState | null): boolean => {
    if (!s) return false;
    if (s.status === 'ended') return true;
    return s.players.includes(myId) || readRoomOwner() === myId;
  };

  const doReset = (): void => {
    const s = state();
    if (!canReset(s)) return;
    writeGame(deps.itemId, initialAlligatorsState());
  };

  const doAgain = (): void => {
    const s = state();
    const ns = s ? nextRound(s) : null;
    if (ns) writeGame(deps.itemId, ns);
  };

  const leaveSeat = (): void => {
    const s = state();
    if (!plays(s)) return;
    const ns = releaseSeat(s, seat, myId);
    if (ns) writeGame(deps.itemId, ns);
  };

  // ── Pointer lock + mouse → head ────────────────────────────────────────────

  const onLockChange = (): void => {
    const session = st();
    if (session?.engaged) session.engaged.locked = locked();
    render();
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!locked()) return;
    const input = st()?.engaged;
    if (!input || !canDrive()) return;
    // Side to side swings the head about its pivot; the focus camera looks
    // in along the seat, so screen-right is +swing for every seat.
    input.aim = clampPose({ swing: input.aim + e.movementX * SWING_SENS, ext: 0 }).swing;
    // Forward (mouse pushed away: −movementY) is the lunge gesture.
    const forward = -e.movementY;
    if (forward > 0) {
      const t = performance.now();
      input.pushes.push([t, forward]);
      while (input.pushes.length > 0 && t - input.pushes[0][0] > LUNGE_WINDOW_MS) input.pushes.shift();
      if (input.biteT !== null) input.pushSinceClick += forward;
    }
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (!locked() || e.button !== 0) return;
    const input = st()?.engaged;
    if (!input || !canDrive() || input.biteT !== null) return;
    // CHOMP — and a lunge if the mouse was pushed forward just before.
    const t = performance.now();
    const recent = input.pushes.reduce((sum, [at, px]) => (t - at <= LUNGE_WINDOW_MS ? sum + px : sum), 0);
    input.biteT = 0;
    input.landed = false;
    input.lunge = recent >= LUNGE_PUSH_PX;
    input.pushSinceClick = 0;
  };

  const onCaptureClick = (e: MouseEvent): void => {
    e.stopPropagation(); // never a click-away release
    if (locked() || !canDrive() || !captureLayer) return;
    const p = captureLayer.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => { /* throttled — retry by clicking */ });
  };

  // ── Rendering ──────────────────────────────────────────────────────────────

  const btn = (id: string, label: string, disabled: boolean, title = ''): string => `
    <button id="${id}" ${disabled ? 'disabled' : ''} title="${title}" style="
      padding: 7px 12px;
      background: rgba(212, 168, 75, ${disabled ? '0.04' : '0.10'});
      border: 1px solid rgba(212, 168, 75, ${disabled ? '0.18' : '0.45'});
      border-radius: 6px;
      color: ${disabled ? '#4A5560' : UI_GOLD_BRIGHT};
      font-family: inherit;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 1.5px;
      cursor: ${disabled ? 'not-allowed' : 'pointer'};
      opacity: ${disabled ? '0.5' : '1'};
    ">${label}</button>`;

  const roundMs = (s: AlligatorsState | null): number => {
    const session = st();
    return s && session && s.status !== 'waiting' ? roundClock(session, s, Date.now()) : 0;
  };

  const renderTop = (): void => {
    if (!topBar) return;
    const s = state();
    const status = alligatorsStatusLine(s, roundMs(s));
    const board = s && s.status !== 'waiting' ? standings(s) : '';
    const html = `
      <div style="text-align:center; font-size:13px; font-weight:800; letter-spacing:1px; color:${seatColor(seat)};">🐊 ${seatName(seat)} ALLIGATOR</div>
      ${board ? `<div style="text-align:center; font-size:11px; letter-spacing:1px; margin-top:3px;">${board}</div>` : ''}
      <div style="text-align:center; font-size:10px; letter-spacing:1.5px; color:${UI_GOLD}; margin-top:3px;">${status}</div>
      ${locked() ? `<div style="text-align:center; font-size:9px; letter-spacing:1px; color:rgba(212,168,75,0.55); margin-top:2px;">MOUSE ↔ SWING · CLICK BITE · PUSH + CLICK LUNGE · ESC TO LET GO</div>` : ''}`;
    if (html !== lastTopHtml) {
      lastTopHtml = html;
      topBar.innerHTML = html;
    }
  };

  const renderCard = (): void => {
    if (!card || !prompt) return;
    if (!live()) {
      prompt.style.display = 'none';
      card.style.display = 'flex';
      const html = `<div style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">THIS TABLE WAS IN THE ROOM YOU LEFT — STEP BACK</div>`;
      if (html !== lastCardHtml) {
        lastCardHtml = html;
        card.innerHTML = html;
      }
      return;
    }
    const s = state();
    prompt.style.display = canDrive() && !locked() ? 'flex' : 'none';
    card.style.display = locked() ? 'none' : 'flex';
    if (locked()) return;

    const mine = plays(s);
    const mineElsewhere = s !== null && s.players[seat] === myId && !mine;
    const resetTable = (table: AlligatorsState): string => (canReset(table)
      ? btn('ia-reset', 'RESET TABLE', false, 'Clear the table, freeing seats their players left')
      : '');
    const note = (text: string): string =>
      `<span style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">${text}</span>`;
    const playHere = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${note('YOU HOLD THIS SEAT FROM ANOTHER TAB OR DEVICE')}
          ${btn('ia-here', 'PLAY HERE', false, 'Play this seat from this tab instead')}
        </div>`;

    let actions = '';
    if (!s || s.status === 'waiting') {
      const takenByOther = s !== null && s.players[seat] !== null && s.players[seat] !== myId;
      const iHoldOther = s !== null && s.players.includes(myId) && s.players[seat] !== myId;
      if (takenByOther) {
        actions = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${note('THIS SEAT IS TAKEN — WALK ROUND TO A FREE ONE')}
          ${resetTable(s)}
        </div>`;
      } else if (mineElsewhere) {
        actions = playHere;
      } else if (iHoldOther) {
        actions = `<div>${note('YOU HOLD ANOTHER SEAT — WALK BACK ROUND')}</div>`;
      } else if (!mine) {
        actions = `<div style="display:flex; gap:8px; align-items:center;">
          ${btn('ia-claim', `TAKE THE ${seatName(seat)} SEAT`, false, 'Claim this alligator')}
        </div>`;
      } else {
        const ready = s.ready[seat];
        const alone = claimedSeats(s).length === 1;
        actions = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${ready
            ? btn('ia-unready', 'UNREADY', false, 'Step back from ready')
            : btn('ia-ready', 'READY UP', false, 'Lock in — the round starts when every seated player is ready')}
          ${alone && !ready ? btn('ia-practice', 'PRACTICE ALONE', false, 'Eat 10 balls on your own until someone joins') : ''}
          ${btn('ia-leave', 'LEAVE SEAT', false, 'Release this seat')}
        </div>`;
      }
    } else if (s.status === 'playing') {
      if (mine) {
        actions = isPractice(s)
          ? `<div style="display:flex; gap:8px;">${btn('ia-end', 'END PRACTICE', false, 'Stop practising and open the table')}</div>`
          : `<div>${note('ROUND IN PROGRESS — EAT!')}</div>`;
      } else {
        actions = mineElsewhere ? playHere : `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${note('ROUND IN PROGRESS — SPECTATING')}
          ${resetTable(s)}
        </div>`;
      }
    } else {
      const head = s.winners.length > 0
        ? `<span style="font-size:11px; font-weight:800; letter-spacing:1px; color:${seatColor(s.winners[0])};">${alligatorsStatusLine(s, 0)}</span>`
        : note(alligatorsStatusLine(s, 0));
      actions = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        ${head}
        ${btn('ia-again', 'PLAY AGAIN', false, 'Same seats, new round — everyone readies up again')}
        ${btn('ia-reset', 'RESET TABLE', !canReset(s), 'Clear every seat')}
      </div>
      <div style="font-size:10px; letter-spacing:1px;">${standings(s)}</div>`;
    }

    const chips = Array.from({ length: IA_SEATS }, (_, i) =>
      alligatorsSeatChipHtml(s, i, seat, myId, readPlayerDisplayName)).join('');
    const html = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:12px; font-weight:800; color:${UI_GOLD_BRIGHT}; letter-spacing:1px;">🐊 INSATIABLE ALLIGATORS</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD TO STEP BACK</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:4px;">${chips}</div>
      ${actions}`;
    if (html !== lastCardHtml) {
      lastCardHtml = html;
      card.innerHTML = html;
    }
  };

  const render = (): void => {
    renderTop();
    renderCard();
  };

  const onCardClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest('button');
    if (!target || target.disabled || !live()) return;
    switch (target.id) {
      case 'ia-claim': doClaim(); break;
      case 'ia-ready': doReady(true); break;
      case 'ia-unready': doReady(false); break;
      case 'ia-practice': doPractice(); break;
      case 'ia-end': doEndPractice(); break;
      case 'ia-reset': doReset(); break;
      case 'ia-again': doAgain(); break;
      case 'ia-here': doPlayHere(); break;
      case 'ia-leave': leaveSeat(); break;
    }
    render();
  };

  return {
    mount(host: HTMLElement): void {
      mountRoom = activeRoomId();
      mountEpoch = casinoDocEpoch();
      panel = document.createElement('div');
      panel.id = 'device-alligators-pane';
      panel.style.cssText = `
        position: absolute; inset: 0;
        pointer-events: none;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        color: ${UI_GOLD};
      `;

      // Stable pointer-lock target — never re-rendered (air hockey's rule).
      captureLayer = document.createElement('div');
      captureLayer.id = 'ia-capture';
      captureLayer.style.cssText = `
        position: absolute; inset: 0;
        pointer-events: auto;
        cursor: crosshair;
      `;
      captureLayer.addEventListener('click', onCaptureClick);
      // A locked mousedown fires on the capture layer and would bubble into
      // zoom.ts's "click-while-locked exits pointer lock" handler: run the
      // bite first, then stop it (air hockey's #116 fix).
      captureLayer.addEventListener('mousedown', (e) => {
        onMouseDown(e);
        e.stopPropagation();
      });
      captureLayer.addEventListener('mouseup', (e) => e.stopPropagation());
      panel.appendChild(captureLayer);

      topBar = document.createElement('div');
      topBar.style.cssText = `
        position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
        min-width: 320px; max-width: 94vw; padding: 10px 22px; box-sizing: border-box;
        background: rgba(4, 8, 22, 0.88);
        border: 1px solid rgba(212, 168, 75, 0.28); border-radius: 10px;
        pointer-events: none;
      `;
      panel.appendChild(topBar);

      prompt = document.createElement('div');
      prompt.style.cssText = `
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        flex-direction: column; align-items: center; gap: 6px;
        pointer-events: none; display: none;
        text-shadow: 0 2px 12px rgba(0,0,0,0.9);
      `;
      prompt.innerHTML = `
        <div style="font-size:16px; font-weight:800; letter-spacing:2px; color:${UI_GOLD_BRIGHT};">CLICK TO TAKE CONTROL</div>
        <div style="font-size:10px; letter-spacing:1.5px; color:rgba(240,192,96,0.75);">MOUSE ↔ SWING · CLICK BITE · PUSH FORWARD + CLICK TO LUNGE</div>`;
      panel.appendChild(prompt);

      card = document.createElement('div');
      card.style.cssText = `
        position: absolute; bottom: 22px; left: 50%; transform: translateX(-50%);
        width: 600px; max-width: 94vw; max-height: 48vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.92);
        border: 1px solid rgba(212, 168, 75, 0.28); border-radius: 12px;
        box-shadow: 0 12px 64px rgba(0,0,0,0.85);
        padding: 14px 16px;
        display: flex; flex-direction: column; gap: 10px;
        pointer-events: auto; box-sizing: border-box;
      `;
      card.addEventListener('click', onCardClick);
      card.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.appendChild(card);

      host.appendChild(panel);

      engage();

      document.addEventListener('pointerlockchange', onLockChange);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mousedown', onMouseDown);
      unsubGames = subscribeGames(() => render());
      render();
    },

    unmount(): void {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      if (locked()) document.exitPointerLock();
      unsubGames?.();
      unsubGames = null;

      // Walk-away semantics per state:
      //  waiting  → release the seat (its head folds away);
      //  practice → abandon: reopen the table;
      //  versus   → KEEP the seat: the round plays on without this head, and
      //             the next seat up takes over the balls if this page ran them;
      //  ended    → leave the result standing for PLAY AGAIN.
      const s = state();
      const session = st();
      if (plays(s)) {
        if (s.status === 'waiting') leaveSeat();
        else if (s.status === 'playing' && isPractice(s)) writeGame(deps.itemId, initialAlligatorsState());
      }
      if (session?.engaged?.seat === seat) {
        // One last tick at rest so the remote head settles instead of
        // freezing mid-swing for the stale window.
        session.engaged.pose = { swing: 0, ext: 0 };
        session.engaged.biteT = null;
        if (plays(s) && s.status !== 'ended') sendHeadTick(session, session.engaged);
        session.engaged = null;
      }
      panel?.remove();
      panel = null;
      captureLayer = null;
      topBar = null;
      card = null;
      prompt = null;
      lastTopHtml = '';
      lastCardHtml = '';
      mountRoom = null;
    },

    update(): void {
      // Time-driven text only (laying, spins, balls left) — the HTML diff in
      // render() keeps the per-frame call cheap.
      render();
    },
  };
}

// Permanent debug handle (the __ssfAirHockey precedent): console inspection of
// live session state + manual tick injection during play tests.
(window as unknown as { __ssfAlligators: unknown }).__ssfAlligators = {
  sessions,
  routeAlligatorsTick,
  frame: alligatorsFrame,
  read: readAlligators,
};
