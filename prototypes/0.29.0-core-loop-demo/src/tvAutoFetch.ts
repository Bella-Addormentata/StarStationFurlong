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
/** Entries kept: the oldest are folded together past this (compact), never
 *  dropped, so the record stays small and every byte still counts. */
const SPENT_MAX = 64;

interface Spend {
  at: number;
  size: number;
  /** The file's first digits: two asks for the same file at the same
   *  moment, read from storage and from this page, are one. */
  h: string;
}

/** What this page could not keep in storage — one that throws on every
 *  call (a private window, blocked site data), or only on a write (its
 *  quota full) — and that holds for this page all the same: its switch
 *  over what storage says, its spend on top of what storage holds. Cleared
 *  by the next write that storage takes. Otherwise storage is read every
 *  time, so two tabs share one budget and one switch. */
let switchHere: boolean | null = null;
let spentHere: Spend[] | null = null;
/** The files this page has asked for by itself. */
const asked = new Set<string>();

export function autoFetchOn(): boolean {
  if (switchHere !== null) return switchHere;
  try { return localStorage.getItem(SWITCH_KEY) !== '0'; } catch { return true; }
}

export function setAutoFetchOn(on: boolean): void {
  try {
    localStorage.setItem(SWITCH_KEY, on ? '1' : '0');
    switchHere = null;
  } catch {
    switchHere = on;
  }
}

function spends(list: unknown): Spend[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is Spend => !!e && typeof e === 'object'
      && Number.isFinite((e as Spend).at) && Number.isSafeInteger((e as Spend).size) && (e as Spend).size >= 0)
    .map((e) => ({ at: e.at, size: e.size, h: typeof e.h === 'string' ? e.h.slice(0, 16) : '' }));
}

/** At most SPENT_MAX entries, oldest first: the two oldest are folded into
 *  one stamped at the later of them, so a spend is never forgotten, only
 *  counted a little longer than its day. */
function compact(list: Spend[]): Spend[] {
  const out = [...list].sort((a, b) => a.at - b.at);
  while (out.length > SPENT_MAX) {
    const [a, b] = out.splice(0, 2);
    out.unshift({ at: b.at, size: Math.min(Number.MAX_SAFE_INTEGER, a.size + b.size), h: b.h });
  }
  return out;
}

function readSpent(now: number): Spend[] {
  let stored: unknown = [];
  try {
    stored = JSON.parse(localStorage.getItem(SPENT_KEY) ?? '[]');
  } catch {
    stored = []; // storage that throws (then spentHere is all there is), or a value that is not JSON
  }
  const seen = new Set<string>();
  return compact([...spends(stored), ...(spentHere ?? [])]
    // A spend stamped ahead of now (a clock set back) still counts until it
    // is a day old by the clock as it reads now: never forgotten early.
    .filter((e) => now - e.at < TV_AUTO_FETCH_WINDOW_MS)
    .filter((e) => {
      const k = `${e.at}:${e.size}:${e.h}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }));
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
  const list = compact([...readSpent(now), { at: now, size, h: hash.slice(0, 16) }]);
  try {
    localStorage.setItem(SPENT_KEY, JSON.stringify(list));
    spentHere = null;
  } catch {
    spentHere = list;
  }
}

/** Tests: a fresh page. */
export function resetAutoFetchForTest(): void {
  switchHere = null;
  spentHere = null;
  asked.clear();
}
