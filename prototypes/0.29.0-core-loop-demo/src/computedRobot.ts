/**
 * 🤖🧮 The robot at a players' table (PR 4 of "Computed casino tables").
 *
 * A computed table has nobody in charge, so no heartbeat brings its robot
 * croupier or stickman (croupier.ts beatCroupier skips it). Instead each page
 * decides for itself, from the table as it shows it, when the table needs its
 * robot and what the robot says. Nothing here is written to the room: every
 * page draws its own robots already, and a players' table must work the same
 * with the owner gone.
 *
 * THE WORDS are the owner-run robot's (croupierBeatLine, crapsBeatLine)
 * wherever they fit. What is new: at craps the result says who gets the dice
 * next (the status bar's rule), a changed result is called again, a void is
 * called, and the wait for the shooter's throw names the shooter.
 *
 * NAMES are players' own text, and a modified page can write any length and
 * any characters. The bubble shows plain text cut at 90 characters, but the
 * voice reads all of it, so a name is cleaned before it goes into a call.
 *
 * EACH CALL ONCE. A page keeps, per table, what its robot last called: the
 * result of each round (as the felt keeps what it spun or threw), the
 * betting window it last opened and the one it last closed. It starts afresh
 * with each incarnation and each room, and it is primed when the table's
 * records are first whole and checked (as the felt is), so a load or a
 * switch says nothing old. A result is called when a round's value differs
 * from the one remembered (A, then B, then A again: three calls), while the
 * round is on show, or after its show as a correction of a round called
 * before; a round first seen after its show is remembered without a word.
 * The result waits a frame on a drawn table, then while this page's wheel
 * spins or its dice fly (at most RESULT_HOLD_MAX_MS), so the robot never
 * gives it away.
 *
 * WHEN A ROBOT COMES. A table that runs itself (tableRunsItself) is in play
 * on this page (level 2) while someone stands at one of its stands or a
 * round runs that this page saw run: past "no more bets", betting before
 * its deadline, or a result on show of a round it saw betting or closing
 * (a load or a wake shows every table's last result again, and must not
 * call a robot to each). It is quiet (level 1) for COMPUTED_LIVE_LINGER_MS
 * after, and at craps while bets ride on it; idle (0) otherwise. Robots are
 * handed out (assignCroupiers): owner-run tables with a fresh heartbeat
 * first, as today; then tables in play, from the free robots or a quiet
 * table's; then quiet tables, from the free ones.
 */

import { casinoDocEpoch, casinoWhole, computedSettled, computedSwitchLost, isComputedFor, isComputedTable } from './casinoDoc';
import { readComputedCraps, readComputedRoulette } from './computedTable';
import type { ComputedCrapsState, ComputedRouletteState } from './computedTable';
import type { GameName } from './computedFold';
import { croupierBeatLine, TABLE_CLOCK_SLACK_MS, tablesWakeCount } from './croupier';
import { crapsBeatLine } from './crapsCalls';
import { readPlayerDisplayName } from './games/gamesDoc';
import { pocketColor } from './games/roulette';
import { PLAYER_NAME_MAX_LENGTH } from './identity';
import type { RobotRoutine } from './robotDoc';

/** The longest a result call waits for this page's wheel or dice to stop. */
export const RESULT_HOLD_MAX_MS = 8_000;
/** Rounds whose result call a page remembers per table (the felt's own
 *  memory of what it spun or threw keeps as many). */
export const CALLED_ROUNDS = 64;
/** A void, in the memory of what was called. */
export const VOID = 'void';
/** How long a players' table keeps its robot after its last sign of play. */
export const COMPUTED_LIVE_LINGER_MS = 10_000;
/** An avatar this near a stand's front stands at it (the walk-up's own
 *  test of a taken stand, World pickFreeStand). */
export const AT_STAND_M = 0.7;
/** What the robot calls a shooter whose name is nothing once cleaned. */
export const NAME_FALLBACK = 'the shooter';
/** A void's call (the status bar's ROLL VOID / NO SPIN in a robot's words). */
export const NO_SPIN_CALL = '⚠ No spin — stakes returned';
export const NO_ROLL_CALL = '⚠ No roll — every bet stands';

export type TableView = ComputedRouletteState | ComputedCrapsState;
export type NameOf = (pid: string) => string;
export type Level = 0 | 1 | 2;

// ── 🗣 Names ─────────────────────────────────────────────────────────────────

/** Control and invisible formatting characters (text-direction overrides,
 *  zero-width joiners). Built at run time, as robotVoice's pattern is: a
 *  property escape in a regex literal would fail to parse on an old engine
 *  and take the module down; the fallback lists the common ones. */
const UNSPEAKABLE: RegExp = (() => {
  try {
    return new RegExp('[\\p{Cc}\\p{Cf}]', 'gu');
  } catch {
    return /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
  }
})();

/** A player's name as the robot says it: unspeakable characters dropped,
 *  spaces collapsed, cut to PLAYER_NAME_MAX_LENGTH whole characters (code
 *  points, so an emoji is never split), or `fallback` if nothing is left. */
export function speakableName(raw: string, fallback = NAME_FALLBACK): string {
  const clean = raw.replace(/\s+/g, ' ').replace(UNSPEAKABLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, PLAYER_NAME_MAX_LENGTH).join('').trim() || fallback;
}

// ── 🎲 Results ───────────────────────────────────────────────────────────────

/** Who gets the dice after a settled roll, by the status bar's rule
 *  (casinoTableSession computedCrapsStatus): a lone shooter's seven-out
 *  comes back to them; otherwise a change of hands is said; no change, no
 *  words. `before` undefined is the stickman's hand. */
export function passPart(v: ComputedCrapsState, name: NameOf): string | null {
  const before = v.holderBefore;
  const after = v.shooterAfter;
  if (v.sevenOut && before !== undefined && after === before) return `the dice come back to ${name(after)}`;
  if (after === before) return null;
  return after === undefined ? 'the stickman has the dice' : `the dice pass to ${name(after)}`;
}

/** A settled view's result call: the owner-run words, except at craps when
 *  the dice change hands or seven out (the owner-run "new shooter" is wrong
 *  for a lone shooter, who keeps them, and when nobody is counted to take
 *  them). Null for a void or a view with no result. */
export function resultText(v: TableView, name: NameOf): string | null {
  if (v.phase !== 'settled') return null;
  if (v.kind === 'roulette') return croupierBeatLine(v)?.text ?? null;
  const owner = crapsBeatLine(v);
  if (!owner || !v.dice) return null;
  const pass = passPart(v, name);
  if (pass === null && !v.sevenOut) return owner.text;
  const paid = v.payouts != null && Object.keys(v.payouts).length > 0;
  const verdict = v.sevenOut ? 'seven out' : paid ? 'winners paid' : 'house collects';
  return `🎲 ${v.dice[0]}+${v.dice[1]} = ${v.result} — ${verdict}${pass ? `, ${pass}` : ''}`;
}

/** The emoji every result call starts with, and what a changed one says
 *  after it. */
function headOf(game: GameName, r: number): { emoji: string; is: string } {
  return game === 'roulette' ? { emoji: '🎡 ', is: `Round ${r} is now ` } : { emoji: '🎲 ', is: `Roll ${r} is now ` };
}

/** A settled view whose round was called before with another result:
 *  resultText with `Round r is now ` / `Roll r is now ` after its emoji. */
export function rewriteText(v: TableView, name: NameOf): string | null {
  const text = resultText(v, name);
  if (text === null) return null;
  const { emoji, is } = headOf(v.kind, v.round);
  return text.startsWith(emoji) ? `${emoji}${is}${text.slice(emoji.length)}` : null;
}

/** A round's result changed after its show (the next round is under way):
 *  the short form, from the result alone (a pocket, or the two dice as
 *  `d1d2`). */
export function correctionText(game: GameName, r: number, value: string): string {
  const { emoji, is } = headOf(game, r);
  if (game === 'roulette') {
    const n = Number(value);
    return `${emoji}${is}${n} ${pocketColor(n).toUpperCase()}`;
  }
  const a = Number(value[0]);
  const b = Number(value[1]);
  return `${emoji}${is}${a}+${b} = ${a + b}`;
}

// ── ✋ The wait for the throw ─────────────────────────────────────────────────

/** Craps, closing in the wait for the holder's throw (shooterSlip and its
 *  deadline set): the close's call, naming the shooter. A shooter at the
 *  table, or with chips down away from a stand, has the seconds to throw;
 *  one gone, not here, or with no bet down gets the stickman's throw. Null
 *  outside the wait. Seconds are whole, rounded up, on this page's clock. */
export function waitText(v: ComputedCrapsState, name: NameOf, now: number): string | null {
  if (v.phase !== 'closing' || v.shooterSlip === undefined || v.phaseDeadline === undefined || v.holder === undefined) return null;
  const n = Math.max(1, Math.ceil((v.phaseDeadline - now) / 1000));
  const secs = n === 1 ? '1 second' : `${n} seconds`;
  const who = name(v.holder);
  return v.shooterSlip === 'here' || v.shooterSlip === 'away'
    ? `✋ No more bets — ${who} has ${secs} to throw`
    : `✋ No more bets — the stickman throws for ${who} in ${secs}`;
}

// ── 🔁 Each call once ────────────────────────────────────────────────────────

/** What one page's robot has said at one table, for one incarnation. */
export interface CallMemory {
  inc: string;
  /** Set once the table's records were first whole and checked here. */
  primed: boolean;
  /** Round → the pocket, the dice as `d1d2`, or VOID: oldest first,
   *  CALLED_ROUNDS kept. */
  called: Map<number, string>;
  /** The betting window last opened (its round and deadline). */
  open: { r: number; deadline: number } | null;
  /** The window last closed: its round, and the deadline of the window this
   *  page saw open on that round (null if it saw none). */
  close: { r: number; window: number | null } | null;
  /** A result waiting for the wheel or dice (`r:value`), since `at`. */
  hold: { id: string; at: number } | null;
}

export type CallKind = 'open' | 'close' | 'result';

export interface TableCall {
  kind: CallKind;
  /** What was said, by incarnation and round (`inc|r|kind|…`). */
  key: string;
  text: string;
  r: number;
  /** result: the value remembered (pocket, `d1d2` or VOID). */
  value?: string;
  /** close: the window it closed. */
  window?: number | null;
  /** open: the window's deadline. */
  deadline?: number;
}

export interface CallCtx {
  now: number;
  /** This page's wheel spins, or its dice fly or settle (false with no
   *  table drawn). */
  moving: boolean;
  /** This page draws the table: its felt takes a new result on its next
   *  frame (World drives the felt before its own duties write, so a round
   *  this page's own seed decides shows here before the wheel can spin). */
  drawn: boolean;
  name: NameOf;
}

export function newCallMemory(inc: string): CallMemory {
  return { inc, primed: false, called: new Map(), open: null, close: null, hold: null };
}

/** `r:value` of a spin or roll key, or null for '' (no result may show). */
function keyOf(v: TableView): { r: number; value: string } | null {
  const m = /^(\d+):(\d+)$/.exec(v.kind === 'roulette' ? v.spinKey : v.rollKey);
  return m ? { r: Number(m[1]), value: m[2] } : null;
}

function remember(m: CallMemory, r: number, value: string): void {
  m.called.delete(r);
  m.called.set(r, value);
  if (m.called.size > CALLED_ROUNDS) m.called.delete(m.called.keys().next().value as number);
}

/** Every frame, before nextCall, saying nothing: a window's deadline that
 *  moved while it ran is the same window (a late re-show pushed it back), and
 *  a hold started in the future is a clock gone back. */
export function observeCalls(m: CallMemory, v: TableView, now: number): void {
  const d = v.phaseDeadline;
  if (v.phase === 'betting' && d !== undefined && m.open?.r === v.round && m.open.deadline !== d && now < m.open.deadline) {
    m.open.deadline = d;
  }
  if (m.hold && m.hold.at > now) m.hold.at = now;
}

/** The records are whole and checked for the first time here: the result on
 *  show, or the one last shown, and a void on show, count as said. Betting
 *  and its close are not marked, so a page that comes in during betting
 *  hears it open. */
export function primeCalls(m: CallMemory, v: TableView): void {
  const k = keyOf(v);
  if (k) remember(m, k.r, k.value);
  if (v.phase === 'settled' && v.voided) remember(m, v.round, VOID);
  m.primed = true;
}

/**
 * The call due at the table this frame, if any, first that applies: the
 * result (once the wheel or dice stop), no more bets, place your bets. One a
 * frame; the next comes on a later frame. Nothing is remembered until
 * callSaid, except a round first seen after its show.
 */
export function nextCall(game: GameName, v: TableView, m: CallMemory, ctx: CallCtx): TableCall | null {
  const k = keyOf(v);
  if (k && m.called.get(k.r) !== k.value) {
    const onShow = v.phase === 'settled' && v.round === k.r;
    const before = m.called.has(k.r);
    if (!onShow && !before) remember(m, k.r, k.value);
    else {
      const id = `${k.r}:${k.value}`;
      const since = m.hold?.id === id ? m.hold.at : null;
      // On a drawn table it waits a frame first, for the felt to take it,
      // then while the wheel spins or the dice fly.
      const waits = since === null
        ? ctx.moving || ctx.drawn
        : ctx.now - since < RESULT_HOLD_MAX_MS && (ctx.moving || (ctx.drawn && ctx.now <= since));
      if (waits) {
        if (since === null) m.hold = { id, at: ctx.now };
      } else {
        const text = !onShow ? correctionText(game, k.r, k.value) : before ? rewriteText(v, ctx.name) : resultText(v, ctx.name);
        if (text !== null) return { kind: 'result', key: `${v.inc}|${k.r}|result|${k.value}`, text, r: k.r, value: k.value };
      }
    }
  } else if (v.phase === 'settled' && v.voided && m.called.get(v.round) !== VOID) {
    return {
      kind: 'result', key: `${v.inc}|${v.round}|result|${VOID}`, text: game === 'roulette' ? NO_SPIN_CALL : NO_ROLL_CALL,
      r: v.round, value: VOID,
    };
  }
  if (v.phase === 'closing') {
    const window = m.open?.r === v.round ? m.open.deadline : null;
    if (m.close?.r === v.round && m.close.window === window) return null;
    const text = (v.kind === 'craps' ? waitText(v, ctx.name, ctx.now) : null) ?? '✋ No more bets!';
    return { kind: 'close', key: `${v.inc}|${v.round}|close|${window ?? ''}`, text, r: v.round, window };
  }
  const d = v.phaseDeadline;
  if (v.phase === 'betting' && d !== undefined && ctx.now < d && !(m.open?.r === v.round && m.open.deadline === d)) {
    const text = (v.kind === 'roulette' ? croupierBeatLine(v) : crapsBeatLine(v))?.text;
    if (text) return { kind: 'open', key: `${v.inc}|${v.round}|open|${d}`, text, r: v.round, deadline: d };
  }
  return null;
}

/** The call was said (or dropped unsaid at an idle table): remember it. */
export function callSaid(m: CallMemory, c: TableCall): void {
  if (c.kind === 'open') m.open = { r: c.r, deadline: c.deadline! };
  else if (c.kind === 'close') m.close = { r: c.r, window: c.window ?? null };
  else {
    remember(m, c.r, c.value!);
    m.hold = null;
  }
}

// ── 🚶 When a robot comes ────────────────────────────────────────────────────

/** Whether table `t` runs itself, so its robot comes by this page's view of
 *  it and never by a heartbeat: at craps, the stickman's own test
 *  (crapsCroupier crapsRunsItself: a craps name, or one lost); at roulette,
 *  the croupier's (a computed table, or one whose switch is lost). */
export function tableRunsItself(t: string, game: GameName): boolean {
  return game === 'craps' ? isComputedFor(t, 'craps') || computedSwitchLost(t, 'craps') : isComputedTable(t) || computedSwitchLost(t);
}

/** Whether any avatar in `spots` stands at one of the player stands in
 *  `stands` (the robot's own stand never counts). */
export function someoneAtStands(
  stands: readonly { front: { x: number; z: number }; role?: string }[],
  spots: readonly { x: number; z: number }[],
): boolean {
  return stands.some((s) => s.role == null
    && spots.some((a) => Math.hypot(a.x - s.front.x, a.z - s.front.z) < AT_STAND_M));
}

/** One table's liveness on this page: the last time it was in play, and
 *  the last round this page saw run (betting before its deadline, or
 *  closing), so a result shown again after a load or a wake isn't one. */
export interface LiveMemory {
  hotAt: number | null;
  ran: { inc: string; r: number } | null;
}

/** Whether the view shows a round running, by this page's clock. */
export function roundRuns(v: TableView, ran: LiveMemory['ran'], now: number): boolean {
  if (v.phase === 'closing') return true;
  if (v.phase === 'betting') return v.phaseDeadline !== undefined && now < v.phaseDeadline;
  return ran !== null && ran.inc === v.inc && ran.r === v.round;
}

/** The table's level this frame (the memory moves with it). With no view
 *  (just after the switch, a lost switch) only someone standing there
 *  counts. A clock gone back lingers from now. */
export function liveStep(m: LiveMemory, v: TableView | null, someoneThere: boolean, now: number): Level {
  if (v && (v.phase === 'closing' || (v.phase === 'betting' && v.phaseDeadline !== undefined && now < v.phaseDeadline))) {
    m.ran = { inc: v.inc, r: v.round };
  }
  if (someoneThere || (v !== null && roundRuns(v, m.ran, now))) {
    m.hotAt = now;
    return 2;
  }
  if (m.hotAt !== null && m.hotAt > now) m.hotAt = now;
  if (m.hotAt !== null && now - m.hotAt < COMPUTED_LIVE_LINGER_MS) return 1;
  return v?.kind === 'craps' && v.riders > 0 ? 1 : 0;
}

/** Routines that never work a table (World's croupier test). */
const NEVER_AT_A_TABLE: ReadonlySet<RobotRoutine> = new Set(['idle', 'custom', 'coach', 'dance', 'pilot', 'disassemble']);

/** Whether a robot of `routine` may work a table, when the room has a
 *  dedicated croupier (`dedicated`) or not: World's owner-run test as a
 *  function (a spec ties the two together). */
export function mayCroupier(routine: RobotRoutine, dedicated: boolean): boolean {
  return !NEVER_AT_A_TABLE.has(routine) && (!dedicated || routine === 'croupier');
}

/** A robot as the hand-out sees it: where it stands, and whether it may
 *  work an owner-run table (`owner`) and a players' table (`computed`). */
export interface RobotAt { key: string; x: number; z: number; owner: boolean; computed: boolean }
/** A table that wants a robot, at its post: 3, owner-run with a fresh
 *  heartbeat; 2, a players' table in play; 1, a quiet one. */
export interface TablePull { id: string; x: number; z: number; pull: 1 | 2 | 3 }

/**
 * Hand robots out to `tables` (in the room's order), keeping `assign`
 * (robot key → table id) sticky: a robot keeps its table while that table
 * still wants it and it may work there. Owner-run tables first, the nearest
 * robot not already at one (one at a players' table counts as free, so an
 * owner-run-only room goes exactly as World's hand-out did); then tables in
 * play, the nearest free robot, else the nearest at a quiet table; then
 * quiet tables, free robots only. Ties go to the first robot in the list.
 */
export function assignCroupiers(assign: Map<string, string>, robots: readonly RobotAt[], tables: readonly TablePull[]): void {
  const table = new Map(tables.map((t) => [t.id, t]));
  const robot = new Map(robots.map((r) => [r.key, r]));
  for (const [key, tid] of [...assign]) {
    const r = robot.get(key);
    const t = table.get(tid);
    if (!r || !t || !(t.pull === 3 ? r.owner : r.computed)) assign.delete(key);
  }
  const taken = new Set(assign.values());
  const pullAt = (key: string): number => {
    const tid = assign.get(key);
    return tid === undefined ? 0 : table.get(tid)!.pull;
  };
  const nearest = (t: TablePull, ok: (r: RobotAt) => boolean): RobotAt | null => {
    let best = Infinity;
    let out: RobotAt | null = null;
    for (const r of robots) {
      if (!ok(r)) continue;
      const d = Math.hypot(r.x - t.x, r.z - t.z);
      if (d < best) {
        best = d;
        out = r;
      }
    }
    return out;
  };
  const give = (r: RobotAt | null, t: TablePull): void => {
    if (!r) return;
    const was = assign.get(r.key);
    if (was !== undefined) taken.delete(was);
    assign.set(r.key, t.id);
    taken.add(t.id);
  };
  for (const t of tables) if (t.pull === 3 && !taken.has(t.id)) give(nearest(t, (r) => r.owner && pullAt(r.key) !== 3), t);
  for (const t of tables) {
    if (t.pull !== 2 || taken.has(t.id)) continue;
    give(nearest(t, (r) => r.computed && pullAt(r.key) === 0) ?? nearest(t, (r) => r.computed && pullAt(r.key) === 1), t);
  }
  for (const t of tables) if (t.pull === 1 && !taken.has(t.id)) give(nearest(t, (r) => r.computed && pullAt(r.key) === 0), t);
}

// ── 📄 This page's memory, by table ──────────────────────────────────────────

const calls = new Map<string, CallMemory>();
const live = new Map<string, LiveMemory>();
let docEpoch: number | null = null;
let wakes: number | null = null;
let lastAt: number | null = null;

/** A new room doc (casinoDocEpoch) starts every table afresh. */
function sameDoc(): void {
  const epoch = casinoDocEpoch();
  if (epoch === docEpoch) return;
  docEpoch = epoch;
  calls.clear();
  live.clear();
}

/** A wake (tablesWakeCount), or a clock gone back a second or more, forgets
 *  which rounds this page saw run: every table's last result shows again. */
function sameWake(now: number): void {
  const n = tablesWakeCount();
  if (n !== wakes || (lastAt !== null && lastAt - now >= TABLE_CLOCK_SLACK_MS)) {
    wakes = n;
    for (const m of live.values()) m.ran = null;
  }
  lastAt = now;
}

const nameOf: NameOf = (pid) => speakableName(readPlayerDisplayName(pid));

function viewOf(t: string, game: GameName, now: number): TableView | null {
  return game === 'craps' ? readComputedCraps(t, now) : readComputedRoulette(t, now);
}

/**
 * The call due at players' table `t` this frame, from the table as this page
 * shows it, or null. Null too until its records are first whole and checked
 * here (casinoWhole, computedSettled: the felt's own start), and while the
 * page has nothing of it to show (a lost switch keeps what was said). The
 * caller says it, or drops it, then tells noteComputedCallSaid.
 */
export function computedTableCall(t: string, game: GameName, now = Date.now(), moving = false, drawn = false): TableCall | null {
  sameDoc();
  const v = viewOf(t, game, now);
  if (!v) return null;
  let m = calls.get(t);
  if (!m || m.inc !== v.inc) {
    m = newCallMemory(v.inc);
    calls.set(t, m);
  }
  observeCalls(m, v, now);
  if (!m.primed) {
    // (casinoWhole asks the room for what's missing: only until primed, as
    // the felt asks.)
    if (casinoWhole(t) && computedSettled(t)) primeCalls(m, v);
    return null;
  }
  return nextCall(game, v, m, { now, moving, drawn, name: nameOf });
}

/** The call computedTableCall gave was said, or dropped unsaid. */
export function noteComputedCallSaid(t: string, c: TableCall): void {
  const m = calls.get(t);
  if (m && c.key.startsWith(`${m.inc}|`)) callSaid(m, c);
}

/**
 * Players' table `t`'s level on this page this frame (liveStep), with
 * `someoneThere` whether an avatar stands at one of its stands. Every
 * frame, for every table that runs itself, whether it has a post or not:
 * the linger and the rounds seen run live here.
 */
export function computedTableLevel(t: string, game: GameName, someoneThere: boolean, now = Date.now()): Level {
  sameDoc();
  sameWake(now);
  let m = live.get(t);
  if (!m) {
    m = { hotAt: null, ran: null };
    live.set(t, m);
  }
  return liveStep(m, viewOf(t, game, now), someoneThere, now);
}

/** Table `t` left the room: forget it. */
export function forgetComputedTable(t: string): void {
  calls.delete(t);
  live.delete(t);
}
