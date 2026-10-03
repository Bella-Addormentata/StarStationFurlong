/**
 * 🎰🪙 casinoOperator device tests: what the shared module does when it loads.
 * ONE device id per browser profile, seeded from the v0.38 per-game keys and
 * written to both, the ids they held kept as this device's, so the tabs of
 * one profile stay "this device" to each other whichever build they run (a
 * lapse is taken at once; another device waits the split window); and the
 * page's one `pagehide` listener. Each test loads the module afresh against a
 * stubbed localStorage and window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const NEW_KEY = 'ssf-casino-operator-device';
const SLOT_KEY = 'ssf-slot-operator-device';
const PUSHER_KEY = 'ssf-pusher-operator-device';
const RETIRED_KEY = 'ssf-casino-operator-retired-devices';
const NEW_DEVICE = '00000000-0000-4000-8000-000000000000';
const SLOT_DEVICE = '11111111-1111-4111-8111-111111111111';
const PUSHER_DEVICE = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f-]{36}$/;
const T0 = 1_000_000_000;
const LEASE_MS = 8_000;

type Loaded = {
  casinoDoc: typeof import('./casinoDoc');
  casinoOperator: typeof import('./casinoOperator');
  /** The profile's localStorage, as the module left it. */
  store: Map<string, string>;
};

/** Load the module afresh on a profile whose localStorage holds `seed`. */
async function load(seed: Record<string, string>, win?: object): Promise<Loaded> {
  vi.resetModules();
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  });
  if (win) vi.stubGlobal('window', win);
  const casinoDoc = await import('./casinoDoc');
  const casinoOperator = await import('./casinoOperator');
  return { casinoDoc, casinoOperator, store };
}

function device(loaded: Loaded): string {
  return loaded.casinoOperator.casinoOperatorSession().split(':')[0];
}

/** The ids the profile's old keys held before this build rewrote them. */
function retired(loaded: Loaded): unknown {
  const raw = loaded.store.get(RETIRED_KEY);
  return raw === undefined ? [] : JSON.parse(raw);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── One device id per profile ────────────────────────────────────────────────

describe('the device id', () => {
  it('is the one under the new key once written, and written to the old keys, the ids they held retired', async () => {
    const loaded = await load({ [NEW_KEY]: NEW_DEVICE, [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    expect(device(loaded)).toBe(NEW_DEVICE);
    expect(loaded.store.get(SLOT_KEY)).toBe(NEW_DEVICE);
    expect(loaded.store.get(PUSHER_KEY)).toBe(NEW_DEVICE);
    expect(retired(loaded)).toEqual([SLOT_DEVICE, PUSHER_DEVICE]);
    expect(loaded.casinoOperator.casinoOperatorSession()).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  });

  it('is seeded from the v0.38 slot key, and backfilled into the keys that are absent', async () => {
    const loaded = await load({ [SLOT_KEY]: SLOT_DEVICE });
    expect(device(loaded)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(NEW_KEY)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(PUSHER_KEY)).toBe(SLOT_DEVICE); // a v0.38 pusher tab opened later mints nothing new
  });

  it('is seeded from the v0.38 pusher key when that is the only one', async () => {
    const loaded = await load({ [PUSHER_KEY]: PUSHER_DEVICE });
    expect(device(loaded)).toBe(PUSHER_DEVICE);
    expect(loaded.store.get(NEW_KEY)).toBe(PUSHER_DEVICE);
    expect(loaded.store.get(SLOT_KEY)).toBe(PUSHER_DEVICE);
  });

  it('prefers the slot key when both old keys exist (v0.38 minted one per game), and writes it over the pusher key once that id is retired', async () => {
    const loaded = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    expect(device(loaded)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(NEW_KEY)).toBe(SLOT_DEVICE);
    // A v0.38 pusher tab opened later loads the id this build's records carry.
    expect(loaded.store.get(PUSHER_KEY)).toBe(SLOT_DEVICE);
    expect(retired(loaded)).toEqual([PUSHER_DEVICE]);
    // The next page of either build changes nothing.
    const again = await load(Object.fromEntries(loaded.store));
    expect(device(again)).toBe(SLOT_DEVICE);
    expect(Object.fromEntries(again.store)).toEqual(Object.fromEntries(loaded.store));
  });

  it('never rewrites an old key whose id it could not retire (storage full): no later page forgets it', async () => {
    vi.resetModules();
    const store = new Map(Object.entries({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE }));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === RETIRED_KEY) throw new Error('QuotaExceededError');
        store.set(key, String(value));
      },
    });
    const casinoOperator = await import('./casinoOperator');
    expect(casinoOperator.casinoOperatorSession().split(':')[0]).toBe(SLOT_DEVICE);
    expect(store.get(NEW_KEY)).toBe(SLOT_DEVICE);
    expect(store.get(PUSHER_KEY)).toBe(PUSHER_DEVICE);
    expect(store.has(RETIRED_KEY)).toBe(false);
  });

  it('reads the retired ids with junk dropped, and keeps the newest when over the cap', async () => {
    for (const junk of ['{', '"an id"', '{"0":"x"}', 'null']) {
      const loaded = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE, [RETIRED_KEY]: junk });
      expect(device(loaded)).toBe(SLOT_DEVICE);
      expect(retired(loaded)).toEqual([PUSHER_DEVICE]);
    }
    const mixed = JSON.stringify([42, 'not an id', NEW_DEVICE, NEW_DEVICE, null]);
    const loaded = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE, [RETIRED_KEY]: mixed });
    expect(retired(loaded)).toEqual([NEW_DEVICE, PUSHER_DEVICE]);
    const eight = Array.from({ length: 8 }, (_, i) => `${i}${i}${i}${i}${i}${i}${i}${i}-3333-4333-8333-333333333333`);
    const full = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE, [RETIRED_KEY]: JSON.stringify(eight) });
    expect(retired(full)).toEqual([...eight.slice(1), PUSHER_DEVICE]);
    expect(full.store.get(PUSHER_KEY)).toBe(SLOT_DEVICE);
  });

  it('is minted fresh when no key holds one, and written to all three', async () => {
    const loaded = await load({ [SLOT_KEY]: 'not an id' });
    const id = device(loaded);
    expect(id).toMatch(UUID);
    for (const key of [NEW_KEY, SLOT_KEY, PUSHER_KEY]) expect(loaded.store.get(key)).toBe(id);
    // The same profile loads the same id next time; another page load is another session.
    const again = await load(Object.fromEntries(loaded.store));
    expect(device(again)).toBe(id);
    expect(again.casinoOperator.casinoOperatorSession()).not.toBe(loaded.casinoOperator.casinoOperatorSession());
  });

  it("makes an old build's record of this profile this device's: taken at its lapse, not after the split window", async () => {
    const first = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    const later = await load(Object.fromEntries(first.store));
    // A v0.38 pusher tab opened before this build keeps writing under its own
    // id: the first page of this build knows it, and so does a later one,
    // loaded once the pusher key was rewritten.
    for (const { casinoDoc, casinoOperator } of [first, later]) {
      casinoDoc.bindCasinoDoc(new Y.Doc());
      casinoDoc.writeCoinPusherOperatorLease({ playerId: 'p', sessionId: `${PUSHER_DEVICE}:old-tab`, expiresAt: T0 + 5_000 });
      casinoOperator.reportOperatorNeed('air-hockey', true);
      expect(casinoOperator.electCasinoOperator(T0, true).kind).toBe('held-elsewhere');
      expect(casinoOperator.electCasinoOperator(T0 + 4_999, true).kind).toBe('held-elsewhere');
      expect(casinoOperator.electCasinoOperator(T0 + 5_000, true).kind).toBe('starting');
      expect(casinoDoc.readCoinPusherOperatorLease()?.sessionId).toBe(casinoOperator.casinoOperatorSession());
      casinoOperator.leaveCasinoRoom();
    }
    // A device this profile never used waits the window.
    const { casinoDoc, casinoOperator } = later;
    casinoDoc.bindCasinoDoc(new Y.Doc());
    casinoDoc.writeSlotOperatorLease({ playerId: 'p', sessionId: 'unknown-device:tab', expiresAt: T0 + 5_000 });
    casinoOperator.reportOperatorNeed('air-hockey', true);
    const t1 = T0 + 10_000;
    expect(casinoOperator.electCasinoOperator(t1, true).kind).toBe('held-elsewhere');
    expect(casinoOperator.electCasinoOperator(t1 + LEASE_MS + casinoOperator.OPERATOR_UNCLEAN_TAKEOVER_MS - 1, true).kind).toBe('held-elsewhere');
    expect(casinoOperator.electCasinoOperator(t1 + LEASE_MS + casinoOperator.OPERATOR_UNCLEAN_TAKEOVER_MS, true).kind).toBe('starting');
    casinoOperator.leaveCasinoRoom();
  });

  it('is this page\'s own where localStorage is unavailable (private mode)', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    });
    const casinoOperator = await import('./casinoOperator');
    expect(casinoOperator.casinoOperatorSession()).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  });
});

// ── The page's pagehide listener ─────────────────────────────────────────────

describe('the pagehide listener', () => {
  it('is registered once, and releases the records naming this session while a foreign one stays', async () => {
    const listeners: { type: string; handler: () => void }[] = [];
    const win = { addEventListener: (type: string, handler: () => void) => { listeners.push({ type, handler }); } };
    const { casinoDoc, casinoOperator } = await load({}, win);
    // The games register none of their own: one listener for the three modules.
    await import('./slotCroupier');
    await import('./pusherCroupier');
    const pagehide = listeners.filter((l) => l.type === 'pagehide');
    expect(pagehide).toHaveLength(1);
    expect(pagehide[0].handler).toBe(casinoOperator.releaseCasinoOperatorLease);

    const doc = new Y.Doc();
    casinoDoc.bindCasinoDoc(doc);
    casinoOperator.reportOperatorNeed('air-hockey', true);
    expect(casinoOperator.electCasinoOperator(T0, true).kind).toBe('starting');
    for (const key of casinoDoc.ROOM_OPERATOR_KEYS) {
      expect(casinoDoc.readRoomOperatorLease(key)?.sessionId).toBe(casinoOperator.casinoOperatorSession());
    }
    // A v0.38 peer's take won the merge on its key; an earlier build's
    // per-machine lease is there too. Neither is this page's to delete.
    const theirs = { playerId: 'p', sessionId: 'their-device:tab', expiresAt: T0 + LEASE_MS };
    casinoDoc.writeSlotOperatorLease(theirs);
    const legacy = { playerId: 'p', sessionId: 'a'.repeat(64), expiresAt: T0 + LEASE_MS };
    doc.getMap('casino').set('slot-operator:slot-machine-1', legacy);
    pagehide[0].handler();
    expect(casinoDoc.readCasinoOperatorLease()).toBeNull();
    expect(casinoDoc.readCoinPusherOperatorLease()).toBeNull();
    expect(casinoDoc.readSlotOperatorLease()).toEqual(theirs);
    expect(doc.getMap('casino').get('slot-operator:slot-machine-1')).toEqual(legacy);
    expect(casinoOperator.currentTake()).toBeNull();
    // A page restored from the back/forward cache simply takes the lease again
    // (once nothing foreign is live).
    expect(casinoOperator.electCasinoOperator(T0 + 16, true).kind).toBe('legacy-build');
    doc.getMap('casino').delete('slot-operator:slot-machine-1');
    casinoDoc.clearSlotOperatorLease();
    expect(casinoOperator.electCasinoOperator(T0 + 32, true).kind).toBe('starting');
    casinoOperator.leaveCasinoRoom();
  });
});
