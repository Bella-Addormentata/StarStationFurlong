import { describe, expect, it } from 'vitest';
import { buildRoomCapPayload, roomIsPublicSpace } from './roomCap';

describe('room cap payload (N8 / D3)', () => {
  it('carries the key and both flags, coerced to booleans', () => {
    expect(buildRoomCapPayload('k', true, false)).toEqual({ roomKeyB64: 'k', chiaMode: true, publicRoom: false });
    expect(buildRoomCapPayload('k', 0 as unknown as boolean, 1 as unknown as boolean)).toEqual({
      roomKeyB64: 'k',
      chiaMode: false,
      publicRoom: true,
    });
  });

  it('calls a room public space when bundled, when its passage is public, and when passage is unknown', () => {
    expect(roomIsPublicSpace(true, false)).toBe(true);
    expect(roomIsPublicSpace(false, true)).toBe(true);
    expect(roomIsPublicSpace(false, undefined)).toBe(true);
    expect(roomIsPublicSpace(false, false)).toBe(false);
  });
});
