/**
 * 📦 tvAutoFetch — FETCH without a press, within the viewer's cap, budget and
 * switch, once per file per page; and what a browser without storage keeps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  autoFetchOn, autoFetchSpent, autoFetchVerdict, noteAutoFetch, resetAutoFetchForTest, setAutoFetchOn,
  TV_AUTO_FETCH_DAY, TV_AUTO_FETCH_MAX, TV_AUTO_FETCH_WINDOW_MS,
} from './tvAutoFetch';

const store = new Map<string, string>();
let throwing = false;
/** Writes only: a full quota, reads still answering. */
let full = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => { if (throwing) throw new Error('blocked'); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (throwing || full) throw new Error('blocked'); store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const GB = 2 ** 30;
const hash = (n: number) => n.toString(16).padStart(64, '0');

beforeEach(() => {
  store.clear();
  throwing = false;
  full = false;
  resetAutoFetchForTest();
});

describe('AUTO-FETCH', () => {
  it('is on by default, and the viewer\'s switch turns it off and on again', () => {
    expect(autoFetchOn()).toBe(true);
    expect(autoFetchVerdict(hash(1), GB)).toBe('go');
    setAutoFetchOn(false);
    expect(autoFetchOn()).toBe(false);
    expect(autoFetchVerdict(hash(1), GB)).toBe('off');
    setAutoFetchOn(true);
    expect(autoFetchVerdict(hash(1), GB)).toBe('go');
  });

  it('takes a file up to the cap, never one past it or of a size no file has', () => {
    expect(autoFetchVerdict(hash(1), TV_AUTO_FETCH_MAX)).toBe('go');
    expect(autoFetchVerdict(hash(1), TV_AUTO_FETCH_MAX + 1)).toBe('big');
    expect(autoFetchVerdict(hash(1), -1)).toBe('big');
    expect(autoFetchVerdict(hash(1), 1.5)).toBe('big');
  });

  it('asks for each file once per page, and keeps to the day\'s budget, which refills as a day passes', () => {
    const t0 = 1_800_000_000_000;
    noteAutoFetch(hash(1), 2 * GB, t0);
    expect(autoFetchVerdict(hash(1), 2 * GB, t0)).toBe('asked'); // a failure is not retried by itself
    noteAutoFetch(hash(2), 2 * GB, t0 + 1);
    noteAutoFetch(hash(3), 2 * GB, t0 + 2);
    expect(autoFetchSpent(t0 + 3)).toBe(6 * GB);
    expect(autoFetchVerdict(hash(4), 2 * GB, t0 + 3)).toBe('go'); // exactly the day's 8 GB
    noteAutoFetch(hash(4), 2 * GB, t0 + 3);
    expect(autoFetchVerdict(hash(5), 1, t0 + 4)).toBe('day');
    expect(autoFetchSpent(t0 + 4)).toBe(TV_AUTO_FETCH_DAY);
    // A day after the first: its 2 GB are free again.
    expect(autoFetchVerdict(hash(5), 2 * GB, t0 + TV_AUTO_FETCH_WINDOW_MS)).toBe('go');
    expect(autoFetchSpent(t0 + TV_AUTO_FETCH_WINDOW_MS)).toBe(6 * GB);
  });

  it('shares the switch and the budget through storage (another tab of this browser), and reads garbage there as nothing spent', () => {
    const t0 = 1_800_000_000_000;
    noteAutoFetch(hash(1), 7 * GB, t0);
    resetAutoFetchForTest(); // another page: its own asks, the browser's budget
    expect(autoFetchVerdict(hash(1), GB, t0 + 1)).toBe('go');
    expect(autoFetchVerdict(hash(2), GB + 1, t0 + 1)).toBe('day');
    store.set('ssf-tv-auto-fetch', '0');
    expect(autoFetchOn()).toBe(false);
    store.set('ssf-tv-auto-fetch-spent', 'not json');
    store.delete('ssf-tv-auto-fetch');
    expect(autoFetchSpent(t0)).toBe(0);
    store.set('ssf-tv-auto-fetch-spent', JSON.stringify([{ at: t0, size: -5 }, { at: 'x', size: GB }, null, { at: t0, size: GB }]));
    expect(autoFetchSpent(t0)).toBe(GB);
  });

  it('a clock set back still counts what was fetched: a spend stamped ahead of now is never forgotten early', () => {
    const t0 = 1_800_000_000_000;
    noteAutoFetch(hash(1), 8 * GB, t0);
    expect(autoFetchVerdict(hash(2), 1, t0 - 60 * 60 * 1000)).toBe('day');
  });

  it('holds for the page where storage throws (a private window): on by default, the switch and the spend kept in memory', () => {
    throwing = true;
    expect(autoFetchOn()).toBe(true);
    setAutoFetchOn(false);
    expect(autoFetchOn()).toBe(false);
    setAutoFetchOn(true);
    const t0 = 1_800_000_000_000;
    noteAutoFetch(hash(1), 8 * GB, t0);
    expect(autoFetchVerdict(hash(2), 1, t0 + 1)).toBe('day');
  });

  it('holds where storage reads but will not write (its quota full): the switch turned off stays off, and the spend still counts', () => {
    const t0 = 1_800_000_000_000;
    noteAutoFetch(hash(1), 4 * GB, t0); // kept in storage
    full = true;
    setAutoFetchOn(false);
    expect(autoFetchOn()).toBe(false); // storage still says on; this page said off
    expect(autoFetchVerdict(hash(2), GB, t0 + 1)).toBe('off');
    setAutoFetchOn(true);
    noteAutoFetch(hash(2), 2 * GB, t0 + 1); // storage would not take it
    noteAutoFetch(hash(3), 2 * GB, t0 + 2);
    expect(autoFetchSpent(t0 + 3)).toBe(8 * GB);
    expect(autoFetchVerdict(hash(4), 1, t0 + 3)).toBe('day');
    full = false;
    noteAutoFetch(hash(4), 0, t0 + 4); // the next write storage takes keeps all of it
    resetAutoFetchForTest(); // another page
    expect(autoFetchSpent(t0 + 5)).toBe(8 * GB);
    setAutoFetchOn(false);
    full = true;
    setAutoFetchOn(true);
    expect(autoFetchOn()).toBe(true);
    full = false;
    setAutoFetchOn(false);
    expect(autoFetchOn()).toBe(false); // a write taken: storage speaks again
  });

  it('never forgets a spend to keep its record short: a hundred small files still add up to the day\'s budget', () => {
    const t0 = 1_800_000_000_000;
    const small = 100 * 2 ** 20;
    let n = 0;
    while (n < 200 && autoFetchVerdict(hash(n + 1), small, t0 + n) === 'go') {
      noteAutoFetch(hash(n + 1), small, t0 + n);
      n++;
    }
    expect(n).toBe(Math.floor(TV_AUTO_FETCH_DAY / small)); // 81 files, past the 64 entries kept
    expect(autoFetchVerdict(hash(n + 1), small, t0 + n)).toBe('day');
    expect(autoFetchSpent(t0 + n)).toBe(n * small);
    expect((JSON.parse(store.get('ssf-tv-auto-fetch-spent')!) as unknown[]).length).toBeLessThanOrEqual(64);
  });

  it('counts each spend once where storage holds a full record and will not take the next: nothing it holds is counted again', () => {
    const t0 = 1_800_000_000_000;
    const small = 100 * 2 ** 20;
    for (let i = 0; i < 64; i++) noteAutoFetch(hash(i + 1), small, t0 + i);
    expect(autoFetchSpent(t0 + 64)).toBe(64 * small);
    full = true;
    for (let i = 64; i < 70; i++) noteAutoFetch(hash(i + 1), small, t0 + i);
    expect(autoFetchSpent(t0 + 70)).toBe(70 * small);
    full = false;
    noteAutoFetch(hash(71), small, t0 + 70);
    resetAutoFetchForTest(); // another page reads what storage now holds
    expect(autoFetchSpent(t0 + 71)).toBe(71 * small);
  });
});
