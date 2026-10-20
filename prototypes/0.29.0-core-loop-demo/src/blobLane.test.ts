/**
 * 📦 blobLane — the page's half of the blob lane: nothing is reachable
 * without a trusted node and its token, the routes carry the token, and the
 * node's status answers are shape-checked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { __test, blobLaneNodeId, blobLaneReady, blobUrl, forgetBlobLane, formatBytes, setBlobLaneNode, setBlobLaneRoom } from './blobLane';
import { setNodeMediaOrigin } from './tvConsent';
import { tvNow, tvWallNow } from './tvDoc';

const ORIGIN = 'http://127.0.0.1:8080';
const CAP = 'c'.repeat(64);
const ID = 'a'.repeat(64);
const HASH = 'b'.repeat(64);

afterEach(() => {
  forgetBlobLane();
  setNodeMediaOrigin(null, tvNow(), tvWallNow());
});

describe('blobLane', () => {
  it('is ready only with a trusted node, its token and a room', () => {
    expect(blobLaneReady()).toBe(false);
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    setBlobLaneRoom('room-1');
    expect(blobLaneReady()).toBe(false); // the node's origin is not trusted yet
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    expect(blobLaneReady()).toBe(true);
    expect(blobLaneNodeId()).toBe(ID);
    setNodeMediaOrigin(null, tvNow(), tvWallNow());
    expect(blobLaneReady()).toBe(false);
    expect(blobUrl(HASH)).toBeNull();
  });

  it('refuses a node whose token or id is not 64 hex digits', () => {
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneRoom('room-1');
    setBlobLaneNode({ origin: ORIGIN, cap: 'short', irohId: ID });
    expect(blobLaneReady()).toBe(false);
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: 'zz' });
    expect(blobLaneReady()).toBe(false);
  });

  it('reads a blob from the node with the token, and nothing that is not a hash', () => {
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneRoom('room-1');
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    expect(blobUrl(HASH)).toBe(`${ORIGIN}/blob/${HASH}?cap=${CAP}`);
    expect(blobUrl('../api/fingerprint')).toBeNull();
    expect(blobUrl(HASH.toUpperCase())).toBeNull();
  });

  it('shape-checks the node\'s status answers', () => {
    const { parseState } = __test;
    expect(parseState({ state: 'none' })).toEqual({ state: 'none' });
    expect(parseState({ state: 'fetching', have: 10, size: 100 })).toEqual({ state: 'fetching', have: 10, size: 100 });
    expect(parseState({ state: 'complete', have: -1, size: 1.5 })).toEqual({ state: 'complete', have: 0, size: 0 });
    expect(parseState({ state: 'failed', have: 1, size: 2, why: 'x'.repeat(500) })).toMatchObject({ state: 'failed', why: 'x'.repeat(200) });
    expect(parseState({ state: 'evil' })).toEqual({ state: 'unknown' });
    expect(parseState(null)).toEqual({ state: 'unknown' });
  });

  it('formats sizes for the FETCH button', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(700 * 1024 ** 2)).toBe('700 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});
