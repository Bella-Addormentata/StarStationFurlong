/**
 * 🏒 Air-hockey session (#115) — the LIVE layer between the pure engine
 * (games/airHockey.ts) and everything it touches:
 *
 *  - the room doc (games/gamesDoc.ts `games` map): claims, ready state,
 *    score, serve schedule — every transition is read → pure engine →
 *    transacted whole-value write (the checkers/chess discipline);
 *  - the 13-byte tick lane (network/protocol.ts): mallet ticks at 30 Hz and
 *    puck ticks at 20 Hz share the movement datagram path, discriminated by
 *    the flags-bits-6..7 lane kind — positions travel in WORLD space so a
 *    pre-#115 client misparsing one renders a harmless avatar-on-the-table,
 *    never a teleport;
 *  - the in-world table meshes (furniture.ts → AirHockeyVisualHandle): the
 *    SAME puck/mallet meshes serve players and spectators (the diegetic-
 *    display rule) — there is no separate DOM game surface, the DOM is only
 *    a HUD (score bar, claim/ready card, pointer-lock prompt).
 *
 * AUTHORITY MODEL (single operator, doc-recorded outcomes):
 *  - Exactly one client SIMULATES the puck at a time — the "operator". Side
 *    a's claimant while engaged; side b's claimant covers when a's mallet
 *    ticks go silent >1 s (walk-away/crash); a solo practice claimant always
 *    operates. Everyone else EXTRAPOLATES the last puck tick — spectators
 *    never simulate, so there is one physics truth and LWW score writes.
 *  - Goals/serves/forfeits are doc writes by the operator (or the surviving
 *    side, for forfeits) — a rejoining client converges from the doc alone.
 *  - Peer trust boundary: ticks are cosmetic physics from untrusted peers
 *    (movement-lane precedent) — every decode is range-guarded and clamped;
 *    the doc writes remain the only record that matters.
 *
 * ISSUE #115 CONTROLS: focusing a table end enters the first-person play
 * position (world.ts requestDeviceFocus 'airHockey' branch picks the free
 * end); clicking the view grabs POINTER LOCK — mouse deltas drive the
 * mallet, HOLDING the mouse button places the mallet DOWN on the table,
 * releasing lifts it (a lifted mallet neither blocks nor strikes). Esc once
 * releases the pointer; Esc again steps back from the table.
 */

import {
  AH_GOAL_PAUSE_MS, AH_GOALS_TO_WIN, AH_HALF_L, AH_HALF_W, AH_PUCK_R,
  AH_SERVE_DELAY_MS, AH_STUCK_SPEED, AH_STUCK_TIMEOUT_MS,
  claimSide, clampMallet, initialAirHockeyState, isVersus, otherSide, releaseSide,
  malletFromTick, malletToTick, puckFromTick, puckToTick, seatOf,
  servePosition, setReady, setUnready, startIfReady, startPractice, stepPuck,
  takeSeat, withForfeit, withGoal,
} from './games/airHockey';
import type {
  AirHockeySide, AirHockeyState, MalletInput, PuckSim,
} from './games/airHockey';
import {
  readAirHockey, readPlayerDisplayName, readRoomOwner, subscribeGames,
  writeGame,
} from './games/gamesDoc';
import { casinoDocEpoch } from './casinoDoc';
// #116 review fix: HTML escaper for peer-authored strings that reach
// innerHTML (the seat-row display-name interpolation, previously an XSS).
import { escapeHtml } from './htmlEscape';
import { getPlayerId, PLAYER_NAME_MAX_LENGTH } from './identity';
import {
  packTick, tickKind, TICK_KIND_AH_MALLET, TICK_KIND_AH_PUCK,
} from './network/protocol';
import type { MovementTick } from './network/protocol';
import { FURNITURE, rotXZ } from './furniture';
import type { Rot } from './furniture';
import type { AirHockeyVisualHandle, DeviceUI } from './devices';
import { activeRoomId } from './roomInventory';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Mallet broadcast rate — presence + strike-velocity source for the sim. */
const MALLET_SEND_HZ = 30;
/** Puck broadcast rate — spectator extrapolation refresh (operator only). */
const PUCK_SEND_HZ = 20;
/** Metres of mallet travel per pixel of pointer-locked mouse movement. */
const MOUSE_SENS = 0.0022;
/** A remote mallet/puck with no tick this long is hidden ("picked up"). */
const REMOTE_STALE_MS = 2000;
/** Side b assumes the puck sim when side a's mallet lane is silent this long. */
const OPERATOR_TAKEOVER_MS = 1000;
/** Mid-match walkover: opponent silent this long forfeits (#115 versus only). */
const FORFEIT_MS = 10000;
/** Cap on mallet velocity fed to the sim — a lag-spike teleport must not
 *  launch the puck at silly speed (the puck has its own 6 m/s cap anyway). */
const MALLET_VEL_MAX = 10;
/** Exponential approach rates (1/s) smoothing 20–30 Hz ticks to 60 fps. */
const PUCK_DISPLAY_RATE = 18;
const MALLET_DISPLAY_RATE = 22;
/** Furthest ahead a remote puck is dead-reckoned (covers one dropped tick). */
const PUCK_EXTRAPOLATE_MAX_S = 0.25;
/** The furthest ahead any write schedules a serve (a start's delay or a goal's
 *  pause): a serve falls due no later than this after this page first sees it
 *  scheduled, whatever clock wrote its deadline (servesAt). */
const MAX_SERVE_WAIT_MS = Math.max(AH_SERVE_DELAY_MS, AH_GOAL_PAUSE_MS);

// ── Per-table runtime state ──────────────────────────────────────────────────

/** Where a furniture item sits — converts LOCAL table coords ⇄ WORLD ticks. */
interface TablePose {
  x: number;
  z: number;
  rot: Rot;
}

/** Latest remote mallet sample for one side, in LOCAL table coords. */
interface RemoteMallet {
  x: number;
  z: number;
  /** Estimated velocity (m/s) from successive ticks — the sim's strike input. */
  vx: number;
  vz: number;
  down: boolean;
  /** Smoothed display position (approaches x/z each frame). */
  dispX: number;
  dispZ: number;
  seq: number;
  /** Wall-clock ms of the last tick — staleness + velocity dt. */
  lastAt: number;
  /** Sender lane id — a change means a new client took the side: reset. */
  sender: string;
}

/** Latest remote puck sample (non-operators), in LOCAL table coords. */
interface RemotePuck {
  x: number;
  z: number;
  vx: number;
  vz: number;
  active: boolean;
  dispX: number;
  dispZ: number;
  seq: number;
  lastAt: number;
  sender: string;
}

/** Local player's live input while focused at one end (pointer-lock state). */
interface EngagedInput {
  side: AirHockeySide;
  /** Mallet centre, LOCAL table coords (clamped to the side's half). */
  x: number;
  z: number;
  /** Smoothed velocity estimate for the sim (computed per frame). */
  vx: number;
  vz: number;
  /** Previous frame position — velocity numerator. */
  prevX: number;
  prevZ: number;
  /** Mouse button held ⇒ mallet DOWN on the table (#115). */
  down: boolean;
  /** Pointer lock currently held by this table's capture layer. */
  locked: boolean;
}

interface TableSession {
  handle: AirHockeyVisualHandle;
  pose: TablePose;
  /** The room doc this session began in (casinoDocEpoch). Everything below
   *  is that room's: see sessionFor. */
  docEpoch: number;
  remoteMallet: { a: RemoteMallet | null; b: RemoteMallet | null };
  remotePuck: RemotePuck | null;
  engaged: EngagedInput | null;
  /** Operator-only authoritative sim (LOCAL coords). */
  puck: PuckSim;
  /** Sim live? False between goal and serve (puck held by the machine). */
  puckActive: boolean;
  /** Was I the operator last frame — a rising edge adopts the remote puck. */
  wasOperator: boolean;
  /** Wall-clock ms of this session's last frame (0 = none yet). A page whose
   *  frames stop (a hidden tab gets none) isn't operating, whatever
   *  wasOperator last recorded. */
  lastFrameAt: number;
  /** Wall-clock ms of the last mallet evidence per side (ticks, or my own
   *  engaged frames) — feeds operator takeover + forfeit. Per-sender seq
   *  counters aren't cross-comparable, so staleness is wall-clock. */
  lastMalletAt: { a: number; b: number };
  /** Wall-clock ms the puck sim has been under AH_STUCK_SPEED, or null. */
  slowSince: number | null;
  /** Last observed score (same startedAt) — goal-lamp flash edge detector. */
  prevScore: { a: number; b: number; startedAt: number } | null;
  /** startedAt last seen — a change is a fresh match: reset grace clocks. */
  seenStartedAt: number | null;
  /** The doc's scheduled serve (`serveAt`) as this page last saw it, and when
   *  it first did (servesAt). */
  serveSeen: { serveAt: number; at: number } | null;
  malletSendAccum: number;
  malletSeq: number;
  puckSendAccum: number;
  puckSeq: number;
}

const sessions = new Map<string, TableSession>();

/** This page's seat (AirHockeyState.seats). A player id is shared by every
 *  tab and device of that player, so two of their pages at one end would both
 *  run the puck and race each other's score writes. Only the page holding an
 *  end's seat plays it. Fresh on every page load. */
const PAGE_SEAT = mintSeat();

function mintSeat(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to the non-crypto shape */ }
  return `seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** This page's seat: the one it claims ends with (tests and debugging). */
export function airHockeySeat(): string {
  return PAGE_SEAT;
}

/** Does this page play `side`? Its player holds the end, from this page. */
function playsSide(s: AirHockeyState, side: AirHockeySide, myId: string): boolean {
  return s.players[side] === myId && seatOf(s, side) === PAGE_SEAT;
}

/** Outbound datagram seam — main.ts wires NetworkProvider.sendTick here. */
let sendTickBuf: ((buf: Uint8Array) => void) | null = null;

export function setAirHockeySender(fn: ((buf: Uint8Array) => void) | null): void {
  sendTickBuf = fn;
}

/**
 * Register (or re-register after a furniture-doc rebuild) a built table's
 * visual handle + pose. Match-transient state survives a handle swap — the
 * table mesh was rebuilt, not the game — within one room's doc only.
 */
export function registerAirHockeyVisual(
  itemId: string,
  handle: AirHockeyVisualHandle,
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

/**
 * The table's session in the room's current doc. The registry outlives a
 * room change, and the next room can hold a table with the same id, whose
 * built group the furniture reconcile keeps without registering it again.
 * A session begun in another room's doc therefore starts afresh here, on
 * the same handle: no remote samples, operator state, sequence counters or
 * engaged input carry over to the new doc.
 */
function sessionFor(itemId: string): TableSession | null {
  const st = sessions.get(itemId);
  if (!st || st.docEpoch === casinoDocEpoch()) return st ?? null;
  const fresh = freshSession(st.handle, st.pose);
  sessions.set(itemId, fresh);
  return fresh;
}

function freshSession(handle: AirHockeyVisualHandle, pose: TablePose): TableSession {
  return {
    handle,
    pose,
    docEpoch: casinoDocEpoch(),
    remoteMallet: { a: null, b: null },
    remotePuck: null,
    engaged: null,
    puck: { x: 0, z: 0, vx: 0, vz: 0 },
    puckActive: false,
    wasOperator: false,
    lastFrameAt: 0,
    lastMalletAt: { a: 0, b: 0 },
    slowSince: null,
    prevScore: null,
    seenStartedAt: null,
    serveSeen: null,
    malletSendAccum: 0,
    malletSeq: 0,
    puckSendAccum: 0,
    puckSeq: 0,
  };
}

/** Drop a removed table's runtime state (world.ts removeFurnitureVisuals).
 *  Doc cleanup (clearTable) stays with the caller — this is runtime only. */
export function closeAirHockeyTable(itemId: string): void {
  sessions.delete(itemId);
}

// ── Coordinate conversion (LOCAL table frame ⇄ WORLD tick frame) ─────────────

/** Inverse quarter-turn: rotXZ(rotXZ(p, rot), invRot(rot)) === p. */
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

/** Rotate a VECTOR (velocity) local → world — rotation only, no translation. */
function localVecToWorld(pose: TablePose, vx: number, vz: number): { x: number; z: number } {
  return rotXZ(vx, vz, pose.rot);
}

function worldVecToLocal(pose: TablePose, vx: number, vz: number): { x: number; z: number } {
  return rotXZ(vx, vz, invRot(pose.rot));
}

// ── Inbound tick routing (called from main.ts for every non-movement tick) ───

/** u16 serial arithmetic: is `next` newer than `prev` under wraparound? */
function seqNewer(next: number, prev: number): boolean {
  const d = (next - prev) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** The registered table whose playfield (plus margin) contains the world
 *  point — ticks carry no table id, position IS the address. Nearest centre
 *  wins if two tables' margins ever overlap. */
function tableAtWorld(x: number, z: number): { id: string; st: TableSession } | null {
  let best: { id: string; st: TableSession } | null = null;
  let bestD = Infinity;
  for (const id of sessions.keys()) {
    const st = sessionFor(id)!;
    const l = worldToLocal(st.pose, x, z);
    if (Math.abs(l.x) > AH_HALF_W + 0.6 || Math.abs(l.z) > AH_HALF_L + 0.6) continue;
    const d = l.x * l.x + l.z * l.z;
    if (d < bestD) {
      bestD = d;
      best = { id, st };
    }
  }
  return best;
}

/**
 * Route one already-unpacked non-movement tick from a peer. main.ts calls
 * this for tickKind ≠ movement BEFORE its avatar bookkeeping, so game ticks
 * never mint phantom avatars.
 */
export function routeAirHockeyTick(senderId: string, tick: MovementTick): void {
  // An evil/buggy peer can put anything in the f32s — drop non-finite early;
  // everything below clamps into table space.
  if (!Number.isFinite(tick.x) || !Number.isFinite(tick.z)) return;
  const kind = tickKind(tick.flags);
  const found = tableAtWorld(tick.x, tick.z);
  if (!found) return; // no table under that point (removed, or garbage)
  const { id, st } = found;
  const now = Date.now();

  if (kind === TICK_KIND_AH_MALLET) {
    const m = malletFromTick(tick);
    const l = worldToLocal(st.pose, m.x, m.z);
    // The side IS the half the mallet is in (clampMallet keeps senders ≥ one
    // mallet-radius from the centre line, so the sign never wavers).
    const side: AirHockeySide = l.z < 0 ? 'a' : 'b';
    // Self-echo guard: while I play a side, its mallet is MINE — a loopback
    // or impersonating tick must not fight my local input. Engaged on an end
    // another page of mine plays, this page shows that page's mallet instead.
    if (st.engaged?.side === side) {
      const s = readAirHockey(id);
      if (s && playsSide(s, side, getPlayerId())) return;
    }
    const c = clampMallet(side, l.x, l.z);
    const prev = st.remoteMallet[side];
    const fresh = !prev || prev.sender !== senderId || now - prev.lastAt > REMOTE_STALE_MS;
    if (!fresh && prev && !seqNewer(m.seq, prev.seq)) return; // stale/dup datagram
    let vx = 0;
    let vz = 0;
    if (!fresh && prev) {
      // Velocity from consecutive ticks — the sim's strike input. A gap
      // (>0.3 s) is a rejoin/teleport, not a swing: contribute no velocity.
      const dtT = (now - prev.lastAt) / 1000;
      if (dtT > 0.001 && dtT < 0.3) {
        vx = (c.x - prev.x) / dtT;
        vz = (c.z - prev.z) / dtT;
        const sp = Math.hypot(vx, vz);
        if (sp > MALLET_VEL_MAX) {
          vx *= MALLET_VEL_MAX / sp;
          vz *= MALLET_VEL_MAX / sp;
        }
      }
    }
    st.remoteMallet[side] = {
      x: c.x,
      z: c.z,
      vx,
      vz,
      down: m.down,
      dispX: fresh ? c.x : (prev?.dispX ?? c.x),
      dispZ: fresh ? c.z : (prev?.dispZ ?? c.z),
      seq: m.seq,
      lastAt: now,
      sender: senderId,
    };
    st.lastMalletAt[side] = now; // presence evidence (takeover/forfeit clocks)
    return;
  }

  if (kind === TICK_KIND_AH_PUCK) {
    // While I'm the operator MY sim is truth — ignore echoes and the brief
    // double-operator overlap during a takeover handoff. A page whose frames
    // have stopped isn't operating, whatever it last recorded: side b takes
    // over after a second of silence, and this page keeps that puck, to adopt
    // when its frames resume.
    if (st.wasOperator && now - st.lastFrameAt <= OPERATOR_TAKEOVER_MS) return;
    const p = puckFromTick(tick);
    const l = worldToLocal(st.pose, p.x, p.z);
    const lx = Math.max(-AH_HALF_W, Math.min(AH_HALF_W, l.x));
    const lz = Math.max(-AH_HALF_L - AH_PUCK_R, Math.min(AH_HALF_L + AH_PUCK_R, l.z));
    const wv = { x: Math.cos(p.heading) * p.speed, z: Math.sin(p.heading) * p.speed };
    const lv = worldVecToLocal(st.pose, wv.x, wv.z);
    const prev = st.remotePuck;
    const fresh = !prev || prev.sender !== senderId || now - prev.lastAt > REMOTE_STALE_MS;
    if (!fresh && prev && !seqNewer(p.seq, prev.seq)) return;
    st.remotePuck = {
      x: lx,
      z: lz,
      vx: lv.x,
      vz: lv.z,
      active: p.active,
      dispX: fresh ? lx : (prev?.dispX ?? lx),
      dispZ: fresh ? lz : (prev?.dispZ ?? lz),
      seq: p.seq,
      lastAt: now,
      sender: senderId,
    };
  }
}

// ── Outbound sends ───────────────────────────────────────────────────────────

function sendMalletTick(st: TableSession, input: EngagedInput): void {
  if (!sendTickBuf) return;
  const w = localToWorld(st.pose, input.x, input.z);
  st.malletSeq = (st.malletSeq + 1) & 0xffff;
  sendTickBuf(packTick(malletToTick({ x: w.x, z: w.z, down: input.down, seq: st.malletSeq })));
}

function sendPuckTick(st: TableSession, x: number, z: number, vx: number, vz: number, active: boolean): void {
  if (!sendTickBuf) return;
  const w = localToWorld(st.pose, x, z);
  const wv = localVecToWorld(st.pose, vx, vz);
  const speed = Math.hypot(wv.x, wv.z);
  st.puckSeq = (st.puckSeq + 1) & 0xffff;
  sendTickBuf(packTick(puckToTick({
    x: w.x,
    z: w.z,
    heading: speed > 1e-6 ? Math.atan2(wv.z, wv.x) : 0,
    speed,
    active,
    seq: st.puckSeq,
  })));
}

/**
 * When the doc's scheduled serve falls due on THIS page's clock (0 = none).
 * `serveAt` is a deadline on its writer's wall clock, and devices' clocks
 * aren't synchronised: one written by a clock minutes ahead would hold the
 * puck for minutes, on the operator and on every scoreboard. So a serve falls
 * due no later than MAX_SERVE_WAIT_MS after this page first saw it scheduled,
 * whatever deadline it names. (One written by a clock running behind falls
 * due early, down to at once: a shorter countdown, never a stall.)
 */
function servesAt(st: TableSession, s: AirHockeyState, now: number): number {
  if (s.serveAt <= 0) {
    st.serveSeen = null;
    return 0;
  }
  if (st.serveSeen?.serveAt !== s.serveAt) st.serveSeen = { serveAt: s.serveAt, at: now };
  return Math.min(s.serveAt, st.serveSeen.at + MAX_SERVE_WAIT_MS);
}

// ── Operator election ────────────────────────────────────────────────────────

/** One sim at a time: side a's engaged claimant by default; side b's covers
 *  a silent side a; a solo practice claimant always operates. Only the page
 *  holding the end's seat counts as its claimant. Spectators, the unengaged
 *  and a player's other pages NEVER simulate. */
function amIOperator(st: TableSession, s: AirHockeyState, myId: string, now: number): boolean {
  const input = st.engaged;
  if (!input || s.status !== 'playing') return false;
  if (!playsSide(s, input.side, myId)) return false;
  if (!isVersus(s)) return true;
  if (input.side === 'a') return true;
  return now - st.lastMalletAt.a > OPERATOR_TAKEOVER_MS;
}

// ── Per-frame drive (called from World.update for ALL tables, every frame) ───

/**
 * Advance every registered table one frame: local input velocity, the
 * operator sim (serve/goal/stuck/forfeit doc writes), tick sends, remote
 * smoothing, and the in-world visuals (mallets, puck, scoreboard, lamps).
 */
export function airHockeyFrame(dt: number): void {
  if (sessions.size === 0) return;
  const now = Date.now();
  const myId = getPlayerId();

  for (const itemId of sessions.keys()) {
    const st = sessionFor(itemId)!;
    // Follow furniture moves: edit mode re-poses the existing group WITHOUT a
    // remove/re-register (commitCarry locally, the E4 reconcile remotely), so
    // the wire-frame pose is re-read from the live registry each frame — a
    // stale pose would route ticks to the table's old spot.
    const item = FURNITURE.find((i) => i.id === itemId);
    if (item) {
      st.pose.x = item.pos.x;
      st.pose.z = item.pos.z;
      st.pose.rot = item.rot;
    }

    // Frames stopped for over a takeover's grace (a hidden tab, a long
    // stall): side b took over meanwhile, so this page comes back as a fresh
    // operator, adopting the current puck on the rising edge below rather
    // than resuming its own from before the stall. Its mallet comes back at
    // rest too: a swing from before the stall must not strike the puck it
    // adopts.
    if (now - st.lastFrameAt > OPERATOR_TAKEOVER_MS) {
      st.wasOperator = false;
      if (st.engaged) {
        st.engaged.vx = 0;
        st.engaged.vz = 0;
        st.engaged.prevX = st.engaged.x;
        st.engaged.prevZ = st.engaged.z;
      }
    }
    st.lastFrameAt = now;

    const s = readAirHockey(itemId);
    const serveDue = s ? servesAt(st, s, now) : 0;

    // Fresh match (or table cleared): reset grace clocks + transient physics
    // so takeover/forfeit never fire off pre-match silence, and a stale
    // remote puck never bleeds into the new game.
    const startedAt = s ? s.startedAt : null;
    if (startedAt !== st.seenStartedAt) {
      st.seenStartedAt = startedAt;
      st.lastMalletAt = { a: now, b: now };
      st.slowSince = null;
      st.puckActive = false;
      st.wasOperator = false;
      st.remotePuck = null;
    }

    const input = st.engaged;
    const iAmClaimant = input !== null && s !== null && playsSide(s, input.side, myId);

    // ── Local input upkeep (velocity estimate + presence heartbeat) ──
    if (input) {
      if (dt > 0.0005) {
        // Exponentially smoothed finite difference — jitter-free strike
        // velocity without a per-event timestamp ring.
        const ivx = (input.x - input.prevX) / dt;
        const ivz = (input.z - input.prevZ) / dt;
        const blend = 0.5;
        input.vx += (ivx - input.vx) * blend;
        input.vz += (ivz - input.vz) * blend;
        const sp = Math.hypot(input.vx, input.vz);
        if (sp > MALLET_VEL_MAX) {
          input.vx *= MALLET_VEL_MAX / sp;
          input.vz *= MALLET_VEL_MAX / sp;
        }
      }
      input.prevX = input.x;
      input.prevZ = input.z;
      if (iAmClaimant) st.lastMalletAt[input.side] = now;
    }

    // ── Start promotion: any engaged claimant flips waiting → playing once
    // both sides readied (idempotent: the local write applies synchronously,
    // so next frame startIfReady returns null; LWW settles the two-client
    // race to equivalent starts). ──
    if (iAmClaimant && s && s.status === 'waiting' && s.ready.a && s.ready.b) {
      const ns = startIfReady(s, now);
      if (ns) writeGame(itemId, ns);
    }

    // ── Operator sim ──
    const operator = s !== null && amIOperator(st, s, myId, now);
    if (operator && s) {
      if (!st.wasOperator) {
        // Rising edge (fresh start OR mid-match takeover): adopt the last
        // remote puck if it's fresh — the rally continues where a left it;
        // otherwise fall through to a (re-)serve below.
        const rp = st.remotePuck;
        if (rp && now - rp.lastAt < REMOTE_STALE_MS) {
          st.puck = { x: rp.x, z: rp.z, vx: rp.vx, vz: rp.vz };
          st.puckActive = rp.active;
        } else {
          st.puckActive = false;
        }
        st.slowSince = null;
      }

      // Serve: place the puck once the doc's serve falls due on this page's
      // clock (servesAt). serveAt is stamped by startIfReady/startPractice/
      // withGoal (and the stuck re-serve), so during play it is always > 0.
      if (!st.puckActive && serveDue > 0 && now >= serveDue) {
        const sp = servePosition(s);
        st.puck = { x: sp.x, z: sp.z, vx: 0, vz: 0 };
        st.puckActive = true;
        st.slowSince = null;
      }

      if (st.puckActive) {
        // Assemble this frame's mallets: my own live input plus any fresh
        // remote side (its estimated velocity is the strike input).
        const mallets: MalletInput[] = [];
        if (input && iAmClaimant) {
          mallets.push({ x: input.x, z: input.z, vx: input.vx, vz: input.vz, down: input.down });
        }
        for (const side of ['a', 'b'] as const) {
          if (input?.side === side) continue;
          const rm = st.remoteMallet[side];
          if (rm && now - rm.lastAt < REMOTE_STALE_MS && s.players[side] !== null) {
            mallets.push({ x: rm.x, z: rm.z, vx: rm.vx, vz: rm.vz, down: rm.down });
          }
        }
        const scoredOn = stepPuck(st.puck, mallets, dt);

        if (scoredOn) {
          const ns = withGoal(s, scoredOn, now);
          if (ns) writeGame(itemId, ns);
          st.puckActive = false;
          st.slowSince = null;
          // Freeze spectators immediately (don't wait for the next 20 Hz slot).
          sendPuckTick(st, st.puck.x, st.puck.z, 0, 0, false);
        } else {
          // Stuck watchdog: a puck dawdling below AH_STUCK_SPEED for 8 s
          // (dead spot, wedged in a corner) re-serves via the doc so both
          // players see the countdown.
          const speed = Math.hypot(st.puck.vx, st.puck.vz);
          if (speed < AH_STUCK_SPEED) {
            if (st.slowSince === null) st.slowSince = now;
            else if (now - st.slowSince > AH_STUCK_TIMEOUT_MS) {
              writeGame(itemId, { ...s, serveAt: now + AH_SERVE_DELAY_MS });
              st.puckActive = false;
              st.slowSince = null;
            }
          } else {
            st.slowSince = null;
          }
        }
      }

      // Puck broadcast at 20 Hz — including the serve countdown (inactive,
      // parked at the serve spot) so spectators see the telegraph and never
      // stale-hide a live table's puck.
      st.puckSendAccum += dt;
      const puckInterval = 1 / PUCK_SEND_HZ;
      if (st.puckSendAccum >= puckInterval) {
        st.puckSendAccum = st.puckSendAccum > 0.2 ? 0 : st.puckSendAccum - puckInterval;
        if (st.puckActive) {
          sendPuckTick(st, st.puck.x, st.puck.z, st.puck.vx, st.puck.vz, true);
        } else if (s.status === 'playing') {
          const sp = servePosition(s);
          sendPuckTick(st, sp.x, sp.z, 0, 0, false);
        }
      }
    }
    st.wasOperator = operator;

    // ── Forfeit watch (versus, engaged claimant): a silent opponent >10 s
    // mid-match walks over. Only the PRESENT side runs this write. ──
    if (iAmClaimant && input && s && s.status === 'playing' && isVersus(s)) {
      const opp = otherSide(input.side);
      if (now - st.lastMalletAt[opp] > FORFEIT_MS) {
        const ns = withForfeit(s, input.side);
        if (ns) writeGame(itemId, ns);
      }
    }

    // ── Mallet broadcast at 30 Hz while engaged as a claimant (waiting too —
    // the warm-up wave doubles as the presence heartbeat). ──
    if (input && iAmClaimant && s && s.status !== 'ended') {
      st.malletSendAccum += dt;
      const malletInterval = 1 / MALLET_SEND_HZ;
      if (st.malletSendAccum >= malletInterval) {
        st.malletSendAccum = st.malletSendAccum > 0.2 ? 0 : st.malletSendAccum - malletInterval;
        sendMalletTick(st, input);
      }
    }

    // ── Visuals: mallets ──
    const playing = s !== null && s.status === 'playing';
    for (const side of ['a', 'b'] as const) {
      if (input?.side === side && iAmClaimant) {
        // My own mallet: direct, zero-latency.
        st.handle.setMallet(side, input.x, input.z, input.down && input.locked, true);
        continue;
      }
      const rm = st.remoteMallet[side];
      const claimed = s !== null && s.players[side] !== null;
      if (rm && claimed && now - rm.lastAt < REMOTE_STALE_MS) {
        const k = 1 - Math.exp(-MALLET_DISPLAY_RATE * dt);
        rm.dispX += (rm.x - rm.dispX) * k;
        rm.dispZ += (rm.z - rm.dispZ) * k;
        st.handle.setMallet(side, rm.dispX, rm.dispZ, rm.down, true);
      } else {
        st.handle.setMallet(side, 0, side === 'a' ? -0.9 : 0.9, false, false);
      }
    }

    // ── Visuals: puck ──
    if (operator) {
      if (st.puckActive) {
        st.handle.setPuck(st.puck.x, st.puck.z, true);
      } else if (playing && s) {
        const sp = servePosition(s);
        st.handle.setPuck(sp.x, sp.z, true); // serve telegraph
      } else {
        st.handle.setPuck(0, 0, false);
      }
    } else {
      const rp = st.remotePuck;
      if (rp && playing && now - rp.lastAt < REMOTE_STALE_MS) {
        // Dead-reckon between 20 Hz ticks (no collision — the clamp keeps a
        // mid-window wall bounce to a small overshoot the blend swallows).
        const age = Math.min(PUCK_EXTRAPOLATE_MAX_S, Math.max(0, (now - rp.lastAt) / 1000));
        const tx = Math.max(-(AH_HALF_W - AH_PUCK_R), Math.min(AH_HALF_W - AH_PUCK_R,
          rp.x + (rp.active ? rp.vx * age : 0)));
        const tz = Math.max(-(AH_HALF_L + AH_PUCK_R), Math.min(AH_HALF_L + AH_PUCK_R,
          rp.z + (rp.active ? rp.vz * age : 0)));
        const k = 1 - Math.exp(-PUCK_DISPLAY_RATE * dt);
        rp.dispX += (tx - rp.dispX) * k;
        rp.dispZ += (tz - rp.dispZ) * k;
        st.handle.setPuck(rp.dispX, rp.dispZ, true);
      } else {
        st.handle.setPuck(0, 0, false);
      }
    }

    // ── Visuals: scoreboard + goal lamps (doc-driven — identical on every
    // client, operator or spectator; setScore dedupes internally). ──
    st.handle.setScore(s?.score.a ?? 0, s?.score.b ?? 0, scoreboardLine(s, now, serveDue));
    if (s && st.prevScore && s.startedAt === st.prevScore.startedAt) {
      // withGoal increments the SCORER; the lamp lights at the scored-on end.
      if (s.score.a > st.prevScore.a) st.handle.flashGoal('b');
      else if (s.score.b > st.prevScore.b) st.handle.flashGoal('a');
    }
    st.prevScore = s ? { a: s.score.a, b: s.score.b, startedAt: s.startedAt } : null;

    st.handle.update(dt);
  }
}

/** Pole-scoreboard status line (≤26 chars — the painter slices anyway). */
function scoreboardLine(s: AirHockeyState | null, now: number, serveDue: number): string {
  if (!s || (s.status === 'waiting' && !s.players.a && !s.players.b)) {
    return 'STAND AT AN END TO PLAY';
  }
  if (s.status === 'waiting') {
    return s.players.a && s.players.b ? 'READY UP TO START' : 'WAITING FOR CHALLENGER';
  }
  if (s.status === 'ended') {
    const w = s.winner === 'a' ? 'CYAN' : 'ORANGE';
    const byForfeit = Math.max(s.score.a, s.score.b) < AH_GOALS_TO_WIN;
    return byForfeit ? `${w} WINS BY FORFEIT` : `${w} WINS`;
  }
  if (serveDue > now) return `SERVE IN ${Math.ceil((serveDue - now) / 1000)}`;
  return isVersus(s) ? `FIRST TO ${AH_GOALS_TO_WIN}` : 'PRACTICE';
}

// ── Focused DOM UI (HUD only — the game lives on the in-world table) ─────────

export interface AirHockeyUIDeps {
  /** Furniture item id — doc key + session key. */
  itemId: string;
  /** The END the player walked to (world.ts picks the free stand). */
  side: AirHockeySide;
}

const AH_UI_CYAN = '#35c8e8';
const AH_UI_ORANGE = '#e8933a';
const AH_UI_GOLD = '#d4a84b';
const AH_UI_GOLD_BRIGHT = '#F0C060';

const sideName = (sd: AirHockeySide): string => (sd === 'a' ? 'CYAN' : 'ORANGE');
const sideColor = (sd: AirHockeySide): string => (sd === 'a' ? AH_UI_CYAN : AH_UI_ORANGE);

/**
 * One seat row of the focused HUD: the markup the card's innerHTML takes.
 * #116 review fix: the player's display name is peer-writable, so it is
 * escaped here, before it reaches the DOM, and cut to the name limit first:
 * the row is built every frame, and a peer's name can be any length. The
 * rest is fixed strings.
 */
export function airHockeySeatRowHtml(
  s: AirHockeyState | null,
  sd: AirHockeySide,
  thisEnd: AirHockeySide,
  myId: string,
  displayName: (playerId: string) => string,
): string {
  const pid = s?.players[sd] ?? null;
  const name = pid ? displayName(pid).slice(0, PLAYER_NAME_MAX_LENGTH) : '';
  const label = pid
    ? `${escapeHtml(name.toUpperCase())}${pid === myId ? ' (YOU)' : ''}${s?.ready[sd] ? ' · READY' : ''}`
    : 'OPEN';
  return `
      <div style="flex:1; display:flex; align-items:center; gap:8px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:6px 10px;">
        <span style="width:10px; height:10px; border-radius:50%; background:${sideColor(sd)}; flex:none;"></span>
        <span style="flex:1; font-size:10px; letter-spacing:1px; color:${AH_UI_GOLD};">${sideName(sd)}${sd === thisEnd ? ' (THIS END)' : ''} — ${label}</span>
      </div>`;
}

/**
 * The focused first-person HUD for one table end: claim/ready/practice
 * card at the bottom, score strip on top, and the pointer-lock capture layer
 * that turns the mouse into the mallet (#115's control scheme). Mounted by
 * deviceFocus after the walk-up + camera ease; ALL shared state lives in the
 * doc — the panel re-renders from observers, never from local truth.
 */
export function createAirHockeyUI(deps: AirHockeyUIDeps): DeviceUI {
  const myId = getPlayerId();
  const side = deps.side;
  let panel: HTMLDivElement | null = null;
  let captureLayer: HTMLDivElement | null = null;
  let topBar: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let prompt: HTMLDivElement | null = null;
  let unsubGames: (() => void) | null = null;
  let lastTopHtml = '';
  let lastCardHtml = '';

  /** The room this panel opened in, and the doc of that room it reads
   *  (casinoDocEpoch). Device focus can outlive a room change, and the next
   *  room may hold a table with this id: while another room is bound, the
   *  panel reads and writes nothing. When its own room is joined again with a
   *  new doc (a failed swap restores it, a node retry rejoins it), the panel
   *  follows that doc and takes up the mallet again. */
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
  const state = (): AirHockeyState | null => (live() ? readAirHockey(deps.itemId) : null);
  /** When this panel's table serves next, on this page's clock (servesAt). */
  const serveDue = (s: AirHockeyState, now: number): number => {
    const session = st();
    return session ? servesAt(session, s, now) : s.serveAt;
  };

  /** Does this page play this end? (playsSide: the claim, from this page.) */
  const plays = (s: AirHockeyState | null): s is AirHockeyState =>
    s !== null && playsSide(s, side, myId);

  /** May I drive the mallet right now? Claimed my end, game not over. */
  const canDrive = (): boolean => {
    const s = state();
    return plays(s) && s.status !== 'ended';
  };

  const locked = (): boolean =>
    captureLayer !== null && document.pointerLockElement === captureLayer;

  /** Engage the table's session in the room's current doc: my mallet spawns
   *  mid-defence, raised. */
  const engage = (): void => {
    const session = sessionFor(deps.itemId);
    if (!session) return;
    const start = clampMallet(side, 0, side === 'a' ? -0.9 : 0.9);
    session.engaged = {
      side,
      x: start.x,
      z: start.z,
      vx: 0,
      vz: 0,
      prevX: start.x,
      prevZ: start.z,
      down: false,
      locked: locked(),
    };
  };

  // ── Doc transitions (read → pure engine → transacted write) ────────────────

  const doClaim = (): void => {
    if (!live()) return;
    // First claim may land on an untouched table — seed the initial state.
    const ns = claimSide(state() ?? initialAirHockeyState(), side, myId, PAGE_SEAT);
    if (ns) writeGame(deps.itemId, ns);
  };

  /** Play this end, which my player holds, from this page rather than the
   *  one it is played from (another tab or device, or this tab before a
   *  reload). That page stops playing it. */
  const doPlayHere = (): void => {
    const s = state();
    if (!s) return;
    const ns = takeSeat(s, side, myId, PAGE_SEAT);
    if (ns) writeGame(deps.itemId, ns);
  };

  const doReady = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'waiting' || s.ready[side]) return;
    const ns = setReady(s, side, myId);
    if (!ns) return;
    writeGame(deps.itemId, ns);
    // Second readier promotes the start directly (frame loop is the backstop).
    const after = state();
    if (after) {
      const started = startIfReady(after, Date.now());
      if (started) writeGame(deps.itemId, started);
    }
  };

  const doUnready = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'waiting' || !s.ready[side]) return;
    const ns = setUnready(s, side, myId);
    if (ns) writeGame(deps.itemId, ns);
  };

  const doPractice = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'waiting') return;
    if (s.players[otherSide(side)] !== null) return;
    const ns = startPractice(s, side, myId, Date.now());
    if (ns) writeGame(deps.itemId, ns);
  };

  const doForfeit = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'playing') return;
    if (!isVersus(s)) {
      writeGame(deps.itemId, initialAirHockeyState()); // end practice → open table
      return;
    }
    const ns = withForfeit(s, otherSide(side));
    if (ns) writeGame(deps.itemId, ns);
  };

  /** RESET/NEW MATCH gate (checkers canReset precedent): anyone once ended;
   *  participants or the room owner otherwise (recovers crash-leaked claims). */
  const canReset = (s: AirHockeyState | null): boolean => {
    if (!s) return false;
    if (s.status === 'ended') return true;
    return s.players.a === myId || s.players.b === myId || readRoomOwner() === myId;
  };

  const doReset = (): void => {
    const s = state();
    if (!canReset(s)) return;
    writeGame(deps.itemId, initialAirHockeyState());
  };

  // ── Pointer lock + mouse → mallet ──────────────────────────────────────────

  const syncEngagedLock = (): void => {
    const session = st();
    if (session?.engaged) session.engaged.locked = locked();
  };

  const onLockChange = (): void => {
    const session = st();
    if (!locked() && session?.engaged) session.engaged.down = false; // lift on release
    syncEngagedLock();
    render();
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!locked()) return;
    const session = st();
    const input = session?.engaged;
    if (!input || !canDrive()) return;
    // Screen→table mapping. The focus camera looks along the table from the
    // engaged end, so in LOCAL coords the basis is fixed per side (item
    // rotation turns table AND camera together, cancelling out): from side
    // a's seat screen-right is local −x and screen-up pushes local +z;
    // side b mirrors both. (Derived from cross(view, up) — see plan notes.)
    const sx = side === 'a' ? -1 : 1;
    const nx = input.x + e.movementX * MOUSE_SENS * sx;
    const nz = input.z + -e.movementY * MOUSE_SENS * -sx;
    const c = clampMallet(side, nx, nz);
    input.x = c.x;
    input.z = c.z;
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (!locked() || e.button !== 0) return;
    const session = st();
    if (session?.engaged && canDrive()) session.engaged.down = true; // mallet DOWN
  };

  const onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const session = st();
    if (session?.engaged) session.engaged.down = false; // lift
  };

  const onCaptureClick = (e: MouseEvent): void => {
    e.stopPropagation(); // never a click-away release
    if (locked() || !canDrive() || !captureLayer) return;
    // Chrome throttles re-locks right after an Esc — swallow the rejection,
    // the prompt simply stays up for the retry.
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
      color: ${disabled ? '#4A5560' : AH_UI_GOLD_BRIGHT};
      font-family: inherit;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 1.5px;
      cursor: ${disabled ? 'not-allowed' : 'pointer'};
      opacity: ${disabled ? '0.5' : '1'};
    ">${label}</button>`;

  const seatRow = (s: AirHockeyState | null, sd: AirHockeySide): string =>
    airHockeySeatRowHtml(s, sd, side, myId, readPlayerDisplayName);

  const renderTop = (): void => {
    if (!topBar) return;
    const s = state();
    const now = Date.now();
    let status: string;
    if (!s) status = 'TAKE THIS END TO PLAY';
    else if (s.status === 'waiting') status = s.players.a && s.players.b ? 'READY UP TO START' : 'WAITING FOR A CHALLENGER';
    else if (s.status === 'ended') {
      const w = s.winner === 'a' ? 'CYAN' : 'ORANGE';
      status = `${w} WINS${Math.max(s.score.a, s.score.b) < AH_GOALS_TO_WIN ? ' BY FORFEIT' : ''}`;
    } else if (serveDue(s, now) > now) status = `SERVE IN ${Math.ceil((serveDue(s, now) - now) / 1000)}…`;
    else status = isVersus(s) ? `FIRST TO ${AH_GOALS_TO_WIN}` : 'PRACTICE — SHOOT AT EITHER GOAL';
    const down = st()?.engaged?.down === true;
    const html = `
      <div style="display:flex; align-items:baseline; gap:14px; justify-content:center;">
        <span style="font-size:15px; font-weight:800; color:${AH_UI_CYAN}; letter-spacing:1px;">CYAN ${s?.score.a ?? 0}</span>
        <span style="font-size:11px; color:rgba(212,168,75,0.6);">—</span>
        <span style="font-size:15px; font-weight:800; color:${AH_UI_ORANGE}; letter-spacing:1px;">${s?.score.b ?? 0} ORANGE</span>
      </div>
      <div style="text-align:center; font-size:10px; letter-spacing:1.5px; color:${AH_UI_GOLD}; margin-top:3px;">${status}</div>
      ${locked() ? `<div style="text-align:center; font-size:9px; letter-spacing:1px; color:${down ? AH_UI_GOLD_BRIGHT : 'rgba(212,168,75,0.55)'}; margin-top:2px;">MALLET ${down ? '● DOWN' : '○ RAISED — HOLD MOUSE TO PLANT'} · ESC TO LET GO</div>` : ''}`;
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

    // Centre prompt: visible whenever I could be driving but the mouse is free.
    const showPrompt = canDrive() && !locked();
    prompt.style.display = showPrompt ? 'flex' : 'none';

    // While the pointer is locked the mouse IS the mallet — hide the card so
    // the table stays clear; Esc surfaces it again.
    card.style.display = locked() ? 'none' : 'flex';
    if (locked()) return;

    const mine = plays(s);
    // My player holds this end, but another page plays it: another tab or
    // device, or this tab before a reload. PLAY HERE moves it to this page.
    const mineElsewhere = s !== null && s.players[side] === myId && !mine;
    const otherPid = s?.players[otherSide(side)] ?? null;

    // A claim or a practice whose player walked off (a closed tab, a room
    // left mid-focus) holds the table until someone clears it: canReset says
    // who may, before the match has ended too.
    const resetTable = (table: AirHockeyState): string => (canReset(table)
      ? btn('ah-reset', 'RESET TABLE', false, 'Clear the table, freeing an end its player left')
      : '');
    const playHere = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">YOU HOLD THIS END FROM ANOTHER TAB OR DEVICE</span>
          ${btn('ah-here', 'PLAY HERE', false, 'Play this end from this tab instead')}
        </div>`;

    let actions = '';
    if (!s || s.status === 'waiting') {
      const takenByOther = s !== null && s.players[side] !== null && s.players[side] !== myId;
      const iHoldOther = s !== null && s.players[otherSide(side)] === myId;
      if (takenByOther) {
        actions = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">THIS END IS TAKEN — WALK AROUND TO THE OTHER END</span>
          ${resetTable(s)}
        </div>`;
      } else if (mineElsewhere) {
        actions = playHere;
      } else if (iHoldOther) {
        actions = `<div style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">YOU HOLD THE OTHER END — WALK BACK AROUND</div>`;
      } else if (!mine) {
        actions = `<div style="display:flex; gap:8px; align-items:center;">
          ${btn('ah-claim', `TAKE THE ${sideName(side)} END`, false, 'Claim this end of the table')}
        </div>`;
      } else {
        const ready = s.ready[side];
        actions = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${ready
            ? btn('ah-unready', 'UNREADY', false, 'Step back from ready')
            : btn('ah-ready', 'READY UP', false, 'Lock in — the match starts when both ends are ready')}
          ${otherPid === null && !ready
            ? btn('ah-practice', 'PRACTICE ALONE', false, 'Free-play against both goals until someone joins')
            : ''}
          ${btn('ah-leave', 'LEAVE TABLE', false, 'Release this end')}
        </div>`;
      }
    } else if (s.status === 'playing') {
      actions = mine
        ? `<div style="display:flex; gap:8px;">${btn('ah-forfeit', isVersus(s) ? 'FORFEIT MATCH' : 'END PRACTICE', false, isVersus(s) ? 'Concede — your opponent takes the win' : 'Stop practising and open the table')}</div>`
        : mineElsewhere ? playHere : `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span style="font-size:10px; color:rgba(212,168,75,0.75); letter-spacing:1px;">MATCH IN PROGRESS — SPECTATING</span>
          ${resetTable(s)}
        </div>`;
    } else {
      actions = `<div style="display:flex; gap:8px; align-items:center;">
        <span style="font-size:11px; font-weight:800; letter-spacing:1px; color:${s.winner ? sideColor(s.winner) : AH_UI_GOLD};">${s.winner ? `${sideName(s.winner)} TAKES IT ${s.score.a}–${s.score.b}` : 'MATCH OVER'}</span>
        ${btn('ah-reset', 'NEW MATCH', !canReset(s), 'Clear the table for the next pair')}
      </div>`;
    }

    const html = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:12px; font-weight:800; color:${AH_UI_GOLD_BRIGHT}; letter-spacing:1px;">🏒 AIR HOCKEY</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD TO STEP BACK</span>
      </div>
      <div style="display:flex; gap:8px;">${seatRow(s, 'a')}${seatRow(s, 'b')}</div>
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
      case 'ah-claim': doClaim(); break;
      case 'ah-ready': doReady(); break;
      case 'ah-unready': doUnready(); break;
      case 'ah-practice': doPractice(); break;
      case 'ah-forfeit': doForfeit(); break;
      case 'ah-reset': doReset(); break;
      case 'ah-here': doPlayHere(); break;
      case 'ah-leave': leaveSide(); render(); break;
    }
  };

  /** Give up my claim — the LEAVE button and the waiting-state unmount share
   *  this. */
  const leaveSide = (): void => {
    const s = state();
    if (!plays(s) || s.status !== 'waiting') return;
    const ns = releaseSide(s, side, myId);
    if (ns) writeGame(deps.itemId, ns);
  };

  return {
    mount(host: HTMLElement): void {
      mountRoom = activeRoomId();
      mountEpoch = casinoDocEpoch();
      panel = document.createElement('div');
      panel.id = 'device-airhockey-pane';
      // Full-viewport transparent shell — the 3D table IS the game surface;
      // children opt back into pointer events individually.
      panel.style.cssText = `
        position: absolute; inset: 0;
        pointer-events: none;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        color: ${AH_UI_GOLD};
      `;

      // Stable pointer-lock target — NEVER re-rendered (innerHTML churn on
      // an ancestor would drop an active lock mid-rally).
      captureLayer = document.createElement('div');
      captureLayer.id = 'ah-capture';
      captureLayer.style.cssText = `
        position: absolute; inset: 0;
        pointer-events: auto;
        cursor: crosshair;
      `;
      captureLayer.addEventListener('click', onCaptureClick);
      // #116 review fix: the capture layer IS the pointer-lock target, so a
      // locked mousedown fires HERE and — because it bubbles to document —
      // gets swallowed by zoom.ts's "click-while-locked exits pointer lock"
      // handler unless we stopPropagation. But we ALSO need onMouseDown to
      // run so engaged.down flips to true (mallet press). Forward the event
      // to the same handler BEFORE stopping propagation; mouseup mirrors it
      // so a fast release inside the layer never leaves the mallet planted.
      captureLayer.addEventListener('mousedown', (e) => {
        onMouseDown(e);
        e.stopPropagation();
      });
      captureLayer.addEventListener('mouseup', (e) => {
        onMouseUp(e);
        e.stopPropagation();
      });
      panel.appendChild(captureLayer);

      topBar = document.createElement('div');
      topBar.style.cssText = `
        position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
        min-width: 320px; padding: 10px 22px;
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
        <div style="font-size:16px; font-weight:800; letter-spacing:2px; color:${AH_UI_GOLD_BRIGHT};">CLICK TO GRAB MALLET</div>
        <div style="font-size:10px; letter-spacing:1.5px; color:rgba(240,192,96,0.75);">HOLD MOUSE = MALLET DOWN · RELEASE = LIFT</div>`;
      panel.appendChild(prompt);

      card = document.createElement('div');
      card.style.cssText = `
        position: absolute; bottom: 22px; left: 50%; transform: translateX(-50%);
        width: 560px; max-width: 94vw; max-height: 44vh; overflow-y: auto;
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
      document.addEventListener('mouseup', onMouseUp);
      unsubGames = subscribeGames(() => render());
      render();
    },

    unmount(): void {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      if (locked()) document.exitPointerLock();
      unsubGames?.();
      unsubGames = null;

      // Walk-away semantics per state:
      //  waiting  → release the end;
      //  practice → abandon: reopen the table;
      //  versus   → KEEP the claim: my ticks stop, the opponent's forfeit
      //             clock takes the match from here (#115 walkover);
      //  ended    → leave the result standing for NEW MATCH.
      // Only the page that plays the end walks away with it: stepping back
      // from a page that doesn't leaves the end to the page that does.
      const s = state();
      const session = st();
      if (plays(s)) {
        if (s.status === 'waiting') {
          leaveSide();
        } else if (s.status === 'playing' && !isVersus(s)) {
          writeGame(deps.itemId, initialAirHockeyState());
        }
      }
      if (session?.engaged?.side === side) {
        // One last "lifted" tick so remote mallets rise instead of freezing
        // planted for the 2 s stale window.
        session.engaged.down = false;
        if (plays(s) && s.status !== 'ended') {
          sendMalletTick(session, session.engaged);
        }
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
      // Time-driven text only (the serve countdown) — the HTML
      // diff in render() makes the per-frame call cheap; doc changes repaint
      // via the observers.
      render();
    },
  };
}

// Permanent debug handle (the __ssfGames / __ssfCasino precedent): console
// inspection of live session state + manual tick injection during play tests.
(window as unknown as { __ssfAirHockey: unknown }).__ssfAirHockey = {
  sessions,
  routeAirHockeyTick,
  frame: airHockeyFrame,
};
