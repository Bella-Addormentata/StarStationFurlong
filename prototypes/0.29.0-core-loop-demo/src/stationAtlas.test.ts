// stationAtlas.ts tests — TWO suites in one file, merged when #147 landed:
//   (#79 P6) the first-boot atlas seed merger + adapter and the
//            pushAtlasToDoc `lastSeen === 0` sentinel guard;
//   (#144)   gossip-stamp bounds and eviction tiering, driving the real
//            ingest path with entries a hostile peer could write.
// Both sides independently created this file; the suites are disjoint and
// both are kept. The #79 MemoryStorage shim is used throughout, since the
// impure applyFirstBootAtlas adapter needs a real Storage contract.
//
// The three invariants the boot flow leans on:
//   1. mergeFirstBootAtlas is NON-DESTRUCTIVE — a locally-visited entry
//      always survives a seed merge (real geometry / seed / dims). Baked seed
//      only fills gaps.
//   2. mergeFirstBootAtlas returns entries stamped with `lastSeen: 0` (the
//      sentinel) and NEVER carries a `targetSeed` on a baked door — the seed
//      is geometry, not a credential.
//   3. pushAtlasToDoc SKIPS non-own entries with `lastSeen === 0`. That is the
//      security guarantee that keeps fabricated first-boot rooms out of the
//      shared station atlas — auditors check this first (see the #79 P6 header).
//
// Test environment: node + a minimal MemoryStorage shim (keypair.test.ts
// pattern) so the impure `applyFirstBootAtlas` adapter can run without jsdom.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// ─── Minimal in-memory Storage shim (Web Storage contract subset we use) ────
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

// Install before importing stationAtlas — its readAtlas/writeAtlas touch
// localStorage on first call.
(globalThis as any).localStorage = new MemoryStorage();

const {
  applyFirstBootAtlas,
  bindStationAtlasDoc,
  compareAtlasRecency,
  harvestIntoAtlas,
  mergeFirstBootAtlas,
  pushAtlasToDoc,
  readAtlas,
} = await import('./stationAtlas');

const { firstBootAtlasSeed, STATION_ROOM_ID } = await import('./station');

beforeEach(() => {
  // Fresh in-memory storage each test — atlas state must not leak between tests.
  (globalThis as any).localStorage = new MemoryStorage();
});

// ─── mergeFirstBootAtlas — pure ─────────────────────────────────────────────

describe('stationAtlas.mergeFirstBootAtlas — pure seed merger (#79 P6)', () => {
  it('adds every seed entry into an EMPTY local atlas (first-run install)', () => {
    // The whole point of the seed: an empty store should end up with the
    // baked cardinal shell so the exterior can render the full station.
    const seed = firstBootAtlasSeed();
    const merged = mergeFirstBootAtlas({}, seed);
    for (const entry of seed) {
      expect(merged[entry.roomId]).toBeDefined();
      expect(merged[entry.roomId].roomId).toBe(entry.roomId);
      expect(merged[entry.roomId].name).toBe(entry.name);
    }
  });

  it('stamps every seed entry with lastSeen: 0 (the sentinel)', () => {
    // The push-side guard keys off this sentinel — a baked entry with a
    // Date.now() stamp would leak into the shared doc.
    const seed = firstBootAtlasSeed();
    const merged = mergeFirstBootAtlas({}, seed);
    for (const entry of seed) {
      expect(merged[entry.roomId].lastSeen).toBe(0);
    }
  });

  it('never sets a targetSeed on a baked door (credentials do not ride the seed)', () => {
    // Security invariant: even if a future refactor slipped a `targetSeed`
    // into StationAtlasSeedDoor, the merger must not propagate it. A blank
    // string here means "no credential" — the same shape harvestIntoAtlas
    // produces for an unknown-target stub.
    const seed = firstBootAtlasSeed();
    const merged = mergeFirstBootAtlas({}, seed);
    for (const entry of Object.values(merged)) {
      for (const door of Object.values(entry.doors)) {
        expect(door.targetSeed).toBe('');
      }
    }
  });

  it('carries wall + lateral through so atlasLayout can pose the far module', () => {
    // The exterior renderer poses neighbours from these two fields. If the
    // merger dropped them, the first-boot render would fall back to the
    // arrival-heading pose and the arms would scatter.
    const seed = firstBootAtlasSeed();
    const merged = mergeFirstBootAtlas({}, seed);
    const station = merged[STATION_ROOM_ID];
    expect(station).toBeDefined();
    // Every baked station door has a cardinal wall + a numeric lateral.
    for (const door of Object.values(station.doors)) {
      expect(typeof door.wall).toBe('string');
      expect(typeof door.lateral).toBe('number');
    }
  });

  it('is NON-DESTRUCTIVE: an existing entry always wins over a seed entry', () => {
    // Rule 1 — the returning-install invariant. A player who has walked to
    // furlong-atrium and picked up its real seed/doors must not have those
    // wiped by a re-boot's seed merge.
    const local = {
      'furlong-atrium': {
        roomId: 'furlong-atrium',
        name: 'REAL Atrium (visited)',
        seed: 'real-atrium-seed-URL',
        dims: { cols: 12, rows: 12 },
        doors: {
          'north': { targetSeed: 'real-neighbour-seed', targetRoomId: 'real-neighbour', wall: 'y-' as const, lateral: 3 },
        },
        lastSeen: 1234567890,
      },
    };
    const seed = firstBootAtlasSeed();
    const merged = mergeFirstBootAtlas(local, seed);
    // The real entry is verbatim — same reference identity is even OK because
    // the merger only shallow-clones the outer map on existing keys.
    expect(merged['furlong-atrium'].name).toBe('REAL Atrium (visited)');
    expect(merged['furlong-atrium'].seed).toBe('real-atrium-seed-URL');
    expect(merged['furlong-atrium'].lastSeen).toBe(1234567890);
    expect(merged['furlong-atrium'].doors['north'].targetSeed).toBe('real-neighbour-seed');
  });

  it('does not mutate its inputs (pure)', () => {
    // A merge-time mutation would leak back into the caller's snapshot —
    // main.ts holds the atlas by reference through readAtlas().
    const local = { existing: { roomId: 'existing', name: 'x', doors: {}, lastSeen: 999 } };
    const seed = firstBootAtlasSeed();
    const localBefore = JSON.stringify(local);
    const seedBefore = JSON.stringify(seed);
    mergeFirstBootAtlas(local, seed);
    expect(JSON.stringify(local)).toBe(localBefore);
    expect(JSON.stringify(seed)).toBe(seedBefore);
  });

  it('skips malformed seed entries defensively (missing roomId / doorId / targetRoomId)', () => {
    // Belt-and-braces: if a future refactor introduces bad seed data, the
    // merger must not crash and must not admit half-formed entries.
    const seed = [
      { roomId: '',           name: 'no id',      doors: [] }, // no roomId → skipped
      { roomId: 'valid-room', name: 'good',       doors: [
        { doorId: '',            targetRoomId: 'x', wall: 'y-' as const, lateral: 0 }, // no doorId
        { doorId: 'north',       targetRoomId: '',  wall: 'y-' as const, lateral: 0 }, // no targetRoomId
        { doorId: 'south',       targetRoomId: 'y', wall: 'y+' as const, lateral: 0 }, // OK
      ] },
    ];
    const merged = mergeFirstBootAtlas({}, seed);
    expect(merged['']).toBeUndefined();
    expect(merged['valid-room']).toBeDefined();
    expect(Object.keys(merged['valid-room'].doors)).toEqual(['south']);
  });

  it('returns a new outer map — caller-provided local is not the returned reference', () => {
    // Defensive-copy the outer map so a caller storing `merged` and mutating
    // it later does not leak back into their `local` snapshot.
    const local = {};
    const merged = mergeFirstBootAtlas(local, []);
    expect(merged).not.toBe(local);
  });
});

// ─── applyFirstBootAtlas — thin localStorage adapter ────────────────────────

describe('stationAtlas.applyFirstBootAtlas — boot-time adapter', () => {
  it('populates an empty local atlas on first boot', () => {
    // The FIRST-BOOT install case — starts empty, ends with the baked shell.
    expect(readAtlas()).toEqual({});
    applyFirstBootAtlas(firstBootAtlasSeed());
    const after = readAtlas();
    expect(after[STATION_ROOM_ID]).toBeDefined();
    expect(Object.keys(after).length).toBe(firstBootAtlasSeed().length);
  });

  it('is IDEMPOTENT on a returning boot — no repeated writes, no drift', () => {
    // Booting again on the same install must not touch the atlas — the
    // early-exit in applyFirstBootAtlas prevents write churn (which would
    // otherwise reorder entries by lastSeen and drop older visited rooms).
    applyFirstBootAtlas(firstBootAtlasSeed());
    const snapshot = JSON.stringify(readAtlas());
    applyFirstBootAtlas(firstBootAtlasSeed());
    applyFirstBootAtlas(firstBootAtlasSeed());
    expect(JSON.stringify(readAtlas())).toBe(snapshot);
  });

  it('does not overwrite a locally-visited seed room (rule 1 through the adapter)', () => {
    // Walk into the atrium first (harvest sets lastSeen = Date.now()), then
    // apply the seed. The visited entry survives — the seed only fills gaps.
    harvestIntoAtlas({
      roomId: 'furlong-atrium',
      name: 'VISITED atrium',
      seed: 'live-seed',
      doors: [{ doorId: 'north', targetSeed: 'live-neighbour-seed' }],
    });
    const beforeStamp = readAtlas()['furlong-atrium'].lastSeen;
    applyFirstBootAtlas(firstBootAtlasSeed());
    const after = readAtlas();
    expect(after['furlong-atrium'].name).toBe('VISITED atrium');
    expect(after['furlong-atrium'].seed).toBe('live-seed');
    expect(after['furlong-atrium'].lastSeen).toBe(beforeStamp);
    // Other seed rooms did land (the store had gaps for those).
    expect(after[STATION_ROOM_ID]).toBeDefined();
  });
});

// ─── pushAtlasToDoc — sentinel guard ────────────────────────────────────────

describe('stationAtlas.pushAtlasToDoc — first-boot sentinel guard (#79 P6)', () => {
  /** Bind a fresh Y.Doc to the atlas — same wiring main.ts uses at room join. */
  function bind(roomId: string): { doc: Y.Doc; getAtlas: () => Record<string, unknown> } {
    const doc = new Y.Doc();
    bindStationAtlasDoc(doc, { roomId, isPassagePublic: () => false });
    const map = doc.getMap('atlas');
    return {
      doc,
      getAtlas: () => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of map.entries()) out[k] = v;
        return out;
      },
    };
  }

  it('does NOT publish seed entries (lastSeen === 0) — auditors check this first', () => {
    // The security invariant. A baked seed room fabricated a floor plan the
    // station's ground-truth atlas must never learn from us. Bind AS the
    // shared station (isOwn=true only for that room) then apply the seed and
    // trigger a push — no fabricated NEIGHBOUR entry should hit the doc.
    applyFirstBootAtlas(firstBootAtlasSeed());
    const { getAtlas } = bind(STATION_ROOM_ID);
    // bindStationAtlasDoc calls pushAtlasToDoc during setup. Also force a
    // second push to make sure the guard fires on both paths.
    pushAtlasToDoc();
    const published = getAtlas();
    // No baked NEIGHBOUR was pushed — every seed row lands with lastSeen: 0.
    expect(published['furlong-atrium']).toBeUndefined();
    expect(published['furlong-market']).toBeUndefined();
    expect(published['furlong-observatory']).toBeUndefined();
    expect(published['furlong-lounge']).toBeUndefined();
  });

  it('DOES publish the station itself (isOwn overrides the sentinel skip)', () => {
    // The doc-owning room's own entry is expected in the doc — that is how
    // the atlas gossip converges. The guard is written `!isOwn && lastSeen===0`
    // for exactly this reason.
    applyFirstBootAtlas(firstBootAtlasSeed());
    // Harvest own room like main.ts would after joining, so lastSeen bumps
    // and the shared doc sees the real doors.
    harvestIntoAtlas({
      roomId: STATION_ROOM_ID,
      name: 'Furlong Station',
      doors: [{ doorId: 'north', targetSeed: 'real-north-seed' }],
    });
    const { getAtlas } = bind(STATION_ROOM_ID);
    pushAtlasToDoc();
    expect(getAtlas()[STATION_ROOM_ID]).toBeDefined();
  });

  it('once a seed room is VISITED for real, the sentinel is replaced and normal push resumes', () => {
    // Journey: apply seed → seed room appears locally with lastSeen: 0 →
    // player walks in and harvest fires → lastSeen is a real Date.now() →
    // push publishes it as any real entry.
    applyFirstBootAtlas(firstBootAtlasSeed());
    // We bind AS the atrium (as if the player just docked there).
    const { getAtlas } = bind('furlong-atrium');
    // First push: even though we're isOwn for the atrium (so the guard does
    // not skip it), its harvest hasn't fired yet — the seed entry has
    // lastSeen: 0 but the isOwn=true branch pushes it. That's fine for the
    // OWN room, whose entry the doc always accepts. But the OTHER seed
    // rooms (neighbours) must still be skipped.
    pushAtlasToDoc();
    const initial = getAtlas();
    expect(initial[STATION_ROOM_ID]).toBeUndefined(); // seed neighbour skipped
    // Now harvest as if we walked in — real stamp, real doors.
    harvestIntoAtlas({
      roomId: 'furlong-atrium',
      name: 'Atrium (visited for real)',
      doors: [{ doorId: 'south', targetSeed: 'seed-back-to-station' }],
    });
    pushAtlasToDoc();
    const published = getAtlas();
    expect(published['furlong-atrium']).toBeDefined();
    // The station is now a stub in our local atlas (harvest set it up with
    // no doors), which still passes the stub guard — but its lastSeen was
    // set by harvest to Date.now(), so it also won't fabricate geometry the
    // way a seed entry would. This asserts the safety of the visit path.
  });
});

// ─── #144: gossip-stamp bounds and eviction tiering ───────────────────────

const HOUR = 60 * 60 * 1000;

let doc: Y.Doc;

// Storage is reset by the shared beforeEach above; this adds the doc.
beforeEach(() => {
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
    localStorage.setItem('ssf-station-atlas', JSON.stringify({
      'module-old': {
        roomId: 'module-old', name: 'OLD', doors: {}, lastSeen: 8.64e15,
      },
    }));

    const entry = readAtlas()['module-old'];
    expect(entry).toBeDefined();          // the room survives...
    expect(entry.lastSeen).toBe(0);       // ...its impossible stamp does not
  });

  it('does not republish a legacy far-future stamp into a room doc', () => {
    localStorage.setItem('ssf-station-atlas', JSON.stringify({
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
    localStorage.setItem('ssf-station-atlas', JSON.stringify({
      'module-old': {
        roomId: 'module-old', name: 'OLD', doors: {}, lastSeen: Date.now() + 7 * HOUR,
      },
    }));

    expect(readAtlas()['module-old'].lastSeen).toBe(0);
    // Read the raw store, not the return value — this is the persistence claim.
    const raw = JSON.parse(localStorage.getItem('ssf-station-atlas')!);
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
      localStorage.setItem('ssf-station-atlas', JSON.stringify({
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
      localStorage.clear();
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
