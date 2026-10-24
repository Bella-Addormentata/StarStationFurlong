/**
 * 📦 tvAutoFetch — the theatre's FETCH without a press, for a viewer who
 * walks into a room where a TV is showing a file from a member's node (FILE,
 * a torrent): their node starts taking it at once, and the set plays it at
 * the room's time once it is whole (Dorkmo 2026-10-24; media plan §4's
 * "automatic prefetch under a viewer's cap and budget").
 *
 * What the press used to bound, these bound now — a room member can put
 * any file on the set, and every viewer's disk and link would follow:
 *
 * - **A cap per file**: TV_AUTO_FETCH_MAX. A bigger file keeps FETCH.
 * - **A budget per day**: TV_AUTO_FETCH_DAY over the last 24 h, counted from
 *   what this browser asked for, kept with the switch.
 * - **One at a time**: the theatre asks for no second file while the last
 *   one it asked for is still on its way (the theatre's own check).
 * - **Once per file per page**: an ask that failed or was refused is not
 *   repeated by itself; FETCH is there, with why.
 * - **The viewer's switch**: AUTO-FETCH on the theatre's bar, on by default,
 *   kept in this browser.
 *
 * The node's own gates hold as for a press: it dials only nodes connected
 * in this room, checks every byte against the hash, and keeps its quota.
 */

export const TV_AUTO_FETCH_MAX = 2 * 2 ** 30;
export const TV_AUTO_FETCH_DAY = 8 * 2 ** 30;
export const TV_AUTO_FETCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const SWITCH_KEY = 'ssf-tv-auto-fetch';
const SPENT_KEY = 'ssf-tv-auto-fetch-spent';
/** Entries kept: well past what the budget allows in a day at any size. */
const SPENT_MAX = 64;

interface Spend {
  at: number;
  size: number;
}

/** The session's copy, used only where this browser's storage throws (a
 *  private window, blocked site data): the switch and the day's spend
 *  still hold for this page. Otherwise storage is read every time, so two
 *  tabs share one budget and one switch. */
let switchHere: boolean | null = null;
let spentHere: Spend[] | null = null;
/** The files this page has asked for by itself. */
const asked = new Set<string>();

export function autoFetchOn(): boolean {
  try { return localStorage.getItem(SWITCH_KEY) !== '0'; } catch { return switchHere ?? true; }
}

export function setAutoFetchOn(on: boolean): void {
  try { localStorage.setItem(SWITCH_KEY, on ? '1' : '0'); } catch { switchHere = on; }
}

function readSpent(now: number): Spend[] {
  let list: unknown;
  try {
    list = JSON.parse(localStorage.getItem(SPENT_KEY) ?? '[]');
  } catch {
    list = spentHere ?? []; // storage that throws, or a value that is not JSON (then nothing is known spent)
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is Spend => !!e && typeof e === 'object'
      && Number.isFinite((e as Spend).at) && Number.isSafeInteger((e as Spend).size) && (e as Spend).size >= 0)
    // A spend stamped ahead of now (a clock set back) still counts until it
    // is a day old by the clock as it reads now: never forgotten early.
    .filter((e) => now - e.at < TV_AUTO_FETCH_WINDOW_MS)
    .slice(-SPENT_MAX);
}

/** What this browser has fetched by itself in the last day, in bytes. */
export function autoFetchSpent(now = Date.now()): number {
  return readSpent(now).reduce((sum, e) => sum + e.size, 0);
}

export type AutoFetchVerdict = 'go' | 'off' | 'big' | 'day' | 'asked';

/** May the theatre ask for `hash` (`size` bytes) by itself now? */
export function autoFetchVerdict(hash: string, size: number, now = Date.now()): AutoFetchVerdict {
  if (!autoFetchOn()) return 'off';
  if (asked.has(hash)) return 'asked';
  if (!Number.isSafeInteger(size) || size < 0 || size > TV_AUTO_FETCH_MAX) return 'big';
  if (autoFetchSpent(now) + size > TV_AUTO_FETCH_DAY) return 'day';
  return 'go';
}

/** The theatre asked for `hash` by itself: counted against the day, and
 *  never asked for by itself again from this page. */
export function noteAutoFetch(hash: string, size: number, now = Date.now()): void {
  asked.add(hash);
  const list = [...readSpent(now), { at: now, size }].slice(-SPENT_MAX);
  spentHere = list;
  try { localStorage.setItem(SPENT_KEY, JSON.stringify(list)); } catch { /* session-only: spentHere */ }
}

/** Tests: a fresh page. */
export function resetAutoFetchForTest(): void {
  switchHere = null;
  spentHere = null;
  asked.clear();
}
