/**
 * 🗺️ stationAtlas — gossip-stamp bounds and eviction tiering (#144)
 *
 * The shared `atlas` map crosses the peer trust boundary, and what it carries
 * feeds a CAPPED local store. These cases drive the real ingest path
 * (bindStationAtlasDoc -> pullSharedAtlas) with entries a hostile peer could
 * write, rather than calling internals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindStationAtlasDoc, compareAtlasRecency, harvestIntoAtlas, pushAtlasToDoc, readAtlas, seedAtlasDefaults } from './stationAtlas';
import type { BundledAtlasEntry } from './stationAtlas';

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

describe('door-set bound at ingest', () => {
  it('keeps at most 64 doors of a peer entry — the cap doorsDoc reads a room back with', () => {
    const doors: Record<string, { targetRoomId: string; targetSeed: string }> = {};
    for (let i = 0; i < 100; i++) doors[`d:${i}`] = { targetRoomId: `nbr-${i}`, targetSeed: '' };
    doc.getMap('atlas').set('module-fat', {
      roomId: 'module-fat', name: 'FAT', doors, updatedAt: Date.now() - 60_000,
    });
    bind();
    const entry = readAtlas()['module-fat'];
    expect(entry).toBeDefined();
    expect(Object.keys(entry.doors).length).toBe(64);
    // …and the unchanged-entry guard compares against the NORMALIZED count, so
    // a second notification of the same value is a no-op, not a rewrite.
    const before = store.get('ssf-station-atlas');
    doc.getMap('atlas').set('module-other', shared('module-other', Date.now() - 60_000));
    const after = JSON.parse(store.get('ssf-station-atlas')!) as Record<string, { lastSeen: number }>;
    expect(after['module-fat'].lastSeen).toBe((JSON.parse(before!) as Record<string, { lastSeen: number }>)['module-fat'].lastSeen);
  });

  it('malformed door records do not make the unchanged-entry guard re-process forever', () => {
    // 100 junk records and ONE valid door: normalizes to one door, and the
    // guard must compare against that one — not the 101 raw keys — or every
    // unrelated notification rewrites this entry.
    const doors: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) doors[`junk-${i}`] = { targetRoomId: '' };
    doors['d:real'] = { targetRoomId: 'nbr-real', targetSeed: '' };
    doc.getMap('atlas').set('module-junky', {
      roomId: 'module-junky', name: 'JUNKY', doors, updatedAt: Date.now() - 60_000,
    });
    bind();
    expect(Object.keys(readAtlas()['module-junky'].doors)).toEqual(['d:real']);
    const before = store.get('ssf-station-atlas');
    doc.getMap('atlas').set('module-other', shared('module-other', Date.now() - 60_000));
    const parse = (s: string) => (JSON.parse(s) as Record<string, { lastSeen: number }>)['module-junky'].lastSeen;
    expect(parse(store.get('ssf-station-atlas')!)).toBe(parse(before!));
  });

  it('refuses an entry whose raw door object is absurdly large, before walking it', () => {
    const doors: Record<string, { targetRoomId: string; targetSeed: string }> = {};
    for (let i = 0; i < 300; i++) doors[`d:${i}`] = { targetRoomId: `nbr-${i}`, targetSeed: '' };
    doc.getMap('atlas').set('module-huge', {
      roomId: 'module-huge', name: 'HUGE', doors, updatedAt: Date.now() - 60_000,
    });
    bind();
    expect(readAtlas()['module-huge']).toBeUndefined();
  });

  it('repairs — and PERSISTS — an oversized door set persisted by an older build', () => {
    // Seeded straight into localStorage: the ingest guard never sees it, and
    // the pull's `prior` guard can skip the entry, so the read is the seam.
    const doors: Record<string, { targetRoomId: string; targetSeed: string }> = {};
    for (let i = 0; i < 300; i++) doors[`d:${i}`] = { targetRoomId: `nbr-${i}`, targetSeed: '' };
    store.set('ssf-station-atlas', JSON.stringify({
      'module-old': { roomId: 'module-old', name: 'OLD', doors, lastSeen: 1 },
    }));
    expect(Object.keys(readAtlas()['module-old'].doors).length).toBe(64);
    // Read the raw store, not the return value — this is the persistence claim.
    const raw = JSON.parse(store.get('ssf-station-atlas')!) as Record<string, { doors: object }>;
    expect(Object.keys(raw['module-old'].doors).length).toBe(64);
  });
});

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
    // A valid entry alongside the poisoned one, so the assertion has something
    // to check — without it readAtlas() is empty and the loop is vacuous.
    const m = doc.getMap('atlas');
    m.set('module-ok', shared('module-ok', Date.now() - 60_000));
    m.set('module-evil', shared('module-evil', 8.64e15));
    bind();

    const atlas = readAtlas();
    expect(atlas['module-ok']).toBeDefined();
    expect(atlas['module-evil']).toBeUndefined();
    expect(Object.keys(atlas).length).toBeGreaterThan(0);
    for (const e of Object.values(atlas)) {
      expect(e.lastSeen).toBeLessThanOrEqual(Date.now() + 6 * HOUR);
    }
  });

  it('repairs a legacy far-future lastSeen already in localStorage', () => {
    // Poisoned before the ingest bound shipped — the guard cannot reach it.
    store.set('ssf-station-atlas', JSON.stringify({
      'module-old': {
        roomId: 'module-old', name: 'OLD', doors: {}, lastSeen: 8.64e15,
      },
    }));

    const entry = readAtlas()['module-old'];
    expect(entry).toBeDefined();          // the room survives...
    expect(entry.lastSeen).toBe(0);       // ...its impossible stamp does not
  });

  it('does not republish a legacy far-future stamp into a room doc', () => {
    store.set('ssf-station-atlas', JSON.stringify({
      'module-old': {
        roomId: 'module-old',
        name: 'OLD',
        doors: { n: { targetRoomId: 'module-nbr', targetSeed: '' } },
        lastSeen: 8.64e15,
      },
    }));
    bind('module-old');
    pushAtlasToDoc();

    const published = doc.getMap('atlas').get('module-old') as { updatedAt: number } | undefined;
    // Unconditional: the entry HAS a door, so pushAtlasToDoc does not skip it
    // as a stub. Guarding this with `if (published)` would make it vacuous.
    expect(published).toBeDefined();
    expect(published!.updatedAt).toBe(0);
  });

  it('PERSISTS the legacy repair, so it survives the moving ceiling', () => {
    // Only 7h ahead: above today's ceiling, but under it again within an hour.
    // An in-memory-only repair would let the original value come back.
    store.set('ssf-station-atlas', JSON.stringify({
      'module-old': {
        roomId: 'module-old', name: 'OLD', doors: {}, lastSeen: Date.now() + 7 * HOUR,
      },
    }));

    expect(readAtlas()['module-old'].lastSeen).toBe(0);
    // Read the raw store, not the return value — this is the persistence claim.
    const raw = JSON.parse(store.get('ssf-station-atlas')!);
    expect(raw['module-old'].lastSeen).toBe(0);
  });

  it('never publishes a stamp its own reader would refuse', () => {
    // Needs a FROZEN clock and a SINGLE push. The ceiling moves in real time,
    // and a later push overwrites the offending record, so a test that lets
    // either happen passes with or without the clamp (mine did, first time).
    vi.useFakeTimers();
    try {
      const t0 = new Date('2026-09-12T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      const ceiling = t0 + 6 * HOUR;

      // Local knowledge and the doc record agree on the stamp — exactly at the
      // ceiling — but differ in content, so bind's push must re-publish. The F5
      // monotonic bump wants `known.updatedAt + 1`, one millisecond past the
      // bound, which is precisely what the clamp exists to stop.
      store.set('ssf-station-atlas', JSON.stringify({
        'module-self': {
          roomId: 'module-self',
          name: 'RENAMED',
          doors: { n: { targetRoomId: 'module-nbr', targetSeed: 'seed' } },
          lastSeen: ceiling,
          localSeenAt: t0,
        },
      }));
      doc.getMap('atlas').set('module-self', {
        roomId: 'module-self',
        name: 'SELF',
        doors: { n: { targetRoomId: 'module-nbr' } },
        updatedAt: ceiling,
      });
      bind('module-self');

      const published = doc.getMap('atlas').get('module-self') as { name: string; updatedAt: number };
      expect(published.name).toBe('RENAMED');                    // the push happened...
      expect(published.updatedAt).toBeLessThanOrEqual(ceiling);  // ...inside the bound

      // The claim is not arithmetic, it is round-trip: a peer on the same clock
      // running OUR ingest guard has to accept what we just wrote. Unclamped
      // this lands at ceiling + 1 and is refused — a record nobody can read.
      store.clear();
      const peer = new Y.Doc();
      peer.getMap('atlas').set('module-self', published);
      bindStationAtlasDoc(peer, { roomId: 'module-other', isPassagePublic: () => false });
      expect(readAtlas()['module-self']).toBeDefined();
    } finally {
      vi.useRealTimers();
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

  it('does NOT stamp neighbour stubs — door records are peer-written', () => {
    harvestIntoAtlas({
      roomId: 'module-here',
      name: 'HERE',
      doors: [{ doorId: 'n', targetSeed: btoa(JSON.stringify({ roomId: 'module-nbr' })) }],
    });
    const atlas = readAtlas();
    expect(atlas['module-here'].localSeenAt).toBeGreaterThan(0); // we stood in it
    expect(atlas['module-nbr']).toBeDefined();                   // stub exists...
    expect(atlas['module-nbr'].localSeenAt).toBeUndefined();      // ...but is gossip-tier
  });

  it('compareAtlasRecency puts first-hand ahead of fresher gossip', () => {
    const now = Date.now();
    const visitedLongAgo = { roomId: 'a', name: 'A', doors: {}, lastSeen: 0, localSeenAt: now - 9e6 };
    const gossipedJustNow = { roomId: 'b', name: 'B', doors: {}, lastSeen: now };
    // Gossip is newer by every peer-visible measure and still sorts second.
    expect([gossipedJustNow, visitedLongAgo].sort(compareAtlasRecency)[0].roomId).toBe('a');
  });

  it("compareAtlasRecency orders within a tier by that tier's own stamp", () => {
    const now = Date.now();
    const older = { roomId: 'a', name: 'A', doors: {}, lastSeen: 0, localSeenAt: now - 9e6 };
    const newer = { roomId: 'b', name: 'B', doors: {}, lastSeen: 0, localSeenAt: now };
    expect([older, newer].sort(compareAtlasRecency)[0].roomId).toBe('b');

    const gossipOld = { roomId: 'c', name: 'C', doors: {}, lastSeen: now - 9e6 };
    const gossipNew = { roomId: 'd', name: 'D', doors: {}, lastSeen: now };
    expect([gossipOld, gossipNew].sort(compareAtlasRecency)[0].roomId).toBe('d');
  });

  it('a peer filling the door map cannot evict visited rooms', () => {
    // A real visit, recorded first.
    harvestIntoAtlas({ roomId: 'module-mine', name: 'MINE', doors: [] });

    // readAllDoors() is capped at MAX_PAIRINGS = 64 — exactly MAX_ENTRIES — so a
    // hostile room doc can offer a full atlas's worth of fabricated targets.
    harvestIntoAtlas({
      roomId: 'module-trap',
      name: 'TRAP',
      doors: Array.from({ length: 64 }, (_, i) => ({
        doorId: `d:${i}`,
        targetSeed: btoa(JSON.stringify({ roomId: `module-fake${i}` })),
      })),
    });

    const atlas = readAtlas();
    expect(Object.keys(atlas).length).toBeLessThanOrEqual(64);
    expect(atlas['module-mine']).toBeDefined();
  });
});

describe("seedAtlasDefaults — a build's bundled station (defaultStation.ts)", () => {
  const bundle = (): BundledAtlasEntry[] => [
    {
      roomId: 'module-hub', name: 'HUB', dims: { cols: 2, rows: 2 },
      doors: { 'd:1': { targetRoomId: 'module-welcome', wall: 'x+', lateral: 0, farDoor: 'north', farWall: 'y-', farLateral: 0 } },
    },
    {
      roomId: 'module-welcome', name: 'WELCOME', seed: 'ssf://room?seed=welcome', dims: { cols: 2, rows: 2 },
      doors: { north: { targetRoomId: 'module-hub', wall: 'y-', lateral: 0, farDoor: 'd:1', farWall: 'x+', farLateral: 0 } },
    },
  ];

  it('fills an empty atlas at gossip tier — no local stamp, the weakest gossip stamp — and is idempotent', () => {
    expect(seedAtlasDefaults(bundle())).toBe(2);
    const atlas = readAtlas();
    expect(atlas['module-welcome'].seed).toBe('ssf://room?seed=welcome');
    expect(atlas['module-welcome'].dims).toEqual({ cols: 2, rows: 2 });
    expect(atlas['module-hub'].doors['d:1'].targetRoomId).toBe('module-welcome');
    expect(atlas['module-hub'].doors['d:1'].targetSeed).toBe('');
    expect(atlas['module-hub'].seed).toBeUndefined();
    for (const e of Object.values(atlas)) {
      expect(e.lastSeen).toBe(0);
      expect(e.localSeenAt).toBeUndefined();
    }
    // A second boot writes nothing.
    expect(seedAtlasDefaults(bundle())).toBe(0);
  });

  it('never touches a visited room or one with real geometry, but fills a doorless stub', () => {
    harvestIntoAtlas({ roomId: 'module-hub', name: 'MY HUB', dims: { cols: 3, rows: 2 }, doors: [] });
    // A neighbour stub exactly as harvestIntoAtlas mints them: placeholder name, the door's seed, no doors.
    harvestIntoAtlas({ roomId: 'module-x', name: 'X', doors: [{ doorId: 'd:9', targetSeed: '#room=module-welcome' }] });
    expect(seedAtlasDefaults(bundle())).toBe(1);
    const atlas = readAtlas();
    expect(atlas['module-hub'].name).toBe('MY HUB');
    expect(atlas['module-hub'].dims).toEqual({ cols: 3, rows: 2 });
    expect(atlas['module-hub'].doors).toEqual({});
    expect(atlas['module-welcome'].name).toBe('WELCOME'); // the placeholder yielded
    expect(atlas['module-welcome'].seed).toBe('#room=module-welcome'); // the stub's own seed stays
    expect(atlas['module-welcome'].doors.north.targetRoomId).toBe('module-hub');
    expect(atlas['module-welcome'].localSeenAt).toBeUndefined();
  });

  it('is outranked by the first honest gossip, which keeps the bundled seed', () => {
    seedAtlasDefaults(bundle());
    doc.getMap('atlas').set('module-welcome', {
      roomId: 'module-welcome', name: 'SSF-WELCOME', dims: { cols: 3, rows: 3 },
      doors: { north: { targetRoomId: 'module-hub', wall: 'y-', lateral: 2 } },
      updatedAt: Date.now() - 60_000,
    });
    bind('module-hub');
    const e = readAtlas()['module-welcome'];
    expect(e.name).toBe('SSF-WELCOME');
    expect(e.dims).toEqual({ cols: 3, rows: 3 });
    expect(e.doors.north.lateral).toBe(2);
    expect(e.seed).toBe('ssf://room?seed=welcome');
    expect(e.localSeenAt).toBeUndefined();
  });

  it('is never republished as gossip — only rooms this install observed reach the doc', () => {
    seedAtlasDefaults(bundle());
    harvestIntoAtlas({ roomId: 'module-mine', name: 'MINE', doors: [{ doorId: 'd:1', targetSeed: '#room=module-hub' }] });
    bind('module-mine');
    pushAtlasToDoc();
    expect([...doc.getMap('atlas').keys()]).toEqual(['module-mine']);
  });

  it('is not pushed even as the room we stand in — until a harvest of the synced replica stamps it', () => {
    seedAtlasDefaults(bundle());
    bind('module-hub');
    pushAtlasToDoc();
    expect([...doc.getMap('atlas').keys()]).toEqual([]);
    harvestIntoAtlas({ roomId: 'module-hub', name: 'HUB', doors: [] });
    pushAtlasToDoc();
    expect([...doc.getMap('atlas').keys()]).toEqual(['module-hub']);
  });

  it('yields even to a ZERO-stamped record with the same door count — the #144 repair republishes at 0', () => {
    seedAtlasDefaults(bundle());
    // A peer whose legacy far-future stamp was repaired republishes at updatedAt 0
    // (see "does not republish a legacy far-future stamp"); same door count as the bundle.
    doc.getMap('atlas').set('module-hub', {
      roomId: 'module-hub', name: 'HUB (repaired)', dims: { cols: 2, rows: 2 },
      doors: { 'd:1': { targetRoomId: 'module-welcome', wall: 'x+', lateral: 1 } },
      updatedAt: 0,
    });
    bind('module-mine');
    const e = readAtlas()['module-hub'];
    expect(e.name).toBe('HUB (repaired)');
    expect(e.doors['d:1'].lateral).toBe(1);
    expect(e.bundled).toBeUndefined();
    expect(e.lastSeen).toBe(0);
    // …and once real, it travels again like any observed entry: a fresh room
    // doc receives it (at 0, as #144 intends) while the still-bundled welcome
    // entry stays home.
    const other = new Y.Doc();
    bindStationAtlasDoc(other, { roomId: 'module-other', isPassagePublic: () => false });
    expect([...other.getMap('atlas').keys()]).toEqual(['module-hub']);
  });
});
