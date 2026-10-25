/**
 * 📺 tvTheatre — what a mounted player is keyed by: a change of key is a new
 * player on the set, the same key keeps the one that is there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mountKey } from './tvTheatre';
import { forgetBlobLane, setBlobLaneNode } from './blobLane';
import type { TvSource } from './tvDoc';

afterEach(() => { forgetBlobLane(); });

describe('📺 a mounted player', () => {
  it('reads a smaller copy as another file to mount, though it is the same programme as its original', () => {
    setBlobLaneNode({ origin: 'http://127.0.0.1:9000', cap: 'c'.repeat(64), irohId: 'a'.repeat(64) });
    const original: TvSource = { kind: 'blob', hash: 'b'.repeat(64), size: 2_000, provider: 'a'.repeat(64), mime: 'video/mp4', title: 'Sintel' };
    const copy: TvSource = { ...original, hash: 'd'.repeat(64), size: 500, was: { hash: original.hash, size: original.size } };
    expect(mountKey(copy, 1)).not.toBe(mountKey(original, 1));
    expect(mountKey(copy, 1)).toBe(mountKey({ ...copy }, 2)); // a replay of a seekable file keeps its player
  });
});
