// station.ts tests (#79 P3): the shared-station gate + descriptor.
//
// station.ts is intentionally a set of PURE, no-side-effect helpers over a
// pair of baked-in constants. We test the exported gates and the descriptor
// factory to lock in the two invariants the boot flow leans on:
//   1. hasSharedStation() returns true when both id and key are configured;
//      hasSharedStationSeed() narrows further to require at least one seed hint.
//   2. sharedStationBootstrap() returns a DEFENSIVE COPY of the seed hints —
//      a caller that mutates the returned array must NOT corrupt the constants.
//
// The values under test are compile-time constants; we import the module under
// test rather than re-declaring them, so the assertions track any future rebake.

import { describe, expect, it } from 'vitest';
import {
  STATION_ATLAS_SEED,
  STATION_ROOM_ID,
  STATION_ROOM_KEY_B64,
  STATION_SEED_HINTS,
  firstBootAtlasSeed,
  hasSharedStation,
  hasSharedStationSeed,
  isSharedStationRoom,
  sharedStationBootstrap,
} from './station';

describe('station.ts — shared station gates', () => {
  it('exposes a non-empty station room id + room key', () => {
    expect(typeof STATION_ROOM_ID).toBe('string');
    expect(STATION_ROOM_ID.length).toBeGreaterThan(0);
    expect(typeof STATION_ROOM_KEY_B64).toBe('string');
    expect(STATION_ROOM_KEY_B64.length).toBeGreaterThan(0);
  });

  it('hasSharedStation() is true when id + key are configured', () => {
    // Both baked in → the boot flow may prefer the shared station over the
    // per-install home id (see fetchDefaultBootstrap).
    expect(hasSharedStation()).toBe(true);
  });

  it('hasSharedStationSeed() tracks STATION_SEED_HINTS length', () => {
    // Strict gate: only true when a seed host is baked in. In the dev stage
    // hints are empty and the strict gate is false — callers that need
    // direct-dial reachability should see that clearly.
    expect(hasSharedStationSeed()).toBe(STATION_SEED_HINTS.length > 0);
  });

  it('isSharedStationRoom() matches only the exact station id', () => {
    expect(isSharedStationRoom(STATION_ROOM_ID)).toBe(true);
    // Case-sensitive: the room id is a bytes-key, not a display name.
    expect(isSharedStationRoom(STATION_ROOM_ID.toUpperCase())).toBe(false);
    // Rejects the empty/null-ish + unrelated ids the boot flow can see.
    expect(isSharedStationRoom('')).toBe(false);
    expect(isSharedStationRoom(null)).toBe(false);
    expect(isSharedStationRoom(undefined)).toBe(false);
    expect(isSharedStationRoom('home-abc123')).toBe(false);
    expect(isSharedStationRoom(`${STATION_ROOM_ID} `)).toBe(false); // trailing space
  });
});

describe('station.ts — sharedStationBootstrap descriptor', () => {
  it('carries the baked id + key', () => {
    const boot = sharedStationBootstrap();
    expect(boot).not.toBeNull();
    expect(boot!.roomId).toBe(STATION_ROOM_ID);
    expect(boot!.roomKeyB64).toBe(STATION_ROOM_KEY_B64);
  });

  it('reflects the current STATION_SEED_HINTS length', () => {
    // The descriptor is what the boot flow hands the node — it must match the
    // constants exactly (no filtering, no re-ordering) so a hint-less stage
    // gets an empty memberHints array (not undefined, not fabricated hints).
    const boot = sharedStationBootstrap()!;
    expect(Array.isArray(boot.memberHints)).toBe(true);
    expect(boot.memberHints.length).toBe(STATION_SEED_HINTS.length);
  });

  it('returns a DEFENSIVE COPY of memberHints — mutating it does not corrupt the constants', () => {
    // The constants are baked into every install; a caller who mutates a
    // returned array must NEVER change what the next caller sees.
    const boot = sharedStationBootstrap()!;
    const originalLength = STATION_SEED_HINTS.length;
    boot.memberHints.push({ nodeId: 'MUTANT-should-not-persist' });
    // The constants array is unchanged.
    expect(STATION_SEED_HINTS.length).toBe(originalLength);
    // A fresh descriptor is also unchanged.
    const fresh = sharedStationBootstrap()!;
    expect(fresh.memberHints.length).toBe(originalLength);
    expect(fresh.memberHints.find((h) => h.nodeId?.startsWith('MUTANT'))).toBeUndefined();
  });

  it('defensive-copies nested arrays inside each hint too', () => {
    // A hint-less stage still exercises the copy path shape. When hints exist,
    // each `relayUrls` / `directAddrs` is a fresh array so callers can't reach
    // through and mutate the baked constants.
    const boot = sharedStationBootstrap()!;
    for (let i = 0; i < boot.memberHints.length; i++) {
      const returnedRelay = boot.memberHints[i].relayUrls;
      const bakedRelay = STATION_SEED_HINTS[i].relayUrls;
      if (returnedRelay && bakedRelay) {
        expect(returnedRelay).not.toBe(bakedRelay); // different array references
      }
      const returnedAddrs = boot.memberHints[i].directAddrs;
      const bakedAddrs = STATION_SEED_HINTS[i].directAddrs;
      if (returnedAddrs && bakedAddrs) {
        expect(returnedAddrs).not.toBe(bakedAddrs);
      }
    }
  });
});

describe('station.ts — first-boot atlas seed (#79 P6)', () => {
  it('names the shared station room as the hub entry', () => {
    // The seed must include the station itself, otherwise a first-run boot
    // in the station has no entry to BFS from and the exterior renders nothing.
    const hub = STATION_ATLAS_SEED.find((e) => e.roomId === STATION_ROOM_ID);
    expect(hub).toBeDefined();
    expect(hub!.doors.length).toBeGreaterThan(0);
  });

  it('every door names an entry that exists in the seed (spoke topology closes)', () => {
    // A door pointing at a room the seed does not describe would render as a
    // dead-end stub in the exterior — the whole reason to bake the seed is to
    // show a complete visible shell BEFORE any gossip.
    const ids = new Set(STATION_ATLAS_SEED.map((e) => e.roomId));
    for (const entry of STATION_ATLAS_SEED) {
      for (const door of entry.doors) {
        expect(ids.has(door.targetRoomId)).toBe(true);
      }
    }
  });

  it('every door uses a valid cardinal wall (x+/x-/y+/y-)', () => {
    // The exterior renderer poses neighbours off the wall vocabulary — a
    // legacy compass label would silently drop back to the fallback pose.
    const walls = new Set(['x+', 'x-', 'y+', 'y-']);
    for (const entry of STATION_ATLAS_SEED) {
      for (const door of entry.doors) {
        expect(walls.has(door.wall)).toBe(true);
        if (door.farWall !== undefined) {
          expect(walls.has(door.farWall)).toBe(true);
        }
      }
    }
  });

  it('NO door carries a targetSeed — credentials do not ride in the baked seed', () => {
    // Security invariant: the baked seed is GEOMETRY and NAMES only. A
    // credential in here would ship to every install and, worse, be pushed
    // into the shared doc if the sentinel guard ever regressed.
    for (const entry of STATION_ATLAS_SEED) {
      for (const door of entry.doors) {
        // targetSeed is not even part of the seed-door shape — assert the
        // runtime shape has no such key so a future refactor cannot slip
        // one in unnoticed.
        expect(Object.prototype.hasOwnProperty.call(door, 'targetSeed')).toBe(false);
      }
    }
  });

  it('firstBootAtlasSeed() returns a DEFENSIVE COPY — mutating it does not corrupt the constant', () => {
    // Same discipline as sharedStationBootstrap. This one matters MORE because
    // main.ts will pass the returned array into a store-mutating merge — a
    // shallow copy would let a merge-time patch leak back into the constant
    // and change what the NEXT boot sees.
    const seedA = firstBootAtlasSeed();
    const bakedLen = STATION_ATLAS_SEED.length;
    const bakedHub = STATION_ATLAS_SEED.find((e) => e.roomId === STATION_ROOM_ID)!;
    const bakedHubDoorsLen = bakedHub.doors.length;

    // Mutate every layer we care about.
    seedA.push({ roomId: 'MUTANT', name: 'nope', doors: [] });
    const hubCopy = seedA.find((e) => e.roomId === STATION_ROOM_ID)!;
    hubCopy.name = 'CORRUPTED';
    hubCopy.doors.push({ doorId: 'nope', targetRoomId: 'MUTANT', wall: 'y-', lateral: 999 });
    if (hubCopy.doors[0]) hubCopy.doors[0].lateral = 1234;

    // The constants are unchanged.
    expect(STATION_ATLAS_SEED.length).toBe(bakedLen);
    expect(STATION_ATLAS_SEED.find((e) => e.roomId === 'MUTANT')).toBeUndefined();
    expect(bakedHub.name).not.toBe('CORRUPTED');
    expect(bakedHub.doors.length).toBe(bakedHubDoorsLen);
    if (bakedHub.doors[0]) expect(bakedHub.doors[0].lateral).not.toBe(1234);

    // A fresh accessor yields the pristine values.
    const seedB = firstBootAtlasSeed();
    expect(seedB.length).toBe(bakedLen);
    expect(seedB.find((e) => e.roomId === 'MUTANT')).toBeUndefined();
    expect(seedB.find((e) => e.roomId === STATION_ROOM_ID)!.name).toBe(bakedHub.name);
  });

  it('firstBootAtlasSeed() preserves every door field the merger consumes', () => {
    // A defensive-copy bug that dropped, say, farWall would silently break
    // the pose composition. Assert the exact field shape survives a copy.
    const bakedHub = STATION_ATLAS_SEED.find((e) => e.roomId === STATION_ROOM_ID)!;
    const copiedHub = firstBootAtlasSeed().find((e) => e.roomId === STATION_ROOM_ID)!;
    expect(copiedHub.doors.length).toBe(bakedHub.doors.length);
    for (let i = 0; i < bakedHub.doors.length; i++) {
      const a = bakedHub.doors[i];
      const b = copiedHub.doors[i];
      expect(b.doorId).toBe(a.doorId);
      expect(b.targetRoomId).toBe(a.targetRoomId);
      expect(b.wall).toBe(a.wall);
      expect(b.lateral).toBe(a.lateral);
      expect(b.farDoor).toBe(a.farDoor);
      expect(b.farWall).toBe(a.farWall);
      expect(b.farLateral).toBe(a.farLateral);
    }
  });
});
