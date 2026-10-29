/**
 * 🧪🤖 The robot at the players' tables, watched in the simulated room
 * (computedSim) — for specs only; no app code imports it.
 *
 * Every frame of every page, after its tables' duties, the robot frame runs
 * as World runs it for a table that runs itself (computedRobot): the
 * table's level (nobody stands in a sim), then its call, which the page
 * says or drops (an idle table's) and notes either way. Nothing it does
 * may write to the room (R7). Each call and level is held, as it comes, to
 * the design's own rules, kept here by the harness and never read from the
 * robot's memory:
 *
 * - R1, it calls what it shows: a result call names the round and value
 *   the page's view shows, in the words the design gives for it (a harness
 *   copy of the format, filled from the view, which the checkers hold to
 *   their own working out: computedSim workOut, computedCrapsSim viewCheck).
 * - R2, each decision once: no round and value called twice with no other
 *   value between; every result the page's screen changes to is called
 *   (during its show, or as a correction once the next round is under way),
 *   within the hold's 8 s at most, unless another change takes its place
 *   first; a void during its show. Unless its records waited for their
 *   check meanwhile, or the page slept: a wake counts what it showed before
 *   as said (a frame whose records wait for their check too), but a result
 *   still coming (its dice in the air, or the frame a drawn table waits for
 *   its felt), which is due again from the wake, or silent if its show
 *   passed meanwhile.
 * - R3, nothing before the checks: no call before the page's first frame
 *   of the incarnation whose records were whole and checked, and not
 *   showing a decided round held again for its forfeit's grace (a load
 *   shows the last one so: the robot waits for its show); none either
 *   while a record that came since waits for its check.
 * - R4, one open and one close per window (the window the harness saw
 *   opened, the close naming it); at craps, time's up at most once a roll,
 *   never once its result was called, only while its roll is on screen
 *   (closing or on show), and only once a wait for the throw the page saw
 *   in that window has run out.
 * - R5, corrections only for rounds the page called (or found on show as
 *   it first counted the table), with another value.
 * - R6 (agreement, at the end): on every page up, the last value called of
 *   the round its screen names is the one it shows, and no change its
 *   screen showed waits uncalled (but one the hold may still keep).
 * - L1/L3, the level: 2 exactly while a round runs, by a view counted
 *   only from the frame after the checks (R3's), and only while no record
 *   waits for its check (meanwhile the level it had stands, for 10 s at
 *   most, and nothing counts): betting before its
 *   deadline (at roulette, 4.5 s past it, for the close), closing (but a
 *   decided round held again only if this page saw it run), or the result
 *   of a round this page saw run since its last load, wake or clock step
 *   back; else 1 for 10 s after (a clock step back keeps what was left),
 *   or while bets ride at craps; else 0. A result shown again after a load
 *   or a sleep never makes it 2 by itself.
 * - H1, the hold (pages with dice): no result called while the page's dice
 *   fly or settle, unless it has waited 8 s; but an earlier roll's
 *   correction is called at once (the dice in the air are the next roll's).
 *
 * The heartbeats of old-build ghosts (L2) move nothing: R1 and L1 hold in
 * the scenarios that send them.
 */

import type { ComputedCrapsState, ComputedRouletteState } from './computedTable';
import type { GameName } from './computedFold';
import type { Sim, SimPage } from './computedSim';
import { pocketColor } from './games/roulette';

type View = ComputedRouletteState | ComputedCrapsState;
type Call = NonNullable<ReturnType<SimPage['p']['robot']['computedTableCall']>>;

/** The design's numbers (computedRobot's own, restated). */
const LINGER_MS = 10_000;
const HOLD_MAX_MS = 8_000;
const CLOCK_SLACK_MS = 1_000;
/** Roulette's betting runs on past its deadline by three staggers, for the
 *  close (chips down: the table's close comes a little after). */
const CLOSE_SLACK_MS = 4_500;
const VOID = 'void';
const TIMES_UP = "🎲 Time's up — the stickman throws";

type NameOf = (pid: string) => string;

/** How page sp's robot names a player: the name in the room's player list,
 *  or the id's head (readPlayerDisplayName's rule), made speakable (its
 *  rules have their own specs: computedRobot.test.ts speakableName). A
 *  page's own markup name (computedCrapsSimShooter) is text like any other. */
function namesOf(sp: SimPage): NameOf {
  return (pid) => {
    const entry = sp.p.doc.getMap('players').get(pid) as { name?: unknown } | undefined;
    const raw = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : pid.slice(0, 8);
    return sp.p.robot.speakableName(raw);
  };
}

// ── The design's words ──────────────────────────────────────────────────────

/** The result call for a settled view (design §3, the tables). */
export function wordsFor(v: View, nameOf: NameOf): string | null {
  const paid = v.payouts != null && Object.keys(v.payouts).length > 0;
  if (v.kind === 'roulette') {
    if (v.result === null) return null;
    return `🎡 ${v.result} ${pocketColor(v.result).toUpperCase()} — ${paid ? 'winners paid!' : 'house wins'}`;
  }
  if (!v.dice) return null;
  const [a, b] = v.dice;
  const before = v.holderBefore;
  const after = v.shooterAfter;
  const pass = v.sevenOut && before !== undefined && after === before
    ? `the dice come back to ${nameOf(before)}`
    : after === before ? null : after === undefined ? 'the stickman has the dice' : `the dice pass to ${nameOf(after)}`;
  if (pass === null && !v.sevenOut) return `🎲 ${a}+${b} = ${a + b} — ${paid ? 'winners paid!' : 'house collects'}`;
  return `🎲 ${a}+${b} = ${a + b} — ${v.sevenOut ? 'seven out' : paid ? 'winners paid' : 'house collects'}${pass ? `, ${pass}` : ''}`;
}

const emojiOf = (game: GameName): string => (game === 'roulette' ? '🎡 ' : '🎲 ');
const isNow = (game: GameName, r: number): string => (game === 'roulette' ? `Round ${r} is now ` : `Roll ${r} is now `);

/** A result shown again with another value while on show. */
export function rewriteFor(v: View, nameOf: NameOf): string | null {
  const w = wordsFor(v, nameOf);
  const e = emojiOf(v.kind);
  return w === null ? null : `${e}${isNow(v.kind, v.round)}${w.slice(e.length)}`;
}

/** A result changed after its show: the short form. */
export function correctionFor(game: GameName, r: number, value: string): string {
  if (game === 'roulette') return `🎡 ${isNow(game, r)}${value} ${pocketColor(Number(value)).toUpperCase()}`;
  const a = Number(value[0]);
  const b = Number(value[1]);
  return `🎲 ${isNow(game, r)}${a}+${b} = ${a + b}`;
}

const voidWords = (game: GameName): string => (game === 'roulette' ? '⚠ No spin — stakes returned' : '⚠ No roll — every bet stands');

/** The view's result key as `r` and value, or null (none may show). */
function keyOf(v: View): { r: number; value: string } | null {
  const m = /^(\d+):(\d+)$/.exec(v.kind === 'roulette' ? v.spinKey : v.rollKey);
  return m ? { r: Number(m[1]), value: m[2] } : null;
}

// ── Per page and table ──────────────────────────────────────────────────────

interface Track {
  load: number;
  inc: string | null;
  primed: boolean;
  /** Round → the value last called, found on show as the table was first
   *  counted, or first seen after its show (the design's silent rule). */
  known: Map<number, string>;
  opens: Map<number, { deadline: number; at: number }>;
  closes: Map<number, Set<number | null>>;
  timesUp: Set<number>;
  /** Craps: the wait for the throw last seen (its roll, its end), until
   *  that roll takes bets again (a window of its own). */
  wait: { r: number; until: number } | null;
  /** A result the screen changed to, not yet called: since when, and from
   *  when it is due (a frame whose records wait for their check puts it
   *  off: `excused`, and a round whose show passed meanwhile is the
   *  design's silent one; one that left the screen meanwhile, `left`, is on
   *  screen afresh when it shows again). */
  pending: { r: number; value: string; since: number; due: number; excused: boolean; left?: boolean } | null;
  /** The result (or void) on screen, and the frame it first showed here
   *  (a frame whose records wait for their check, or before the table was
   *  first counted, too). */
  shownAt: { r: number; value: string; at: number } | null;
  /** What the screen showed at the last frame since the table was first
   *  counted (a frame whose records wait for their check too), and whether
   *  its wheel or dice were still bringing it: moving, or the frame it first
   *  showed on a drawn table, before its felt takes it (a wake counts it as
   *  called, but one still coming). */
  lastShown: { r: number; value: string } | null;
  lastHeld: boolean;
}

interface Liveness {
  load: number;
  wakes: number;
  lastNow: number | null;
  /** Per table: the rounds (`inc:r`) seen run, when last in play, and the
   *  clock at its last frame. */
  ran: Map<string, Set<string>>;
  hotAt: Map<string, number>;
  at: Map<string, number>;
  /** Per table: the level at its last frame, and since when its records
   *  have waited for their check. */
  last: Map<string, number>;
  waitsFrom: Map<string, number>;
}

/** What a view rests on this frame: whether the page's records of its
 *  incarnation were checked by its last frame (R3's, the harness's own);
 *  whether, so, a record that came since waits for its check now; and the
 *  last round the page's fold holds decided. */
interface Seen { checked: boolean; waits: boolean; decidedTo: number | null }

/** A decided round shown closing: held again for its forfeit's grace. */
const heldAgain = (v: View, decidedTo: number | null): boolean => v.phase === 'closing' && decidedTo !== null && v.round <= decidedTo;

export class RobotWatch {
  private readonly tracks = new Map<string, Track>();
  private readonly lives = new Map<SimPage, Liveness>();
  /** Calls made (said or dropped), results among them, frames watched. */
  readonly stats = { frames: 0, calls: 0, results: 0, corrections: 0, rewrites: 0, voids: 0, opens: 0, closes: 0, timesUps: 0, live: 0, quiet: 0 };

  constructor(private readonly sim: Sim) {}

  /** The run's robot counts, on a line of their own (the [sim] line stays as
   *  it was, for the roulette comparison). */
  line(): string {
    const s = this.stats;
    return `[robot] ${this.sim.label}: ${s.frames} table frames, ${s.calls} calls (${s.results} results: ${s.rewrites} rewrites, `
      + `${s.corrections} corrections, ${s.voids} voids; ${s.opens} opens, ${s.closes} closes, ${s.timesUps} time's ups), in play ${s.live}, quiet ${s.quiet}`;
  }

  private wrong(sp: SimPage, t: string, why: string): void {
    this.sim.violate(`${sp.name}'s robot at ${t}, ${this.sim.elapsed} ms: ${why}`);
  }

  /** The robot frame of page sp, after its tables' duties, as World runs it
   *  for each table that runs itself; `motion` says whether its table's
   *  pieces move, and are drawn (a page with the table UI). */
  frame(sp: SimPage, tables: readonly string[], now: number, motion?: (t: string) => { moving: boolean; drawn: boolean }): void {
    const { casino, croupier, robot, table, doc } = sp.p;
    let life: Liveness | null = null;
    let wrote = 0;
    const count = (): void => {
      wrote += 1;
    };
    doc.on('beforeTransaction', count);
    try {
      for (const t of tables) {
        const game = this.sim.gameOf(t);
        if (!robot.tableRunsItself(t, game)) continue;
        this.stats.frames += 1;
        const { moving, drawn } = motion?.(t) ?? { moving: false, drawn: false };
        const level = robot.computedTableLevel(t, game, false, now);
        const call = robot.computedTableCall(t, game, now, moving, drawn);
        const view: View | null = game === 'craps' ? table.readComputedCraps(t, now) : table.readComputedRoulette(t, now);
        // (As the robot reads its wake: at the first table's level of the frame.)
        life ??= this.lifeOf(sp, now, croupier.tablesWakeCount());
        const tr = this.tracks.get(`${sp.name}|${t}`);
        const settled = casino.computedSettled(t);
        const primed = tr !== undefined && tr.load === sp.loads && tr.primed && tr.inc === view?.inc;
        const seen: Seen = { checked: primed && settled, waits: primed && !settled, decidedTo: table.computedDecidedTo(t, game) };
        this.checkLevel(sp, t, view, level, life, now, seen);
        // (Asked only while unprimed, as the robot asks: casinoWhole asks the
        // room for what's missing, at most once a few seconds.)
        this.checkCall(sp, t, game, view, call, () => casino.casinoWhole(t) && settled, settled, seen.decidedTo, moving, drawn, now);
        if (call) robot.noteComputedCallSaid(t, call);
      }
    } finally {
      doc.off('beforeTransaction', count);
    }
    if (wrote > 0) this.sim.violate(`${sp.name}'s robot frame wrote to the room at ${this.sim.elapsed} ms (${wrote} transactions)`);
  }

  /** Page sp's liveness memory, across a load (fresh), a wake or a clock
   *  step back (the rounds seen run forgotten, and what each table showed
   *  before counted as called). */
  private lifeOf(sp: SimPage, now: number, wakes: number): Liveness {
    let l = this.lives.get(sp);
    if (!l || l.load !== sp.loads) {
      l = { load: sp.loads, wakes, lastNow: null, ran: new Map(), hotAt: new Map(), at: new Map(), last: new Map(), waitsFrom: new Map() };
      this.lives.set(sp, l);
    }
    if (l.wakes !== wakes || (l.lastNow !== null && l.lastNow - now >= CLOCK_SLACK_MS)) {
      l.ran.clear();
      l.waitsFrom.clear();
      // (No level in play kept from before it: only what the linger leaves.)
      for (const [t, last] of l.last) {
        if (last !== 2) continue;
        const hot = l.hotAt.get(t);
        const at = l.at.get(t);
        const since = hot === undefined ? null : at !== undefined && now < at ? at - hot : now - hot;
        l.last.set(t, since !== null && since < LINGER_MS ? 1 : 0);
      }
      for (const [id, tr] of this.tracks) {
        if (!id.startsWith(`${sp.name}|`) || tr.load !== sp.loads) continue;
        if (tr.lastShown && tr.lastHeld) {
          // (Still coming: due again from the wake's first checked frame,
          // its hold started afresh there; or, its show passed meanwhile,
          // the design's silent one, as for records that waited for a
          // check. A change that left the screen before is gone: the robot's
          // hold of it ended, and one that comes back is new.)
          if (tr.pending?.r === tr.lastShown.r && tr.pending.value === tr.lastShown.value) Object.assign(tr.pending, { due: now, excused: true, left: true });
          else tr.pending = null;
          continue;
        }
        if (tr.lastShown) tr.known.set(tr.lastShown.r, tr.lastShown.value);
        tr.pending = null;
      }
    }
    l.wakes = wakes;
    l.lastNow = now;
    return l;
  }

  /** L1/L3: the level the design gives, against the robot's. */
  private checkLevel(sp: SimPage, t: string, v: View | null, level: number, life: Liveness, now: number, seen: Seen): void {
    let ran = life.ran.get(t);
    if (!ran) life.ran.set(t, ran = new Set());
    let hot = life.hotAt.get(t);
    let waits = life.waitsFrom.get(t);
    const was = life.at.get(t);
    if (was !== undefined && now < was) {
      if (hot !== undefined) life.hotAt.set(t, hot = now - (was - hot));
      if (waits !== undefined) life.waitsFrom.set(t, waits = now - (was - waits));
    }
    life.at.set(t, now);
    if (!seen.waits) life.waitsFrom.delete(t);
    else if (waits === undefined) life.waitsFrom.set(t, waits = now);
    const kept = seen.waits && waits !== undefined && now - waits < LINGER_MS ? life.last.get(t) ?? 0 : null;
    const want = kept ?? this.levelWanted(t, v, life, now, seen, ran);
    life.last.set(t, want);
    if (want === 2) this.stats.live += 1;
    else if (want === 1) this.stats.quiet += 1;
    if (level !== want) {
      const riders = v?.kind === 'craps' ? v.riders : 0;
      this.wrong(sp, t, `level ${level}, the design's ${want} (view ${v ? `${v.inc} ${v.phase} ${v.round} deadline ${v.phaseDeadline ?? '-'}${seen.checked ? '' : seen.waits ? ', waiting for its check' : ', unchecked'}` : 'none'}, decided to ${seen.decidedTo ?? '-'}, riders ${riders})`);
    }
  }

  /** The level by the rules, with nothing waiting for its check (L1/L3). */
  private levelWanted(t: string, v: View | null, life: Liveness, now: number, seen: Seen, ran: Set<string>): number {
    let hot = life.hotAt.get(t);
    const view = seen.checked ? v : null;
    let running = false;
    if (view) {
      const key = `${view.inc}:${view.round}`;
      const d = view.phaseDeadline;
      if (view.phase === 'closing') {
        running = ran.has(key) || seen.decidedTo === null || view.round > seen.decidedTo;
        if (running) ran.add(key);
      } else if (view.phase === 'betting') {
        if (d !== undefined && now < d) ran.add(key);
        running = d !== undefined && now < d + (view.kind === 'roulette' ? CLOSE_SLACK_MS : 0);
      } else {
        running = ran.has(key);
      }
    }
    if (running) life.hotAt.set(t, hot = now);
    const riders = view?.kind === 'craps' ? view.riders : 0;
    return running ? 2 : hot !== undefined && now - hot < LINGER_MS ? 1 : riders > 0 ? 1 : 0;
  }

  /** R1–R5 and H1 for the call (or none) this frame. */
  private checkCall(sp: SimPage, t: string, game: GameName, v: View | null, call: Call | null, whole: () => boolean, settled: boolean, decidedTo: number | null, moving: boolean, drawn: boolean, now: number): void {
    const id = `${sp.name}|${t}`;
    let tr = this.tracks.get(id);
    if (!tr || tr.load !== sp.loads) {
      tr = { load: sp.loads, inc: null, primed: false, known: new Map(), opens: new Map(), closes: new Map(), timesUp: new Set(), wait: null, pending: null, shownAt: null, lastShown: null, lastHeld: false };
      this.tracks.set(id, tr);
    }
    if (!v) {
      if (call) this.wrong(sp, t, `a call with nothing on screen: ${call.text}`);
      return;
    }
    if (tr.inc !== v.inc) {
      tr.inc = v.inc;
      tr.primed = false;
      tr.known.clear();
      tr.opens.clear();
      tr.closes.clear();
      tr.timesUp.clear();
      tr.wait = null;
      tr.pending = null;
      tr.shownAt = null;
      tr.lastShown = null;
      tr.lastHeld = false;
    }
    const d = v.phaseDeadline;
    if (v.kind === 'craps' && v.phase === 'closing' && v.shooterSlip !== undefined && d !== undefined) tr.wait = { r: v.round, until: d };
    else if (tr.wait?.r === v.round && v.phase === 'betting' && d !== undefined && now < d) tr.wait = null;
    const k = keyOf(v);
    const onShow = (r: number): boolean => v.phase === 'settled' && v.round === r;
    // What the screen shows (a void only on show), and since when, every
    // frame. (A hold started in the future is a clock gone back: it holds
    // from now; and a show: it showed before now.)
    const shown = k ?? (v.phase === 'settled' && v.voided ? { r: v.round, value: VOID } : null);
    if (!shown) tr.shownAt = null;
    else if (tr.shownAt?.r !== shown.r || tr.shownAt.value !== shown.value) tr.shownAt = { ...shown, at: now };
    else if (tr.shownAt.at > now) tr.shownAt.at = now - 1;
    if (tr.pending && tr.pending.since > now) tr.pending.since = now;
    if (!tr.primed) {
      // R3.
      if (call) this.wrong(sp, t, `"${call.text}" before its records of ${v.inc} were first whole and checked`);
      if (whole() && !heldAgain(v, decidedTo)) {
        tr.primed = true;
        if (k) tr.known.set(k.r, k.value);
        if (v.phase === 'settled' && v.voided) tr.known.set(v.round, VOID);
      }
      return;
    }
    // A window's deadline that moved while it ran is the same window.
    const o = tr.opens.get(v.round);
    if (v.phase === 'betting' && d !== undefined && o && now < o.deadline) o.deadline = d;
    // Whether what shows is still coming, for a wake: while the dice fly, or
    // on the frame it first shows on a drawn table (at craps only a roll on
    // show; never a void).
    const isPending = (x: { r: number; value: string } | null): boolean => x !== null && tr.pending?.r === x.r && tr.pending.value === x.value;
    const stillComing = (): boolean => shown !== null && shown.value !== VOID && (game === 'roulette' || onShow(shown.r))
      && (moving || (drawn && now <= tr.shownAt!.at));
    tr.lastShown = shown;
    // R3's second half: nothing while a record waits for its check (and no
    // change seen is due until it is checked).
    if (!settled) {
      if (call) this.wrong(sp, t, `"${call.text}" while a record of ${v.inc} waits for its check`);
      if (tr.pending) {
        tr.pending.excused = true;
        if (!isPending(shown)) tr.pending.left = true;
      }
      tr.lastHeld = stillComing();
      return;
    }
    // (What the robot remembers before its call: R2 and R5 against it.)
    const before = call?.kind === 'result' ? tr.known.get(call.r) : undefined;
    // What the screen changed to (R2's second half), or a round first seen
    // after its show (remembered without a word).
    if (shown && tr.known.get(shown.r) !== shown.value) {
      if (!onShow(shown.r) && !tr.known.has(shown.r)) {
        tr.known.set(shown.r, shown.value);
        // (A show that passed while its records waited for their check is
        // the design's silent one; any other passed uncalled.)
        if (tr.pending?.r === shown.r && tr.pending.value === shown.value && !tr.pending.excused) {
          this.wrong(sp, t, `never called round ${shown.r}'s ${shown.value} during its show, on screen since ${tr.pending.since}`);
        }
        tr.pending = null; // (or another change took its place)
      } else if (tr.pending?.r !== shown.r || tr.pending.value !== shown.value) {
        tr.pending = { r: shown.r, value: shown.value, since: now, due: now, excused: false };
      } else if (tr.pending.excused) {
        tr.pending.due = now;
        tr.pending.excused = false;
        if (tr.pending.left) tr.pending.since = now;
        tr.pending.left = false;
      }
    } else if (tr.pending && (!shown || shown.r !== tr.pending.r || shown.value !== tr.pending.value)) {
      // (A void's show over, the next round's window up, with no call.)
      if (!shown && tr.pending.value === VOID && !tr.pending.excused && v.phase === 'betting') {
        this.wrong(sp, t, `never called round ${tr.pending.r}'s void during its show, on screen since ${tr.pending.since}`);
      }
      tr.pending = null; // (another change took its place)
    }
    tr.lastHeld = stillComing();
    if (call) {
      this.stats.calls += 1;
      if (call.kind === 'result') this.checkResult(sp, t, game, v, call, tr, k, before, moving, now);
      else if (call.kind === 'open') {
        this.stats.opens += 1;
        const was = tr.opens.get(call.r);
        if (call.deadline === undefined || v.phase !== 'betting' || v.round !== call.r || v.phaseDeadline !== call.deadline || now >= call.deadline) {
          this.wrong(sp, t, `opened round ${call.r} to ${call.deadline}, the screen ${v.phase} ${v.round} to ${v.phaseDeadline}`);
        }
        if (was && now < was.deadline) this.wrong(sp, t, `opened round ${call.r} again at ${now}, its window open to ${was.deadline}`);
        tr.opens.set(call.r, { deadline: call.deadline ?? 0, at: now });
      } else if (call.kind === 'close') {
        this.stats.closes += 1;
        if (v.phase !== 'closing' || v.round !== call.r) this.wrong(sp, t, `closed round ${call.r}, the screen ${v.phase} ${v.round}`);
        // (The window is the one the harness saw opened on the round.)
        const w = tr.opens.get(call.r)?.deadline ?? null;
        if ((call.window ?? null) !== w) this.wrong(sp, t, `closed round ${call.r} naming window ${call.window}, the window opened ${w}`);
        let set = tr.closes.get(call.r);
        if (!set) tr.closes.set(call.r, set = new Set());
        if (set.has(w)) this.wrong(sp, t, `closed round ${call.r}'s window ${w} twice`);
        set.add(w);
      } else if (call.kind === 'timesup') {
        this.stats.timesUps += 1;
        if (game !== 'craps' || call.text !== TIMES_UP) this.wrong(sp, t, `said "${call.text}" for time's up at ${game}`);
        if (tr.timesUp.has(call.r)) this.wrong(sp, t, `said time's up for roll ${call.r} twice`);
        if (tr.known.has(call.r)) this.wrong(sp, t, `said time's up for roll ${call.r}, its result called`);
        if (v.round !== call.r || v.phase === 'betting') this.wrong(sp, t, `said time's up for roll ${call.r}, the screen ${v.phase} ${v.round}`);
        if (tr.wait?.r !== call.r || now < tr.wait.until) {
          this.wrong(sp, t, `said time's up for roll ${call.r}, the wait seen ${tr.wait ? `roll ${tr.wait.r}'s to ${tr.wait.until}` : 'none'}`);
        }
        tr.timesUp.add(call.r);
      }
    }
    if (tr.pending && now - tr.pending.due > HOLD_MAX_MS + 1_000) {
      this.wrong(sp, t, `never called round ${tr.pending.r}'s ${tr.pending.value}, on screen since ${tr.pending.since}`);
      tr.pending = null;
    }
  }

  private checkResult(sp: SimPage, t: string, game: GameName, v: View, call: Call, tr: Track, k: { r: number; value: string } | null, before: string | undefined, moving: boolean, now: number): void {
    this.stats.results += 1;
    // R2: not the value last called.
    if (before === call.value) this.wrong(sp, t, `called round ${call.r}'s ${call.value} again: ${call.text}`);
    let want: string | null;
    if (call.value === VOID) {
      this.stats.voids += 1;
      if (!(v.phase === 'settled' && v.voided && v.round === call.r)) this.wrong(sp, t, `called round ${call.r} void, the screen ${v.phase} ${v.round}`);
      want = voidWords(game);
    } else {
      // R1: the round and value on screen.
      if (!k || k.r !== call.r || k.value !== call.value) {
        this.wrong(sp, t, `called round ${call.r}'s ${call.value}, the screen's key ${k ? `${k.r}:${k.value}` : 'none'}`);
        return;
      }
      if (v.phase === 'settled' && v.round === call.r) {
        if (before !== undefined) this.stats.rewrites += 1;
        want = before !== undefined ? rewriteFor(v, namesOf(sp)) : wordsFor(v, namesOf(sp));
      } else {
        // R5: a correction names a round called before, with another value.
        this.stats.corrections += 1;
        if (before === undefined) this.wrong(sp, t, `corrected round ${call.r}, never called: ${call.text}`);
        want = correctionFor(game, call.r, call.value);
      }
      // H1 (at craps only a roll on show moves).
      const shows = v.phase === 'settled' && v.round === call.r;
      if (moving && (game === 'roulette' || shows) && (tr.pending === null || now - tr.pending.since < HOLD_MAX_MS)) {
        this.wrong(sp, t, `called round ${call.r} while its dice moved, held ${tr.pending ? now - tr.pending.since : 0} ms`);
      }
    }
    if (call.text !== want) this.wrong(sp, t, `said "${call.text}", the design's words "${want}"`);
    tr.known.set(call.r, call.value);
    if (tr.pending?.r === call.r && tr.pending.value === call.value) tr.pending = null;
    else if (tr.pending) this.wrong(sp, t, `called round ${call.r}'s ${call.value}, the screen's change to ${tr.pending.r}:${tr.pending.value} still due`);
  }

  /** Whether page sp's last robot frame at table t showed a result its
   *  wheel or dice were still bringing (moving, or the frame it first showed
   *  on a drawn table), as the harness has it. */
  stillComing(sp: SimPage, t: string): boolean {
    const tr = this.tracks.get(`${sp.name}|${t}`);
    return tr !== undefined && tr.load === sp.loads && tr.lastHeld;
  }

  /** R6, once the room is quiet: on page sp, at each table, the round its
   *  screen names was last called (or found) with the value it shows. */
  agreement(sp: SimPage, now: number): string[] {
    // (A frame first: the room may have changed since its last.)
    this.frame(sp, this.sim.tables.filter((t) => sp.inRoom.has(t)), now, sp.robotMotion ?? undefined);
    const out: string[] = [];
    for (const t of this.sim.tables) {
      const game = this.sim.gameOf(t);
      if (!sp.p.robot.tableRunsItself(t, game)) continue;
      const v: View | null = game === 'craps' ? sp.p.table.readComputedCraps(t, now) : sp.p.table.readComputedRoulette(t, now);
      const tr = this.tracks.get(`${sp.name}|${t}`);
      if (!v || !tr || tr.load !== sp.loads || tr.inc !== v.inc || !tr.primed) continue;
      const p = tr.pending;
      if (p) {
        // (Still due, but the hold may keep a result a little: while the dice
        // fly, or for a frame on a drawn table; at craps only a roll on show.
        // Or its records wait for their check. A void is never held.)
        const { moving, drawn } = sp.robotMotion?.(t) ?? { moving: false, drawn: false };
        const mayHold = p.value !== VOID && (game === 'roulette' || (v.phase === 'settled' && v.round === p.r));
        const held = p.excused || (mayHold && now - p.since < HOLD_MAX_MS && (moving || (drawn && now <= p.since)));
        if (!held) out.push(`${this.sim.label}: ${sp.name}'s robot at ${t} never called round ${p.r}'s ${p.value}, on screen since ${p.since}`);
        continue;
      }
      const k = keyOf(v);
      if (!k) continue;
      const said = tr.known.get(k.r);
      if (said !== k.value) out.push(`${this.sim.label}: ${sp.name}'s robot at ${t} last called round ${k.r} as ${said ?? 'nothing'}, the screen ${k.value}`);
    }
    return out;
  }
}
