/**
 * 📺 tvTheatre — what a mounted player is keyed by: a change of key is a new
 * player on the set, the same key keeps the one that is there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mountKey, playsAsTexture } from './tvTheatre';
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

  it("is the set's own texture only for a node file or a link it may read: the rest is laid over the set, out of the CRT look's reach", () => {
    expect(playsAsTexture({ kind: 'blob', hash: 'b'.repeat(64), size: 2_000, provider: 'a'.repeat(64), mime: 'video/mp4' })).toBe(true);
    expect(playsAsTexture({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe(false);
    expect(playsAsTexture({ kind: 'archive', identifier: 'Sintel', file: 'sintel.mp4' })).toBe(false); // a chosen file too
    expect(playsAsTexture({ kind: 'archive', identifier: 'Sintel', file: '' })).toBe(false);
    expect(playsAsTexture({ kind: 'url', url: 'https://films.example/sintel.mp4' })).toBe(false); // a host the viewer never accepted
  });
});
