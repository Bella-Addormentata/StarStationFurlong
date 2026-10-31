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
 *   what this browser asked for, kept with the switch — every ask at least
 *   TV_AUTO_FETCH_MIN_CHARGE, so tiny files put on one after another (each
 *   refused, say) buy a bounded number of asks a day, not an endless run.
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
/** What an ask counts against the day at the least: 128 asks a day. */
export const TV_AUTO_FETCH_MIN_CHARGE = 64 * 2 ** 20;

/** One kind of fetch without a press: its cap per file, its budget per day
 *  and the least an ask is charged, and where its switch and spends are
 *  kept in this browser. The TV's is below; the room boards' photos have
 *  their own (boardPhotos.ts, #315), with photo-sized numbers. */
export interface AutoFetchRules {
  max: number;
  day: number;
  minCharge: number;
  switchKey: string;
  spentKey: string;
}

export type AutoFetchVerdict = 'go' | 'off' | 'big' | 'day' | 'asked';

export interface AutoFetchBudget {
  readonly rules: Readonly<AutoFetchRules>;
  on(): boolean;
  setOn(on: boolean): void;
  /** What this browser has fetched by itself in the last day, in bytes. */
  spent(now?: number): number;
  /** May it ask for `hash` (`size` bytes) by itself now? */
  verdict(hash: string, size: number, now?: number): AutoFetchVerdict;
  /** It asked for `hash` by itself: counted against the day, and never
   *  asked for by itself again from this page. */
  note(hash: string, size: number, now?: number): void;
  /** A press took the ask for `hash`: no ask of its own for it from this
   *  page, and nothing charged. */
  notePressed(hash: string): void;
  /** Tests: a fresh page. */
  reset(): void;
}

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

export function makeAutoFetch(rules: AutoFetchRules): AutoFetchBudget {
  const charge = (size: number): number => Math.max(size, rules.minCharge);
  /** What this page could not keep in storage — one that throws on every
   *  call (a private window, blocked site data), or only on a write (its
   *  quota full) — and that holds for this page all the same: its switch
   *  over what storage says, and the spends storage did not take (those
   *  alone: what storage holds is read from storage) on top of what it
   *  holds. Cleared by the next write that storage takes. Otherwise storage
   *  is read every time, so two tabs share one budget and one switch. */
  let switchHere: boolean | null = null;
  let spentHere: Spend[] | null = null;
  /** The files this page has asked for by itself. */
  const asked = new Set<string>();

  const on = (): boolean => {
    if (switchHere !== null) return switchHere;
    try { return localStorage.getItem(rules.switchKey) !== '0'; } catch { return true; }
  };

  const readSpent = (now: number): Spend[] => {
    let stored: unknown = [];
    try {
      stored = JSON.parse(localStorage.getItem(rules.spentKey) ?? '[]');
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
  };

  const spent = (now = Date.now()): number => readSpent(now).reduce((sum, e) => sum + e.size, 0);

  return {
    rules,
    on,
    setOn(next: boolean): void {
      try {
        localStorage.setItem(rules.switchKey, next ? '1' : '0');
        switchHere = null;
      } catch {
        switchHere = next;
      }
    },
    spent,
    verdict(hash: string, size: number, now = Date.now()): AutoFetchVerdict {
      if (!on()) return 'off';
      if (asked.has(hash)) return 'asked';
      if (!Number.isSafeInteger(size) || size < 0 || size > rules.max) return 'big';
      if (spent(now) + charge(size) > rules.day) return 'day';
      return 'go';
    },
    note(hash: string, size: number, now = Date.now()): void {
      asked.add(hash);
      const spend = { at: now, size: charge(size), h: hash.slice(0, 16) };
      try {
        localStorage.setItem(rules.spentKey, JSON.stringify(compact([...readSpent(now), spend])));
        spentHere = null;
      } catch {
        // Folded only among themselves (none of them is in storage to be
        // counted twice), and only those still inside the day: a spend that
        // has expired, folded into a newer one, would count for another day.
        spentHere = compact([...(spentHere ?? []).filter((e) => now - e.at < TV_AUTO_FETCH_WINDOW_MS), spend]);
      }
    },
    notePressed(hash: string): void {
      asked.add(hash);
    },
    reset(): void {
      switchHere = null;
      spentHere = null;
      asked.clear();
    },
  };
}

/** The theatre's: its switch and spends under the keys they always had. */
const tv = makeAutoFetch({
  max: TV_AUTO_FETCH_MAX,
  day: TV_AUTO_FETCH_DAY,
  minCharge: TV_AUTO_FETCH_MIN_CHARGE,
  switchKey: 'ssf-tv-auto-fetch',
  spentKey: 'ssf-tv-auto-fetch-spent',
});

export const autoFetchOn = (): boolean => tv.on();
export const setAutoFetchOn = (on: boolean): void => tv.setOn(on);

/** What this browser has fetched by itself in the last day, in bytes (each
 *  ask at least TV_AUTO_FETCH_MIN_CHARGE). */
export const autoFetchSpent = (now = Date.now()): number => tv.spent(now);

/** May the theatre ask for `hash` (`size` bytes) by itself now? */
export const autoFetchVerdict = (hash: string, size: number, now = Date.now()): AutoFetchVerdict => tv.verdict(hash, size, now);

/** The theatre asked for `hash` by itself: counted against the day, and
 *  never asked for by itself again from this page. */
export const noteAutoFetch = (hash: string, size: number, now = Date.now()): void => tv.note(hash, size, now);

/** A press took the ask for `hash` (FETCH): AUTO-FETCH makes none of its
 *  own for it from this page, and charges the day nothing for it — the
 *  press's answer may still be on its way, with the file's state reading
 *  'none' until it lands. */
export const notePressedFetch = (hash: string): void => tv.notePressed(hash);

/** Tests: a fresh page. */
export const resetAutoFetchForTest = (): void => tv.reset();
