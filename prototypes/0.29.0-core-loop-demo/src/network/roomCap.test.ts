import { describe, expect, it } from 'vitest';
import { buildRoomCapPayload, nextCapSeq, roomIsPublicSpace } from './roomCap';

describe('room cap payload (N8 / D3)', () => {
  it('carries the key, both flags coerced to booleans, and the sequence number', () => {
    expect(buildRoomCapPayload('k', true, false, 7)).toEqual({ roomKeyB64: 'k', chiaMode: true, publicRoom: false, seq: 7 });
    expect(buildRoomCapPayload('k', 0 as unknown as boolean, 1 as unknown as boolean, 2.9)).toEqual({
      roomKeyB64: 'k',
      chiaMode: false,
      publicRoom: true,
      seq: 2,
    });
    expect(buildRoomCapPayload('k', true, true, Number.NaN).seq).toBe(0);
  });

  it('sequences caps by the clock but never at or below the last one', () => {
    expect(nextCapSeq(0, 1_000)).toBe(1_000);
    // Same millisecond still orders.
    expect(nextCapSeq(1_000, 1_000)).toBe(1_001);
    // A clock that went backwards cannot reorder caps.
    expect(nextCapSeq(5_000, 1_000)).toBe(5_001);
  });

  it('calls a room public space when bundled, when its passage is public, and when passage is unknown', () => {
    expect(roomIsPublicSpace(true, false)).toBe(true);
    expect(roomIsPublicSpace(false, true)).toBe(true);
    expect(roomIsPublicSpace(false, undefined)).toBe(true);
    expect(roomIsPublicSpace(false, false)).toBe(false);
  });
});
