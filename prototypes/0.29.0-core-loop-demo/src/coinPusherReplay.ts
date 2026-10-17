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
  CHIP_R, dropStartMs, PLAT_LOW_FRONT, PLAT_UP_FRONT, RECENT_DROPS_MAX, traceDrop,
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
 *  `s` runs 0 → 1 from leaving the board to landing at (landX, landU). */
export interface ChutePose {
  chipId: number;
  s: number;
  exitU: number;
  spin: number;
  landX: number;
  landU: number;
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
        add(id, { kind: 'tip', t: prevT, from: was });
        endMs = Math.max(endMs, prevT + TIP_MS);
      }
      if (!was.lower && now.lower) {
        add(id, { kind: 'step', t: prevT, from: was });
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
  const lip = PLAT_LOW_FRONT + CHIP_R;
  const x = lerp(Math.max(from.x, lip - CHIP_R), lip + 2 * CHIP_R, s);
  const y = lerp(from.y, -geom.trayDrop + geom.level / 2, s * s);
  return { chipId: id, x, u: from.u, y, tip: 0 };
}

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
      const cur = table.get(id);
      if (!cur || t >= tr.t + dur) continue;
      const s = (t - tr.t) / dur;
      if (tr.kind === 'tip') {
        // Over on its front edge: it lifts off its foot and falls flat.
        table.set(id, { ...blend(from, cur, s), tip: 1 - s * s });
      } else {
        // Off the upper front: forward along the platform, then down.
        const edge = Math.max(from.x, PLAT_UP_FRONT);
        table.set(id, {
          ...blend(from, cur, s),
          x: s < 0.4 ? lerp(from.x, edge, s / 0.4) : lerp(edge, cur.x, (s - 0.4) / 0.6),
          y: s < 0.4 ? from.y : lerp(from.y, cur.y, ((s - 0.4) / 0.6) ** 2),
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
    const last = trace.board[trace.board.length - 1];
    chute = {
      chipId: trace.chipId, s: (t - trace.fallMs) / (trace.landMs - trace.fallMs),
      exitU: last.u, spin: last.spin, landX: trace.landX, landU: trace.landU,
    };
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
 * board, a gap, a new or emptied machine): the cabinet then just draws the
 * record.
 */
export function planDrops(prev: CoinPusherState, next: CoinPusherState, geom: ReplayGeometry): ScheduledReplay[] | null {
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
