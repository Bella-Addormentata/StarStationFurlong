/**
 * 📦 blobLane — the page's half of the blob lane: nothing is reachable
 * without a trusted node and its token, the routes carry the token, and the
 * node's status answers are shape-checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __test, blobLaneNodeId, blobNodeTag, blobLaneReady, blobState, blobUrl, forgetBlob, forgetBlobLane, formatBytes, recheckBlob, setBlobLaneNode, setBlobLaneRoom,
} from './blobLane';
import { setNodeMediaOrigin } from './tvConsent';
import { tvNow, tvWallNow } from './tvDoc';

const ORIGIN = 'http://127.0.0.1:8080';
const CAP = 'c'.repeat(64);
const ID = 'a'.repeat(64);
const HASH = 'b'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('tags the node a blob is read from, so a restarted node is a new mount', () => {
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneRoom('room-1');
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    const before = blobNodeTag();
    setBlobLaneNode({ origin: ORIGIN, cap: 'd'.repeat(64), irohId: ID });
    expect(blobNodeTag()).not.toBe(before);
    setBlobLaneNode(null);
    expect(blobNodeTag()).toBe('');
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

  describe('a whole file can go again', () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    function withNode() {
      setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
      setBlobLaneRoom('room-1');
      setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    }

    it('asks about a complete file again, less often, and takes its going', async () => {
      withNode();
      let answer: unknown = { state: 'complete', have: 5, size: 5 };
      const asks: number[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => {
        asks.push(asks.length);
        return new Response(JSON.stringify(answer), { status: 200 });
      }));
      blobState(HASH, 0);
      await settle(); await settle();
      expect(blobState(HASH, 1).state).toBe('complete');
      blobState(HASH, 5_000); // complete: not asked again a second later
      expect(asks).toHaveLength(1);
      answer = { state: 'none' };
      blobState(HASH, 20_000);
      await settle(); await settle();
      expect(asks).toHaveLength(2);
      expect(blobState(HASH, 20_001).state).toBe('none');
    });

    it('drops a status asked before a forget, and asks again after a recheck', async () => {
      withNode();
      const pending: Array<(r: Response) => void> = [];
      vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/forget')
        ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        : new Promise<Response>((r) => { pending.push(r); })));
      blobState(HASH, 0); // asked; the answer is late
      expect(await forgetBlob(HASH)).toBeNull();
      pending[0]!(new Response(JSON.stringify({ state: 'complete', have: 5, size: 5 }), { status: 200 }));
      await settle(); await settle();
      expect(blobState(HASH, 1).state).toBe('unknown'); // not the stale complete
      // A player that could not read it: the next look asks at once.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'none' }), { status: 200 })));
      recheckBlob(HASH);
      blobState(HASH, 2);
      await settle(); await settle();
      expect(blobState(HASH, 3).state).toBe('none');
    });
  });
});
