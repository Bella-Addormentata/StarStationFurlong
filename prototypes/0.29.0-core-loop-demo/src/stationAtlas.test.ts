/**
 * 🗺️ stationAtlas — gossip-stamp bounds and eviction tiering (#144)
 *
 * The shared `atlas` map crosses the peer trust boundary, and what it carries
 * feeds a CAPPED local store. These cases drive the real ingest path
 * (bindStationAtlasDoc -> pullSharedAtlas) with entries a hostile peer could
 * write, rather than calling internals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindStationAtlasDoc, harvestIntoAtlas, readAtlas } from './stationAtlas';

/** vitest runs in node here, so the atlas's localStorage needs a shim. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const HOUR = 60 * 60 * 1000;

let doc: Y.Doc;

beforeEach(() => {
  store.clear();
  doc = new Y.Doc();
});

function bind(roomId = 'module-self'): void {
  bindStationAtlasDoc(doc, { roomId, isPassagePublic: () => false });
}

/** A shared-atlas entry as a peer would write it. */
function shared(roomId: string, updatedAt: number) {
  return {
    roomId,
    name: roomId.toUpperCase(),
    doors: { n: { targetRoomId: `${roomId}-nbr`, targetSeed: '' } },
    updatedAt,
  };
}

describe('gossip stamp bounds (#144)', () => {
  it('refuses an entry stamped far beyond our clock', () => {
    doc.getMap('atlas').set('module-evil', shared('module-evil', 8.64e15));
    bind();
    expect(readAtlas()['module-evil']).toBeUndefined();
  });

  it('accepts an ordinary stamp', () => {
    doc.getMap('atlas').set('module-ok', shared('module-ok', Date.now() - 60_000));
    bind();
    expect(readAtlas()['module-ok']).toBeDefined();
  });

  it('tolerates honest clock skew inside the window', () => {
    doc.getMap('atlas').set('module-skew', shared('module-skew', Date.now() + HOUR));
    bind();
    expect(readAtlas()['module-skew']).toBeDefined();
  });

  it('refuses just outside the window', () => {
    doc.getMap('atlas').set('module-late', shared('module-late', Date.now() + 7 * HOUR));
    bind();
    expect(readAtlas()['module-late']).toBeUndefined();
  });

  it('a refused entry cannot inflate local recency', () => {
    doc.getMap('atlas').set('module-evil', shared('module-evil', 8.64e15));
    bind();
    for (const e of Object.values(readAtlas())) {
      expect(e.lastSeen).toBeLessThanOrEqual(Date.now() + HOUR);
    }
  });
});

describe('eviction prefers first-hand knowledge (#144)', () => {
  it('a visited room survives a gossip flood past the cap', () => {
    // We stood in this one.
    harvestIntoAtlas({ roomId: 'module-mine', name: 'MINE', doors: [] });
    expect(readAtlas()['module-mine']).toBeDefined();

    // A peer's station sweep arrives — well past MAX_ENTRIES (64), and every
    // entry claims a stamp NEWER than our visit.
    const now = Date.now();
    const m = doc.getMap('atlas');
    for (let i = 0; i < 80; i++) m.set(`module-g${i}`, shared(`module-g${i}`, now + 1000));
    bind();

    const atlas = readAtlas();
    expect(Object.keys(atlas).length).toBeLessThanOrEqual(64);
    // The visited room is still there; gossip was evicted instead.
    expect(atlas['module-mine']).toBeDefined();
  });

  it('marks gossip-learned rooms without a local stamp', () => {
    doc.getMap('atlas').set('module-heard', shared('module-heard', Date.now()));
    bind();
    expect(readAtlas()['module-heard'].localSeenAt).toBeUndefined();
  });

  it('stamps a visited room locally', () => {
    harvestIntoAtlas({ roomId: 'module-visited', name: 'V', doors: [] });
    expect(readAtlas()['module-visited'].localSeenAt).toBeGreaterThan(0);
  });
});
