/**
 * 🪙 Coin pusher replay — where every chip is drawn, frame by frame.
 *
 * The machine record only ever holds a machine at rest (games/coinPusher.ts),
 * so a cabinet that drew just the record would show each drop as a jump. It
 * replays the drop instead: traceDrop gives the coin's path down the drop
 * board and the table after every physics substep, and this module turns that
 * into a pose for every chip at any moment — the coin falling and spinning
 * down the board, dropping the chute, standing on its edge in front of the
 * bar, tipping over when pushed, sliding, stepping off the upper platform and
 * falling into the tray.
 *
 * Pure (no THREE / DOM / clock), in engine units: the cabinet (furniture.ts)
 * maps a pose into the model. A table pose's `y` is the height of the chip's
 * centre above the UPPER platform's top, so a chip on the lower platform has
 * y below zero.
 */

import {
  CHIP_R, dropStartMs, PLAT_LOW_FRONT, PLAT_UP_FRONT, PUSHER_PERIOD_MS, pusherFaceX, RECENT_DROPS_MAX, traceDrop,
  type CoinPusherState, type DropTrace, type Pile,
} from './games/coinPusher';

/** The cabinet's own heights, in engine units. */
export interface ReplayGeometry {
  /** How far the lower platform's top sits below the upper's. */
  lowerDrop: number;
  /** How far the payout tray's floor sits below the upper platform's top. */
  trayDrop: number;
  /** Rise from one chip in a stack to the next (its thickness and a hair). */
  level: number;
  /** The top of the pusher bar above the upper platform. */
  barTop: number;
  /** Where a coin leaves the bottom of the drop board: back along the table
   *  (x, behind the platform: negative) and its centre's height. */
  boardExitX: number;
  boardExitY: number;
}

/** A chip on the table (or tipping, stepping down, falling to the tray). */
export interface TablePose {
  chipId: number;
  x: number;
  u: number;
  y: number;
  /** 1 standing on its edge face to the player, 0 lying flat. */
  tip: number;
}

/** The dropped coin on its way down the board. */
export interface BoardPose {
  chipId: number;
  u: number;
  h: number;
  spin: number;
}

/** The dropped coin between the bottom of the board and the platform:
 *  `s` runs 0 → 1 from leaving the board to landing at (landX, landU). It
 *  is standing, at (x, u) with its centre `y` above the upper platform. */
export interface ChutePose {
  chipId: number;
  s: number;
  exitU: number;
  spin: number;
  landX: number;
  landU: number;
  x: number;
  u: number;
  y: number;
}

/**
 * The coin down the chute, `t` ms after it went in: off the bottom of the
 * board onto the pusher bar's top, forward along it, and off its front edge
 * onto the platform, standing, at the landing. It drops below the bar's top
 * only once its back is past the bar's face, and while it does it keeps in
 * front of the face — which, on a retracting stroke, is still over the spot
 * it lands on until the moment it lands.
 */
function chutePose(trace: DropTrace, t: number, geom: ReplayGeometry): ChutePose {
  const last = trace.board[trace.board.length - 1];
  const s = (t - trace.fallMs) / (trace.landMs - trace.fallMs);
  const shelf = geom.barTop + CHIP_R;
  const half = geom.level / 2;
  const midX = lerp(geom.boardExitX, trace.landX, 0.5);
  let x: number;
  let y: number;
  if (s < 0.5) {
    const d = s / 0.5;
    x = lerp(geom.boardExitX, midX, d);
    y = lerp(geom.boardExitY, shelf, d * d);
  } else if (s < 0.75) {
    x = lerp(midX, trace.landX, (s - 0.5) / 0.25);
    y = shelf;
  } else {
    const d = (s - 0.75) / 0.25;
    x = Math.max(trace.landX, pusherFaceX(trace.phase + t / PUSHER_PERIOD_MS) + half);
    y = lerp(shelf, CHIP_R, d * d);
  }
  return {
    chipId: trace.chipId, s, exitU: last.u, spin: last.spin, landX: trace.landX, landU: trace.landU,
    x, u: lerp(last.u, trace.landU, s), y,
  };
}

export interface ReplayView {
  table: TablePose[];
  board: BoardPose | null;
  chute: ChutePose | null;
  /** The replay is over: draw the machine record itself from now on. */
  done: boolean;
}

/** How long the cabinet draws a chip tipping over, stepping off the upper
 *  platform and falling into the tray (ms). The physics makes each in one
 *  substep; drawn that fast none of them could be seen. */
export const TIP_MS = 180;
export const STEP_MS = 240;
export const PAY_MS = 420;

interface Placement {
  lower: boolean;
  x: number;
  u: number;
  level: number;
  standing: boolean;
}

interface Transition {
  kind: 'tip' | 'step' | 'pay';
  t: number;
  from: Placement;
  /** The substep frame that has it tipped or stepped down, and its time:
   *  until then the frames still have it as it was. */
  to?: Placement;
  toT?: number;
}

interface Frame {
  t: number;
  chips: Map<number, Placement>;
}

export interface Replay {
  trace: DropTrace;
  geom: ReplayGeometry;
  /** The table before the coin lands. */
  before: Map<number, Placement>;
  frames: Frame[];
  /** Every chip's tip, step and payout, in time order. */
  transitions: Map<number, Transition[]>;
  /** When the last of it has been drawn (ms after the coin went in). */
  endMs: number;
}

function placements(upper: Pile[], lower: Pile[]): Map<number, Placement> {
  const out = new Map<number, Placement>();
  for (const [piles, isLower] of [[upper, false], [lower, true]] as const) {
    for (const p of piles) {
      p.chipIds.forEach((id, level) => {
        out.set(id, { lower: isLower, x: p.x, u: p.u ?? 0, level, standing: p.standing === true });
      });
    }
  }
  return out;
}

function poseOf(id: number, p: Placement, geom: ReplayGeometry): TablePose {
  const base = p.lower ? -geom.lowerDrop : 0;
  return p.standing
    ? { chipId: id, x: p.x, u: p.u, y: base + CHIP_R, tip: 1 }
    : { chipId: id, x: p.x, u: p.u, y: base + (p.level + 0.5) * geom.level, tip: 0 };
}

const lerp = (a: number, b: number, s: number): number => a + (b - a) * s;

/** How far below its centre a chip turned `a` from flat (π/2 standing on its
 *  edge) reaches: the rim's lowest point. */
export function reachBelow(a: number, geom: ReplayGeometry): number {
  return CHIP_R * Math.sin(a) + (geom.level / 2) * Math.cos(a);
}

/** How far behind its centre a chip turned `a` from flat reaches. */
export function reachBack(a: number, geom: ReplayGeometry): number {
  return CHIP_R * Math.cos(a) + (geom.level / 2) * Math.sin(a);
}

function backOf(p: TablePose, geom: ReplayGeometry): number {
  return p.x - reachBack(p.tip * Math.PI / 2, geom);
}

/** The surface a chip at rest is lying or standing on. */
function surfaceUnder(p: TablePose, geom: ReplayGeometry): number {
  return p.y - reachBelow(p.tip * Math.PI / 2, geom);
}

function blend(a: TablePose, b: TablePose, s: number): TablePose {
  return { chipId: a.chipId, x: lerp(a.x, b.x, s), u: lerp(a.u, b.u, s), y: lerp(a.y, b.y, s), tip: lerp(a.tip, b.tip, s) };
}

/** Prepare a drop for replay: `before` is the machine just before it. */
export function planReplay(before: CoinPusherState, trace: DropTrace, geom: ReplayGeometry): Replay {
  const frames: Frame[] = trace.frames.map((f) => ({ t: f.t, chips: placements(f.upper, f.lower) }));
  const start = placements(before.upper, before.lower);
  const transitions = new Map<number, Transition[]>();
  const add = (id: number, tr: Transition) => {
    const list = transitions.get(id);
    if (list) list.push(tr);
    else transitions.set(id, [tr]);
  };
  let endMs = frames.length ? frames[frames.length - 1].t : trace.landMs;
  // The coin lands standing where the trace says; the landing's own settle
  // (frames[0]) may already have tipped it, which is a tip to draw too.
  let prev = new Map(start);
  prev.set(trace.chipId, { lower: false, x: trace.landX, u: trace.landU, level: 0, standing: true });
  let prevT = trace.landMs;
  for (const frame of frames) {
    for (const [id, was] of prev) {
      const now = frame.chips.get(id);
      if (!now) {
        add(id, { kind: 'pay', t: prevT, from: was });
        endMs = Math.max(endMs, prevT + PAY_MS);
        continue;
      }
      if (was.standing && !now.standing) {
        add(id, { kind: 'tip', t: prevT, from: was, to: now, toT: frame.t });
        endMs = Math.max(endMs, prevT + TIP_MS);
      }
      if (!was.lower && now.lower) {
        add(id, { kind: 'step', t: prevT, from: was, to: now, toT: frame.t });
        endMs = Math.max(endMs, prevT + STEP_MS);
      }
    }
    prev = frame.chips;
    prevT = frame.t;
  }
  return { trace, geom, before: start, frames, transitions, endMs };
}

/** The table at `t` ms after the coin went in, from the substep frames. */
function framePoses(replay: Replay, t: number): Map<number, TablePose> {
  const { frames, geom } = replay;
  const out = new Map<number, TablePose>();
  if (t < replay.trace.landMs || frames.length === 0) {
    for (const [id, p] of replay.before) out.set(id, poseOf(id, p, geom));
    return out;
  }
  let k = 0;
  while (k + 1 < frames.length && frames[k + 1].t <= t) k++;
  const a = frames[k];
  const b = frames[k + 1];
  const s = b ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  for (const [id, p] of a.chips) {
    const pa = poseOf(id, p, geom);
    const q = b?.chips.get(id);
    // Moving along the same platform, the same way up: slide between the
    // substeps. Anything else is a transition, drawn on its own.
    out.set(id, q && q.lower === p.lower && q.standing === p.standing ? blend(pa, poseOf(id, q, geom), s) : pa);
  }
  return out;
}

/** Where a chip falling into the tray is drawn, `s` of the way there. */
function payPose(id: number, from: TablePose, s: number, geom: ReplayGeometry): TablePose {
  // Off the front along the deck until its back is past the lip, then down.
  const clear = Math.max(from.x, PLAT_LOW_FRONT + CHIP_R);
  if (s < EDGE_SHARE) return { chipId: id, x: lerp(from.x, clear, s / EDGE_SHARE), u: from.u, y: from.y, tip: 0 };
  const d = (s - EDGE_SHARE) / (1 - EDGE_SHARE);
  return {
    chipId: id, x: lerp(clear, clear + CHIP_R, d), u: from.u,
    y: lerp(from.y, -geom.trayDrop + geom.level / 2, d * d), tip: 0,
  };
}

/** The share of a step down or a payout spent sliding over the edge before
 *  the chip falls: it falls only once its back is past the edge, so it never
 *  dips into the platform it is leaving. */
const EDGE_SHARE = 0.4;

/** Everything the cabinet draws `t` ms after the drop's coin went in. */
export function replayView(replay: Replay, t: number): ReplayView {
  const { trace, geom } = replay;
  const table = framePoses(replay, t);
  for (const [id, list] of replay.transitions) {
    for (const tr of list) {
      if (t < tr.t) continue;
      const from = poseOf(id, tr.from, geom);
      if (tr.kind === 'pay') {
        if (t < tr.t + PAY_MS) table.set(id, payPose(id, from, (t - tr.t) / PAY_MS, geom));
        continue;
      }
      const dur = tr.kind === 'tip' ? TIP_MS : STEP_MS;
      const live = table.get(id);
      if (!live || t >= tr.t + dur) continue;
      // Where it is going: the frame that has it over or down, then the
      // frames after it.
      const cur = tr.to && tr.toT !== undefined && t < tr.toT ? poseOf(id, tr.to, geom) : live;
      const s = (t - tr.t) / dur;
      if (tr.kind === 'tip') {
        // Over on its front edge: it rolls onto it and falls flat, its centre
        // as high above what it rests on as the turned coin's lowest point
        // is below it — never into the deck. That support moves from the
        // platform it stood on to whatever it lands on, a stack or the lower
        // platform.
        const tip = 1 - s * s;
        const a = tip * Math.PI / 2;
        const support = lerp(surfaceUnder(from, geom), surfaceUnder(cur, geom), s);
        // And its back no further back than the back of where the physics
        // has it (ahead of the bar that pushed it), however far over it is.
        const x = Math.max(lerp(from.x, cur.x, s), backOf(cur, geom) + reachBack(a, geom));
        table.set(id, { ...blend(from, cur, s), x, y: support + reachBelow(a, geom), tip });
      } else {
        // Off the upper front: forward along the platform until its back is
        // past the edge, then down onto the lower one (which it lands on
        // clear of the edge too: dropToLower).
        const clear = Math.max(from.x, PLAT_UP_FRONT + CHIP_R);
        const d = (s - EDGE_SHARE) / (1 - EDGE_SHARE);
        table.set(id, {
          ...blend(from, cur, s),
          x: s < EDGE_SHARE ? lerp(from.x, clear, s / EDGE_SHARE) : lerp(clear, Math.max(cur.x, clear), d),
          y: s < EDGE_SHARE ? from.y : lerp(from.y, cur.y, d * d),
        });
      }
    }
  }
  let board: BoardPose | null = null;
  let chute: ChutePose | null = null;
  if (t < trace.fallMs) {
    const path = trace.board;
    let k = 0;
    while (k + 1 < path.length && path[k + 1].t <= t) k++;
    const a = path[k];
    const b = path[k + 1] ?? a;
    const s = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    board = { chipId: trace.chipId, u: lerp(a.u, b.u, s), h: lerp(a.h, b.h, s), spin: lerp(a.spin, b.spin, s) };
    table.delete(trace.chipId);
  } else if (t < trace.landMs) {
    chute = chutePose(trace, t, geom);
    table.delete(trace.chipId);
  }
  return { table: [...table.values()], board, chute, done: t >= replay.endMs };
}

/** The machine at rest, as the cabinet draws it outside a replay. */
export function restingView(state: CoinPusherState, geom: ReplayGeometry): TablePose[] {
  return [...placements(state.upper, state.lower)].map(([id, p]) => poseOf(id, p, geom));
}

/** A drop's replay and when its coin went in (by the shared sweep clock). */
export interface ScheduledReplay {
  plan: Replay;
  startMs: number;
}

/**
 * Every drop between two records the cabinet saw, each replayed from the
 * machine the one before it left: the operator can settle several drops
 * between two frames, and the record's recentDrops marks carry what replays
 * each. Null when any of them can't be replayed (a mark from before the drop
 * board, a gap, a new machine, one emptied in between): the cabinet then just draws the
 * record.
 */
export function planDrops(prev: CoinPusherState, next: CoinPusherState, geom: ReplayGeometry): ScheduledReplay[] | null {
  // Emptied in between (which keeps the chip ids and marks): the drops
  // after it ran on an empty machine, not on `prev`.
  if (next.totalEmptied !== prev.totalEmptied) return null;
  const n = next.nextChipId - prev.nextChipId;
  if (n <= 0 || n > RECENT_DROPS_MAX) return null;
  const marks = (next.recentDrops ?? []).filter((d) => d.chipId >= prev.nextChipId);
  if (marks.length !== n) return null;
  const out: ScheduledReplay[] = [];
  let before = prev;
  for (const mark of marks) {
    if (mark.phase === undefined || mark.atMs === undefined) return null;
    const trace = traceDrop(before, mark);
    if (!trace) return null;
    out.push({ plan: planReplay(before, trace, geom), startMs: dropStartMs(next, { phase: mark.phase, atMs: mark.atMs }) });
    before = trace.after;
  }
  return out;
}

/** How many drops a cabinet replays at once. A replay lasts its coin's fall
 *  (a second or two, up to BOARD_MAX_MS) plus a pusher cycle, and holds the
 *  table after each of its few dozen substeps; this keeps a crowd dropping
 *  several chips a second all drawn, and the memory bounded. Past it the
 *  oldest goes, as the history of drops (RECENT_DROPS_MAX) never needs to:
 *  that only covers what settles between two frames. */
export const REPLAY_MAX = 32;

/**
 * A new record seen: every drop since the one before queued behind the
 * replays still playing, and those that are over by `now` left out. When the
 * new drops can't all be replayed (planDrops), the queue is dropped and the
 * cabinet draws the record.
 */
export function queueDrops(
  replays: readonly ScheduledReplay[], prev: CoinPusherState, next: CoinPusherState, now: number, geom: ReplayGeometry,
): ScheduledReplay[] {
  const planned = planDrops(prev, next, geom);
  if (!planned) return [];
  return [...replays, ...planned.filter((r) => now - r.startMs < r.plan.endMs)].slice(-REPLAY_MAX);
}

/** Everything the cabinet draws while drops are replaying: the table, and
 *  every coin still on the board or down the chute. */
export interface CabinetView {
  table: TablePose[];
  boards: BoardPose[];
  chutes: ChutePose[];
}

/**
 * The cabinet's view at `now` of the drops it is replaying, oldest first, and
 * which of them are still going. Each drop's physics ran on the machine the
 * one before it left, so the table comes from the latest drop whose coin has
 * landed — which cuts short any earlier drop's settle still playing — or,
 * while none has, from the oldest's table before its coin; the coins on the
 * board and down the chute come from every drop. Null when all are over:
 * draw the machine record.
 */
export function cabinetView(replays: readonly ScheduledReplay[], now: number): { view: CabinetView | null; live: ScheduledReplay[] } {
  const views = replays.map((r) => replayView(r.plan, Math.max(0, now - r.startMs)));
  const landed = replays.map((r) => now - r.startMs >= r.plan.trace.landMs);
  const k = landed.lastIndexOf(true);
  const live = replays.filter((_, i) => (i < k ? !landed[i] : !views[i].done));
  if (live.length === 0) return { view: null, live };
  const base = views[Math.max(0, k)];
  const falling = views.filter((_, i) => !landed[i]);
  const boards = falling.flatMap((v) => (v.board ? [v.board] : []));
  const chutes = falling.flatMap((v) => (v.chute ? [v.chute] : []));
  const inFlight = new Set([...boards, ...chutes].map((c) => c.chipId));
  return { view: { table: base.table.filter((p) => !inFlight.has(p.chipId)), boards, chutes }, live };
}
