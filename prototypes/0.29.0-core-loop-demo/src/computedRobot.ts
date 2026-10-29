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
 * gives it away. A wake (or a clock gone back) counts what the page showed
 * before it as said, so the show it brings again is silent.
 *
 * WHEN A ROBOT COMES. A table that runs itself (tableRunsItself) is in play
 * on this page (level 2) while someone stands at one of its stands or a
 * round runs that this page saw run: past "no more bets", betting before
 * its deadline, or a result on show of a round it saw betting or closing
 * (a load or a wake shows every table's last result again, and must not
 * call a robot to each). It is quiet (level 1) for COMPUTED_LIVE_LINGER_MS
 * after, and at craps while bets ride on it; idle (0) otherwise. While a
 * record that came since waits for its signature check, what shows counts
 * for nothing and the table keeps its level, for the linger at most. Robots are
 * handed out (assignCroupiers): owner-run tables with a fresh heartbeat
 * first, as today; then tables in play, from the free robots or a quiet
 * table's; then quiet tables, from the free ones.
 */

import { casinoDocEpoch, casinoWhole, computedSettled, computedSwitchLost, isComputedFor, isComputedTable } from './casinoDoc';
import { computedDecidedTo, readComputedCraps, readComputedRoulette, STAGGER_MS } from './computedTable';
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
/** How many rounds' windows the call memory keeps (opened, closed). */
const WINDOW_ROUNDS = 8;
/** A void, in the memory of what was called. */
export const VOID = 'void';
/** How long a players' table keeps its robot after its last sign of play. */
export const COMPUTED_LIVE_LINGER_MS = 10_000;
/** How long past its deadline a roulette round with chips down still runs,
 *  waiting for its close (the first close turns, STAGGER_MS apart). */
export const COMPUTED_CLOSE_SLACK_MS = 3 * STAGGER_MS;
/** An avatar this near a stand's front stands at it (the walk-up's own
 *  test of a taken stand, World pickFreeStand). */
export const AT_STAND_M = 0.7;
/** What the robot calls a shooter whose name is nothing once cleaned. */
export const NAME_FALLBACK = 'the shooter';
/** A void's call (the status bar's ROLL VOID / NO SPIN in a robot's words). */
export const NO_SPIN_CALL = '⚠ No spin — stakes returned';
export const NO_ROLL_CALL = '⚠ No roll — every bet stands';
/** The stickman throws for a shooter whose wait ran out. */
export const TIMES_UP_CALL = "🎲 Time's up — the stickman throws";

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
  /** Round → the deadline of the betting window last opened on it, oldest
   *  first, WINDOW_ROUNDS kept: a view that flips to another round and back
   *  (a record deleted, then put back) is the same window. */
  opens: Map<number, number>;
  /** The round of the window last opened. */
  lastOpen: number | null;
  /** Round → the window last closed on it: the deadline of the window this
   *  page saw open on that round (null if it saw none). */
  closes: Map<number, number | null>;
  /** A result waiting for the wheel or dice (`r:value`), since `at`: on
   *  screen since then (a hold whose result leaves the screen ends). */
  hold: { id: string; at: number } | null;
  /** Craps: the wait for the holder's throw this page last saw (its roll,
   *  and when it ends on this page's clock), until that roll takes bets
   *  again. */
  wait: { r: number; until: number } | null;
  /** Craps: the roll whose time's up was said. */
  timesUp: number | null;
  /** What the page last showed, at its last frame since the records were
   *  first whole and checked (a frame whose records wait for a check too:
   *  the felt doesn't wait): the result (or void) on screen, whether the
   *  wheel or dice were still bringing it (`held`: moving, or the frame a
   *  drawn table waits for its felt to take it; not on screen yet), and the
   *  stickman's toss at a close the felt had shown. A wake counts them as
   *  said (wokeCalls), but a result still held. */
  seen: { result: { r: number; value: string } | null; held: boolean; toss: CloseToss | null } | null;
}

export type CallKind = 'open' | 'close' | 'result' | 'timesup';

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

/** The stickman's toss this page's felt showed at a roll's close
 *  (noteComputedToss): which roll, when. */
export interface CloseToss { inc: string; r: number; at: number }

export interface CallCtx {
  now: number;
  /** The last stickman's toss at a close on this table, if any. */
  toss: CloseToss | null;
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
  return { inc, primed: false, called: new Map(), opens: new Map(), lastOpen: null, closes: new Map(), hold: null, wait: null, timesUp: null, seen: null };
}

/** `r:value` of a spin or roll key, or null for '' (no result may show). */
function keyOf(v: TableView): { r: number; value: string } | null {
  const m = /^(\d+):(\d+)$/.exec(v.kind === 'roulette' ? v.spinKey : v.rollKey);
  return m ? { r: Number(m[1]), value: m[2] } : null;
}

/** Round r's entry set to v, the oldest dropped past `cap` (the latest last). */
function keep<V>(map: Map<number, V>, r: number, v: V, cap: number): void {
  map.delete(r);
  map.set(r, v);
  if (map.size > cap) map.delete(map.keys().next().value as number);
}

function remember(m: CallMemory, r: number, value: string): void {
  keep(m.called, r, value, CALLED_ROUNDS);
}

/** Every frame, before nextCall, saying nothing: a window's deadline that
 *  moved while it ran is the same window (a late re-show pushed it back); at
 *  craps the wait for the throw, as it stands, until its roll takes bets
 *  again (a window of its own: a rewrite of the roll before restarts it);
 *  a hold whose result left the screen ends (one that comes back waits for
 *  the wheel or dice afresh); and a hold started in the future is a clock
 *  gone back. */
export function observeCalls(m: CallMemory, v: TableView, now: number): void {
  const d = v.phaseDeadline;
  const was = m.opens.get(v.round);
  if (v.phase === 'betting' && d !== undefined && was !== undefined && was !== d && now < was) m.opens.set(v.round, d);
  if (v.kind === 'craps' && v.phase === 'closing' && v.shooterSlip !== undefined && d !== undefined) m.wait = { r: v.round, until: d };
  else if (m.wait?.r === v.round && v.phase === 'betting' && d !== undefined && now < d) m.wait = null;
  const k = keyOf(v);
  if (m.hold && (k === null || m.hold.id !== `${k.r}:${k.value}`)) m.hold = null;
  if (m.hold && m.hold.at > now) m.hold.at = now;
}

/** The records are whole and checked for the first time here: the result on
 *  show, or the one last shown, a void on show, and a toss already shown,
 *  count as said. Betting and its close are not marked, so a page that
 *  comes in during betting hears it open. */
export function primeCalls(m: CallMemory, v: TableView, toss: CloseToss | null = null): void {
  const k = keyOf(v);
  if (k) remember(m, k.r, k.value);
  if (v.phase === 'settled' && v.voided) remember(m, v.round, VOID);
  if (toss && toss.inc === m.inc) m.timesUp = toss.r;
  m.primed = true;
}

/** The result (or void) a view puts on screen, as remembered: a void only
 *  while on show. */
export function shownOf(v: TableView): { r: number; value: string } | null {
  return keyOf(v) ?? (v.phase === 'settled' && v.voided ? { r: v.round, value: VOID } : null);
}

/** A wake, or a clock gone back: what the page showed before it counts as
 *  said (as a load's priming counts what it finds). The result or void on
 *  screen at the last look, and the toss the felt had shown if its time's
 *  up was due, so a call the bubble refused until then isn't said late,
 *  over the show the wake brings again. A result the wheel or dice were
 *  still bringing isn't on screen yet: its hold starts again, and it is
 *  called as they stop. A toss the felt shows after the wake is a new one
 *  (so is one after a toss that came before this page's wait ran out). */
export function wokeCalls(m: CallMemory): void {
  const s = m.seen;
  if (!s) return;
  if (s.result && !s.held && m.called.get(s.result.r) !== s.result.value) remember(m, s.result.r, s.result.value);
  if (s.toss && s.toss.inc === m.inc && m.wait?.r === s.toss.r && s.toss.at >= m.wait.until) m.timesUp = s.toss.r;
  m.hold = null;
}

/** Whether the wheel or dice are still bringing result `k`, not on screen
 *  yet, as the hold has it: while they move, or on the frame a drawn table
 *  waits for its felt to take it (at craps only a roll on show is held).
 *  Never a void. */
function stillComing(game: GameName, v: TableView, m: CallMemory, k: { r: number; value: string } | null, ctx: Pick<CallCtx, 'now' | 'moving' | 'drawn'>): boolean {
  if (k === null || k.value === VOID || !(game === 'roulette' || (v.phase === 'settled' && v.round === k.r))) return false;
  return ctx.moving || (ctx.drawn && m.hold?.id === `${k.r}:${k.value}` && ctx.now <= m.hold.at);
}

/**
 * The call due at the table this frame, if any, first that applies: time's
 * up (craps: this page showed the stickman's toss at the close of a roll
 * whose wait it saw run out, and hasn't called its result; only while that
 * roll is on screen, closing or on show), the result (once the wheel or
 * dice stop), no more bets, place your bets. One a frame; the next comes on
 * a later frame. Nothing is remembered until callSaid, except a round first
 * seen after its show.
 */
export function nextCall(game: GameName, v: TableView, m: CallMemory, ctx: CallCtx): TableCall | null {
  const toss = ctx.toss;
  if (game === 'craps' && toss && toss.inc === v.inc && v.round === toss.r && v.phase !== 'betting'
    && m.wait?.r === toss.r && toss.at >= m.wait.until && m.timesUp !== toss.r && !m.called.has(toss.r)) {
    return { kind: 'timesup', key: `${v.inc}|${toss.r}|timesup`, text: TIMES_UP_CALL, r: toss.r };
  }
  const k = keyOf(v);
  if (k && m.called.get(k.r) !== k.value) {
    const onShow = v.phase === 'settled' && v.round === k.r;
    const before = m.called.has(k.r);
    if (!onShow && !before) remember(m, k.r, k.value);
    else {
      const id = `${k.r}:${k.value}`;
      const since = m.hold?.id === id ? m.hold.at : null;
      // On a drawn table it waits a frame first, for the felt to take it,
      // then while the wheel spins or the dice fly. (At craps only a roll on
      // show moves: an earlier one's faces turn at rest, never in the air.)
      const waits = game === 'craps' && !onShow ? false : since === null
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
  // (Not for a round called already, or one before the window last opened:
  // held again after a wake, or back to its close for an undo.)
  if (v.phase === 'closing' && !m.called.has(v.round) && !(m.lastOpen !== null && m.lastOpen > v.round)) {
    const window = m.opens.get(v.round) ?? null;
    if (m.closes.has(v.round) && m.closes.get(v.round) === window) return null;
    const text = (v.kind === 'craps' ? waitText(v, ctx.name, ctx.now) : null) ?? '✋ No more bets!';
    return { kind: 'close', key: `${v.inc}|${v.round}|close|${window ?? ''}`, text, r: v.round, window };
  }
  const d = v.phaseDeadline;
  if (v.phase === 'betting' && d !== undefined && ctx.now < d && m.opens.get(v.round) !== d) {
    const text = (v.kind === 'roulette' ? croupierBeatLine(v) : crapsBeatLine(v))?.text;
    if (text) return { kind: 'open', key: `${v.inc}|${v.round}|open|${d}`, text, r: v.round, deadline: d };
  }
  return null;
}

/** The call was said (or dropped unsaid at an idle table): remember it. */
export function callSaid(m: CallMemory, c: TableCall): void {
  if (c.kind === 'open') {
    keep(m.opens, c.r, c.deadline!, WINDOW_ROUNDS);
    m.lastOpen = c.r;
  } else if (c.kind === 'close') keep(m.closes, c.r, c.window ?? null, WINDOW_ROUNDS);
  else if (c.kind === 'timesup') m.timesUp = c.r;
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

/** One table's liveness on this page: the last time it was in play, the
 *  rounds of one incarnation this page saw run (betting before its
 *  deadline, or closing; the latest RAN_ROUNDS), so a result shown again
 *  after a load or a wake isn't one, and a rewrite's on a round it saw is;
 *  the clock at its last frame, the level it gave then, and since when its
 *  records wait for their check (null while none does). */
export interface LiveMemory {
  hotAt: number | null;
  ran: { inc: string; rounds: number[] } | null;
  at: number | null;
  last: Level;
  waitsFrom: number | null;
}

export function newLiveMemory(): LiveMemory {
  return { hotAt: null, ran: null, at: null, last: 0, waitsFrom: null };
}

const RAN_ROUNDS = 8;

/** What the view rests on: whether this page has counted the table's
 *  records whole and checked (the robot's call memory primed, and no record
 *  waiting for its check now: a view before that may show a close whose
 *  reveals or forfeit aren't checked yet); whether, primed, a record that
 *  came since waits for its check now (`waits`); and the last round it
 *  holds decided. */
export interface LiveSeen { checked: boolean; waits?: boolean; decidedTo: number | null }

const SEEN_ANYWAY: LiveSeen = { checked: true, decidedTo: null };

/** Whether the view shows a round running, by this page's clock: past no
 *  more bets (but not a decided round held again for its forfeit's grace,
 *  as a load or a wake shows the last one, unless this page saw it run),
 *  betting before its deadline (at roulette, with chips down, a little past
 *  it for the close), or the result of a round this page saw run. */
export function roundRuns(v: TableView, ran: LiveMemory['ran'], now: number, decidedTo: number | null = null): boolean {
  const saw = ran !== null && ran.inc === v.inc && ran.rounds.includes(v.round);
  if (v.phase === 'closing') return saw || decidedTo === null || v.round > decidedTo;
  if (v.phase === 'betting') return v.phaseDeadline !== undefined && now < v.phaseDeadline + (v.kind === 'roulette' ? COMPUTED_CLOSE_SLACK_MS : 0);
  return saw;
}

/** The table's level this frame (the memory moves with it). With no view
 *  (just after the switch, a lost switch), or one not yet checked, only
 *  someone standing there and the linger count. While a record that came
 *  since waits for its check, the table keeps the level it had, for the
 *  linger at most (a catch-up's checks take a few frames: a round in play
 *  keeps its robot), and nothing that shows counts. A clock gone back keeps
 *  what was left of the linger, and of the wait's. */
export function liveStep(m: LiveMemory, v: TableView | null, someoneThere: boolean, now: number, seen: LiveSeen = SEEN_ANYWAY): Level {
  if (m.at !== null && now < m.at) {
    if (m.hotAt !== null) m.hotAt = now - (m.at - m.hotAt);
    if (m.waitsFrom !== null) m.waitsFrom = now - (m.at - m.waitsFrom);
  }
  m.at = now;
  m.waitsFrom = seen.waits === true ? m.waitsFrom ?? now : null;
  return m.last = levelOf(m, v, someoneThere, now, seen);
}

function levelOf(m: LiveMemory, v: TableView | null, someoneThere: boolean, now: number, seen: LiveSeen): Level {
  if (m.waitsFrom !== null && !someoneThere && now - m.waitsFrom < COMPUTED_LIVE_LINGER_MS) return m.last;
  const view = seen.checked ? v : null;
  const opens = view?.phase === 'betting' && view.phaseDeadline !== undefined && now < view.phaseDeadline;
  if (view && (opens || (view.phase === 'closing' && roundRuns(view, m.ran, now, seen.decidedTo)))) {
    if (m.ran?.inc !== view.inc) m.ran = { inc: view.inc, rounds: [] };
    if (!m.ran.rounds.includes(view.round)) {
      m.ran.rounds.push(view.round);
      if (m.ran.rounds.length > RAN_ROUNDS) m.ran.rounds.shift();
    }
  }
  if (someoneThere || (view !== null && roundRuns(view, m.ran, now, seen.decidedTo))) {
    m.hotAt = now;
    return 2;
  }
  if (m.hotAt !== null && now - m.hotAt < COMPUTED_LIVE_LINGER_MS) return 1;
  return view?.kind === 'craps' && view.riders > 0 ? 1 : 0;
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
/** Per table, the stickman's tosses this page's felt showed: how many, how
 *  many of them the robot's arm took (takeComputedTosses), and the last one
 *  at a close. */
const tosses = new Map<string, { n: number; taken: number; close: CloseToss | null }>();
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
  tosses.clear();
}

/** A wake (tablesWakeCount), or a clock gone back a second or more, forgets
 *  which rounds this page saw run: every table's last result shows again,
 *  and what each showed before counts as said (wokeCalls). */
function sameWake(now: number): void {
  const n = tablesWakeCount();
  if (n !== wakes || (lastAt !== null && lastAt - now >= TABLE_CLOCK_SLACK_MS)) {
    if (wakes !== null) for (const m of calls.values()) wokeCalls(m);
    wakes = n;
    for (const m of live.values()) wokeLive(m, now);
  }
  lastAt = now;
}

/** A wake, or a clock gone back, for one table's liveness: the rounds seen
 *  run forgotten, and no level in play kept from before it (a wait for the
 *  checks that comes next keeps only what the linger leaves). */
export function wokeLive(m: LiveMemory, now: number): void {
  m.ran = null;
  m.waitsFrom = null;
  if (m.last !== 2) return;
  const since = m.hotAt === null ? null : m.at !== null && now < m.at ? m.at - m.hotAt : now - m.hotAt;
  m.last = since !== null && since < COMPUTED_LIVE_LINGER_MS ? 1 : 0;
}

const nameOf: NameOf = (pid) => speakableName(readPlayerDisplayName(pid));

/** A decided round shown closing: held again for its forfeit's grace. */
const heldAgain = (v: TableView, decidedTo: number | null): boolean => v.phase === 'closing' && decidedTo !== null && v.round <= decidedTo;

function viewOf(t: string, game: GameName, now: number): TableView | null {
  return game === 'craps' ? readComputedCraps(t, now) : readComputedRoulette(t, now);
}

/**
 * The call due at players' table `t` this frame, from the table as this page
 * shows it, or null. Null too until its records are first whole and checked
 * here (casinoWhole, computedSettled: the felt's own start), while a record
 * that came since waits for its check, and while the page has nothing of it
 * to show (a lost switch keeps what was said). The
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
    // the felt asks. A load shows a last round a forfeit decided held again
    // for its grace: primed at its show, so its result counts as said.)
    if (casinoWhole(t) && computedSettled(t) && !heldAgain(v, computedDecidedTo(t, game))) primeCalls(m, v, tosses.get(t)?.close ?? null);
    return null;
  }
  const toss = tosses.get(t)?.close ?? null;
  const shown = shownOf(v);
  const ctx: CallCtx = { now, moving, drawn, toss, name: nameOf };
  // (Nor while a record that came since waits for its check: what shows may
  // be part of a fold. The felt shows it all the same, for a wake to count.)
  if (!computedSettled(t)) {
    m.seen = { result: shown, held: stillComing(game, v, m, shown, ctx), toss };
    return null;
  }
  const call = nextCall(game, v, m, ctx);
  m.seen = { result: shown, held: stillComing(game, v, m, shown, ctx), toss };
  return call;
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
    m = newLiveMemory();
    live.set(t, m);
  }
  const v = viewOf(t, game, now);
  const said = calls.get(t);
  // (Only of the game the table is: a read of the other's would let go of
  // this page's state for its own. Checked: primed, and nothing waits for
  // its check now.)
  const primed = said?.primed === true && said.inc === v?.inc;
  const settled = computedSettled(t);
  return liveStep(m, v, someoneThere, now, { checked: primed && settled, waits: primed && !settled, decidedTo: computedDecidedTo(t, game) });
}

/** The felt showed the stickman's toss at players' craps table `t` for roll
 *  `round` of incarnation `inc` (casinoTableSession): at the roll's close
 *  (`atClose`), or again for a rewrite. Never for a shooter's own throw, nor
 *  an owner-run table's stand-in toss. */
export function noteComputedToss(t: string, inc: string, round: number, atClose: boolean, now = Date.now()): void {
  sameDoc();
  const e = tosses.get(t) ?? { n: 0, taken: 0, close: null };
  e.n += 1;
  if (atClose) e.close = { inc, r: round, at: now };
  tosses.set(t, e);
}

/** How many stickman's tosses the felt showed at table `t` since the last
 *  call (noteComputedToss): World swings the arm of the robot posted there. */
export function takeComputedTosses(t: string): number {
  sameDoc();
  const e = tosses.get(t);
  if (!e) return 0;
  const n = e.n - e.taken;
  e.taken = e.n;
  return n;
}

/** Table `t` left the room: forget it. */
export function forgetComputedTable(t: string): void {
  calls.delete(t);
  live.delete(t);
  tosses.delete(t);
}
