// blockList.ts unit tests: persistence round-trips, listener fan-out, the
// pure `isAuthoredByBlocked` / `filterOutBlocked` / `partitionRosterByBlocked`
// helpers, and the two ways an author is scored (canonical `authorPub` vs the
// legacy `authorId` resolved via the players map).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest runs on node — supply an in-memory localStorage shim BEFORE the module
// under test reads it. The blockList module uses only getItem/setItem/removeItem.
const memoryStore = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (memoryStore.has(k) ? (memoryStore.get(k) as string) : null),
  setItem: (k: string, v: string) => { memoryStore.set(k, String(v)); },
  removeItem: (k: string) => { memoryStore.delete(k); },
  clear: () => memoryStore.clear(),
  key: (i: number) => [...memoryStore.keys()][i] ?? null,
  get length() { return memoryStore.size; },
} as Storage;

import {
  __resetBlockListForTests,
  blockedSet,
  filterOutBlocked,
  initBlockList,
  isAuthoredByBlocked,
  isBlockListInitialized,
  isBlocked,
  listBlocked,
  partitionRosterByBlocked,
  setBlocked,
  subscribeBlockList,
} from './blockList';

beforeEach(() => {
  memoryStore.clear();
  __resetBlockListForTests();
});

afterEach(() => {
  __resetBlockListForTests();
  memoryStore.clear();
});

// ── Persistence + basic API ────────────────────────────────────────────────────

describe('block list · storage + basic API', () => {
  it('starts empty and initializes idempotently', () => {
    initBlockList();
    expect(isBlockListInitialized()).toBe(true);
    expect(listBlocked()).toEqual([]);
    expect(blockedSet().size).toBe(0);
    initBlockList(); // second call must not throw
    expect(listBlocked()).toEqual([]);
  });

  it('setBlocked adds, isBlocked reports, listBlocked snapshots', () => {
    initBlockList();
    setBlocked('pub-A', true);
    setBlocked('pub-B', true);
    expect(isBlocked('pub-A')).toBe(true);
    expect(isBlocked('pub-B')).toBe(true);
    expect(isBlocked('pub-C')).toBe(false);
    expect(new Set(listBlocked())).toEqual(new Set(['pub-A', 'pub-B']));
  });

  it('setBlocked(false) unblocks and no-ops on repeated calls', () => {
    initBlockList();
    setBlocked('pub-X', true);
    expect(isBlocked('pub-X')).toBe(true);
    setBlocked('pub-X', false);
    expect(isBlocked('pub-X')).toBe(false);
    // idempotent re-unblock — must not throw or notify
    setBlocked('pub-X', false);
    expect(isBlocked('pub-X')).toBe(false);
  });

  it('persists to localStorage and reloads on init', () => {
    initBlockList();
    setBlocked('pub-A', true);
    setBlocked('pub-B', true);
    setBlocked('pub-A', false);
    // Simulate a page reload: reset in-memory, re-init from the persisted store.
    __resetBlockListForTests();
    // storage kept — we only reset the module singleton
    memoryStore.set('ssf-blocked-pubs', JSON.stringify(['pub-B']));
    initBlockList();
    expect(listBlocked()).toEqual(['pub-B']);
    expect(isBlocked('pub-A')).toBe(false);
    expect(isBlocked('pub-B')).toBe(true);
  });

  it('tolerates a corrupted or non-array persisted value', () => {
    // __resetBlockListForTests clears storage — always poke memoryStore AFTER
    // the reset so the value under test is what initBlockList will actually
    // see. (This mirrors the reload-on-init test's ordering.)
    memoryStore.set('ssf-blocked-pubs', '{not:json');
    initBlockList();
    expect(listBlocked()).toEqual([]);
    __resetBlockListForTests();

    memoryStore.set('ssf-blocked-pubs', JSON.stringify({ oops: true }));
    initBlockList();
    expect(listBlocked()).toEqual([]);
    __resetBlockListForTests();

    // mixed array: only string entries survive
    memoryStore.set('ssf-blocked-pubs', JSON.stringify(['pub-A', 42, null, '']));
    initBlockList();
    expect(listBlocked()).toEqual(['pub-A']);
  });

  it('rejects empty / non-string pubs at the API', () => {
    initBlockList();
    setBlocked('', true);
    // @ts-expect-error deliberate type violation to exercise the runtime guard
    setBlocked(undefined, true);
    // @ts-expect-error deliberate type violation
    setBlocked(null, true);
    expect(listBlocked()).toEqual([]);
    // @ts-expect-error deliberate type violation
    expect(isBlocked(undefined)).toBe(false);
    expect(isBlocked('')).toBe(false);
  });
});

// ── Listener fan-out ──────────────────────────────────────────────────────────

describe('block list · subscribers', () => {
  it('notifies subscribers on init and on real change only', () => {
    const notifier = vi.fn();
    subscribeBlockList(notifier);
    initBlockList();
    expect(notifier).toHaveBeenCalledTimes(1);
    setBlocked('pub-A', true);
    expect(notifier).toHaveBeenCalledTimes(2);
    // Re-blocking the same pub is a no-op — must NOT re-fire the listener.
    setBlocked('pub-A', true);
    expect(notifier).toHaveBeenCalledTimes(2);
    setBlocked('pub-A', false);
    expect(notifier).toHaveBeenCalledTimes(3);
  });

  it('unsubscribe stops notifications', () => {
    initBlockList();
    const notifier = vi.fn();
    const off = subscribeBlockList(notifier);
    setBlocked('pub-A', true);
    expect(notifier).toHaveBeenCalledTimes(1);
    off();
    setBlocked('pub-B', true);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not stop the others firing', () => {
    initBlockList();
    const good = vi.fn();
    // Suppress the console.error the module logs when a listener throws — it's
    // the expected behaviour under test and would pollute the vitest output.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silent */ });
    subscribeBlockList(() => { throw new Error('boom'); });
    subscribeBlockList(good);
    setBlocked('pub-A', true);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

// ── Pure filter helpers ───────────────────────────────────────────────────────

describe('block list · isAuthoredByBlocked', () => {
  it('matches on canonical authorPub', () => {
    const set = new Set(['pub-X']);
    expect(isAuthoredByBlocked({ authorPub: 'pub-X' }, set)).toBe(true);
    expect(isAuthoredByBlocked({ authorPub: 'pub-Y' }, set)).toBe(false);
  });

  it('matches on legacy authorId via the resolver', () => {
    const set = new Set(['pub-X']);
    const resolver = (id: string): string | undefined => (id === 'id-1' ? 'pub-X' : undefined);
    expect(isAuthoredByBlocked({ authorId: 'id-1' }, set, resolver)).toBe(true);
    expect(isAuthoredByBlocked({ authorId: 'id-2' }, set, resolver)).toBe(false);
  });

  it('prefers authorPub over resolver — canonical id wins', () => {
    const set = new Set(['pub-X']);
    const resolver = (): string => 'pub-X'; // would resolve to blocked, but authorPub disagrees
    // authorPub says 'pub-Y' (not blocked) and takes priority — resolver is a fallback
    expect(isAuthoredByBlocked({ authorPub: 'pub-Y', authorId: 'id-anything' }, set, resolver)).toBe(false);
  });

  it('empty set is a fast negative', () => {
    const empty = new Set<string>();
    expect(isAuthoredByBlocked({ authorPub: 'pub-A' }, empty)).toBe(false);
    expect(isAuthoredByBlocked({ authorId: 'id-A' }, empty, () => 'pub-A')).toBe(false);
  });

  it('ignores non-string / empty author fields', () => {
    const set = new Set(['pub-X']);
    expect(isAuthoredByBlocked({}, set)).toBe(false);
    expect(isAuthoredByBlocked({ authorPub: '', authorId: '' }, set)).toBe(false);
    expect(isAuthoredByBlocked({ authorPub: 123 as unknown }, set)).toBe(false);
  });
});

describe('block list · filterOutBlocked', () => {
  it('drops blocked and preserves order', () => {
    const set = new Set(['pub-X']);
    const msgs = [
      { authorPub: 'pub-A', text: '1' },
      { authorPub: 'pub-X', text: '2' },
      { authorPub: 'pub-B', text: '3' },
      { authorPub: 'pub-X', text: '4' },
      { authorPub: 'pub-C', text: '5' },
    ];
    expect(filterOutBlocked(msgs, set).map((m) => m.text)).toEqual(['1', '3', '5']);
  });

  it('resolves legacy authorId via the resolver', () => {
    const set = new Set(['pub-X']);
    const idToPub = new Map([
      ['id-1', 'pub-A'],
      ['id-2', 'pub-X'], // blocked
      ['id-3', 'pub-B'],
    ]);
    const msgs = [
      { authorId: 'id-1', text: '1' },
      { authorId: 'id-2', text: '2' },
      { authorId: 'id-3', text: '3' },
      { authorId: 'id-unknown', text: '4' }, // no mapping — passes through
    ];
    const kept = filterOutBlocked(msgs, set, (id) => idToPub.get(id));
    expect(kept.map((m) => m.text)).toEqual(['1', '3', '4']);
  });

  it('empty block set returns a shallow copy (not the same reference)', () => {
    const empty = new Set<string>();
    const msgs = [{ authorPub: 'pub-A' }, { authorPub: 'pub-B' }];
    const out = filterOutBlocked(msgs, empty);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });
});

describe('block list · partitionRosterByBlocked', () => {
  it('splits by pub, preserves order in both partitions', () => {
    const set = new Set(['pub-X', 'pub-Z']);
    const rows = [
      { pub: 'pub-A', name: 'Alice' },
      { pub: 'pub-X', name: 'Xavier' },
      { pub: 'pub-B', name: 'Bob' },
      { pub: 'pub-Z', name: 'Zoe' },
      { pub: 'pub-C', name: 'Cyd' },
      // A row without a pub (legacy / keyless roster entry) — treated as visible.
      { name: 'Legacy' },
    ];
    const { visible, blocked } = partitionRosterByBlocked(rows as { pub?: string; name: string }[], set);
    expect(visible.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Cyd', 'Legacy']);
    expect(blocked.map((r) => r.name)).toEqual(['Xavier', 'Zoe']);
  });

  it('empty block set returns everything as visible', () => {
    const empty = new Set<string>();
    const rows = [{ pub: 'pub-A' }, { pub: 'pub-B' }];
    const { visible, blocked } = partitionRosterByBlocked(rows, empty);
    expect(visible.length).toBe(2);
    expect(blocked.length).toBe(0);
    expect(visible).not.toBe(rows);
  });
});
