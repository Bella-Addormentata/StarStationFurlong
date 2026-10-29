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
 * The result waits while this page's wheel spins or its dice fly (at most
 * RESULT_HOLD_MAX_MS), so the robot never gives it away.
 */

import { casinoDocEpoch, casinoWhole, computedSettled } from './casinoDoc';
import { readComputedCraps, readComputedRoulette } from './computedTable';
import type { ComputedCrapsState, ComputedRouletteState } from './computedTable';
import type { GameName } from './computedFold';
import { croupierBeatLine } from './croupier';
import { crapsBeatLine } from './crapsCroupier';
import { readPlayerDisplayName } from './games/gamesDoc';
import { pocketColor } from './games/roulette';
import { PLAYER_NAME_MAX_LENGTH } from './identity';

/** The longest a result call waits for this page's wheel or dice to stop. */
export const RESULT_HOLD_MAX_MS = 8_000;
/** Rounds whose result call a page remembers per table (the felt's own
 *  memory of what it spun or threw keeps as many). */
export const CALLED_ROUNDS = 64;
/** A void, in the memory of what was called. */
export const VOID = 'void';
/** What the robot calls a shooter whose name is nothing once cleaned. */
export const NAME_FALLBACK = 'the shooter';
/** A void's call (the status bar's ROLL VOID / NO SPIN in a robot's words). */
export const NO_SPIN_CALL = '⚠ No spin — stakes returned';
export const NO_ROLL_CALL = '⚠ No roll — every bet stands';

export type TableView = ComputedRouletteState | ComputedCrapsState;
export type NameOf = (pid: string) => string;

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
      const held = m.hold?.id === id ? m.hold.at : null;
      if (ctx.moving && (held === null || ctx.now - held < RESULT_HOLD_MAX_MS)) {
        if (held === null) m.hold = { id, at: ctx.now };
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

// ── 📄 This page's memory, by table ──────────────────────────────────────────

const calls = new Map<string, CallMemory>();
let docEpoch: number | null = null;

/** A new room doc (casinoDocEpoch) starts every table afresh. */
function sameDoc(): void {
  const epoch = casinoDocEpoch();
  if (epoch === docEpoch) return;
  docEpoch = epoch;
  calls.clear();
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
export function computedTableCall(t: string, game: GameName, now = Date.now(), moving = false): TableCall | null {
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
  return nextCall(game, v, m, { now, moving, name: nameOf });
}

/** The call computedTableCall gave was said, or dropped unsaid. */
export function noteComputedCallSaid(t: string, c: TableCall): void {
  const m = calls.get(t);
  if (m && c.key.startsWith(`${m.inc}|`)) callSaid(m, c);
}

/** Table `t` left the room: forget it. */
export function forgetComputedTable(t: string): void {
  calls.delete(t);
}
