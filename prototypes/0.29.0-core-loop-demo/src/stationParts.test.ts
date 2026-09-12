/**
 * 🔩 stationParts — pure state machine over parts counts and toggles.
 *
 * These tests exercise the ARM grant/consume ladder the devMenu now wires
 * fresh ROBOT ARM placements against (PR-131 Copilot inline at
 * devMenu.ts:865). The runtime persists via localStorage; here we stub it
 * with an in-memory Map so the same shape works in the node vitest env.
 *
 * The BUG this test locks down: prior to the PR-131 remediation the +1
 * ROBOT ARM grant in the dev PARTS section decremented nothing when the
 * FURNITURE gallery spawned a fresh arm — the count was a decoration, and
 * arms could be spawned indefinitely with zero grants. The devMenu now
 * calls `consumePart('arm')` AFTER a valid spot is found and refuses when
 * the grant is empty; those two contracts live in this module, so pinning
 * them here catches a future drift regardless of what the caller looks like.
 *
 * ISO/IEC 25000 (SQuaRE) — functional suitability / correctness for the
 * consume-refuse boundary. Kept side-effect-free via before-each reset of
 * the stub store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// In-memory localStorage stub — node vitest env has no window; stubbing
// globalThis.localStorage lets stationParts.ts's try/localStorage.getItem
// path run its production code unchanged. Cleared between tests so state
// never leaks across cases.
type Store = Map<string, string>;
function installLocalStorage(): Store {
  const store: Store = new Map();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
  return store;
}
function removeLocalStorage(): void {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

let store: Store;
beforeEach(() => { store = installLocalStorage(); });
afterEach(() => { removeLocalStorage(); });

// Deliberately imported AFTER the beforeEach's stub install so the module
// initializes against a real localStorage stub — an import at the top would
// still work (loadParts is called per-getter, not at module load), but the
// dynamic import shape documents the ordering the wire depends on.
async function loadModule() {
  return await import('./stationParts');
}

describe('stationParts — ARM grant/consume ladder (PR-131 devMenu wire)', () => {
  it('starts empty when localStorage is untouched', async () => {
    const sp = await loadModule();
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.partsCount('flex')).toBe(0);
    expect(sp.partsCount('ext')).toBe(0);
    expect(sp.partsCount('adapter')).toBe(0);
  });

  it('addParts increments the counter atomically', async () => {
    const sp = await loadModule();
    sp.addParts('arm', 1);
    expect(sp.partsCount('arm')).toBe(1);
    sp.addParts('arm', 2);
    expect(sp.partsCount('arm')).toBe(3);
  });

  it('consumePart refuses (returns false, no change) when the count is zero', async () => {
    const sp = await loadModule();
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.consumePart('arm')).toBe(false);
    expect(sp.partsCount('arm')).toBe(0); // unchanged
  });

  it('consumePart decrements by exactly one and returns true when available', async () => {
    const sp = await loadModule();
    sp.addParts('arm', 2);
    expect(sp.consumePart('arm')).toBe(true);
    expect(sp.partsCount('arm')).toBe(1);
    expect(sp.consumePart('arm')).toBe(true);
    expect(sp.partsCount('arm')).toBe(0);
    // Third consume must refuse — the whole point of the grant→placement
    // wire (spawnFurniture('robot-arm') MUST refuse at zero).
    expect(sp.consumePart('arm')).toBe(false);
    expect(sp.partsCount('arm')).toBe(0);
  });

  it('arm consumption does not touch flex / ext / adapter counts', async () => {
    const sp = await loadModule();
    sp.addParts('arm', 1);
    sp.addParts('flex', 4);
    sp.addParts('ext', 2);
    sp.addParts('adapter', 1);
    expect(sp.consumePart('arm')).toBe(true);
    // A cross-tenant leak here would let the arm grant deplete unrelated
    // inventories — the shared PARTS_KEY object is the failure mode.
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.partsCount('flex')).toBe(4);
    expect(sp.partsCount('ext')).toBe(2);
    expect(sp.partsCount('adapter')).toBe(1);
  });

  it('missing arm field in persisted JSON defaults to 0 (silent migration)', async () => {
    // Simulate a pre-#62 install: the JSON has no `arm` key. loadParts()
    // must synthesize 0 so consumePart('arm') refuses on the FIRST call —
    // the guarantee the dev menu wire (partsCount + refuse-at-zero) rests on.
    store.set('ssf-station-parts', JSON.stringify({ flex: 4, ext: 2, adapter: 1 }));
    const sp = await loadModule();
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.consumePart('arm')).toBe(false);
    expect(sp.partsCount('flex')).toBe(4);
    expect(sp.partsCount('ext')).toBe(2);
    expect(sp.partsCount('adapter')).toBe(1);
  });

  it('refundPart brings a consumed grant back (rollback path)', async () => {
    const sp = await loadModule();
    sp.addParts('arm', 1);
    expect(sp.consumePart('arm')).toBe(true);
    expect(sp.partsCount('arm')).toBe(0);
    sp.refundPart('arm');
    expect(sp.partsCount('arm')).toBe(1);
    // Refunded arm consumes again — proves refund is a real +1, not a note.
    expect(sp.consumePart('arm')).toBe(true);
  });

  it('rejects corrupt or non-numeric persisted parts as 0 rather than NaN', async () => {
    // A tampered / stale localStorage entry must not propagate NaN into the
    // count — the consume ladder would then compare NaN <= 0 (false) and
    // silently mint free arms. loadParts's Number.isFinite guard prevents it.
    store.set('ssf-station-parts', JSON.stringify({ arm: 'oops', flex: null }));
    const sp = await loadModule();
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.partsCount('flex')).toBe(0);
    expect(sp.consumePart('arm')).toBe(false);
  });

  it('addParts clamps a negative-net result to 0 (never goes below zero)', async () => {
    const sp = await loadModule();
    // Someone calls addParts('arm', -5) on an empty bag. The right answer is
    // 0 (a subtraction floored), not -5 (which would let consumePart pass
    // when partsCount evaluates 'p[kind] <= 0' as false for -5). The floor
    // is inside addParts itself.
    sp.addParts('arm', -5);
    expect(sp.partsCount('arm')).toBe(0);
    expect(sp.consumePart('arm')).toBe(false);
  });
});
