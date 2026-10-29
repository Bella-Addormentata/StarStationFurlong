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
 */

import type { ComputedCrapsState, ComputedRouletteState } from './computedTable';
import type { GameName } from './computedFold';
import { croupierBeatLine } from './croupier';
import { crapsBeatLine } from './crapsCroupier';
import { pocketColor } from './games/roulette';
import { PLAYER_NAME_MAX_LENGTH } from './identity';

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
