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
  STATION_ROOM_ID,
  STATION_ROOM_KEY_B64,
  STATION_SEED_HINTS,
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
