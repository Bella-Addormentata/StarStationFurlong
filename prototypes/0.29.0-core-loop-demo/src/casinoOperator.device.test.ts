/**
 * 🎰🪙 casinoOperator device tests: what the shared module does when it loads.
 * ONE device id per browser profile, seeded from the v0.38 per-game keys and
 * backfilled into them, so the tabs of one profile stay "this device" to each
 * other whichever build they run (a lapse is taken at once; another device
 * waits the split window); and the page's one `pagehide` listener. Each test
 * loads the module afresh against a stubbed localStorage and window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const NEW_KEY = 'ssf-casino-operator-device';
const SLOT_KEY = 'ssf-slot-operator-device';
const PUSHER_KEY = 'ssf-pusher-operator-device';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── One device id per profile ────────────────────────────────────────────────

describe('the device id', () => {
  it('is the one under the new key once written, whatever the old keys hold', async () => {
    const loaded = await load({ [NEW_KEY]: NEW_DEVICE, [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    expect(device(loaded)).toBe(NEW_DEVICE);
    expect(loaded.store.get(SLOT_KEY)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(PUSHER_KEY)).toBe(PUSHER_DEVICE);
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

  it('prefers the slot key when both old keys exist, and never rewrites an old key that holds an id', async () => {
    const loaded = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    expect(device(loaded)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(NEW_KEY)).toBe(SLOT_DEVICE);
    expect(loaded.store.get(PUSHER_KEY)).toBe(PUSHER_DEVICE);
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
    const { casinoDoc, casinoOperator } = await load({ [SLOT_KEY]: SLOT_DEVICE, [PUSHER_KEY]: PUSHER_DEVICE });
    casinoDoc.bindCasinoDoc(new Y.Doc());
    // A v0.38 pusher tab of this profile, writing under its own device id.
    casinoDoc.writeCoinPusherOperatorLease({ playerId: 'p', sessionId: `${PUSHER_DEVICE}:old-tab`, expiresAt: T0 + 5_000 });
    casinoOperator.reportOperatorNeed('air-hockey', true);
    expect(casinoOperator.electCasinoOperator(T0, true).kind).toBe('held-elsewhere');
    expect(casinoOperator.electCasinoOperator(T0 + 4_999, true).kind).toBe('held-elsewhere');
    expect(casinoOperator.electCasinoOperator(T0 + 5_000, true).kind).toBe('starting');
    expect(casinoDoc.readCoinPusherOperatorLease()?.sessionId).toBe(casinoOperator.casinoOperatorSession());
    // A device this profile never used waits the window.
    casinoOperator.leaveCasinoRoom();
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
