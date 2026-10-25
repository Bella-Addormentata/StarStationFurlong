/**
 * 📦 blobLane — the page's half of the blob lane: nothing is reachable
 * without a trusted node and its token, the routes carry the token, and the
 * node's status answers are shape-checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __test, blobLaneNodeId, blobNodeTag, blobLaneReady, blobState, blobUrl, fetchFromLink, forgetBlob, forgetBlobLane, formatBytes, freshNodeHolders, nodeHolders,
  nodeShares, recheckBlob, refreshHeldBlobs, refreshHolders, setBlobLaneNode, setBlobLaneRoom, shareBlob,
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

  it('keeps WHERE\'s answer, and says it fresh only for as long as it is asked again after', async () => {
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneRoom('room-1');
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ holders: { [HASH]: [ID] } }), { status: 200 })));
    expect(freshNodeHolders(HASH, 1_000)).toBeNull(); // never asked
    await refreshHolders([HASH], 1_000);
    expect(nodeHolders(HASH)).toEqual([ID]);
    expect(freshNodeHolders(HASH, 30_999)).toEqual([ID]);
    expect(freshNodeHolders(HASH, 31_000)).toBeNull(); // due to be asked again: not an answer for now
    expect(nodeHolders(HASH)).toEqual([ID]); // still what FETCH names meanwhile
  });

  it('formats sizes for the FETCH button', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(700 * 1024 ** 2)).toBe('700 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  describe('🔗 SSF links', () => {
    const [OTHER, FAR] = ['d', 'e'].map((c) => c.repeat(64)) as [string, string];
    function withNode() {
      setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
      setBlobLaneRoom('room-1');
      setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID });
    }

    it('a pasted link asks this node to dial the nodes it names, for this room, marked as a link', async () => {
      const link = { hash: HASH, size: 42, title: 'Sintel', mime: 'video/webm', nodes: [OTHER, FAR] };
      expect(await fetchFromLink(link)).toMatch(/node/); // no node here
      withNode();
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes(FAR)
          ? new Response(JSON.stringify({ error: 'the link names no other node that holds this file' }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 202 });
      }));
      expect(await fetchFromLink(link)).toBe('Your node: the link names no other node that holds this file.');
      expect(await fetchFromLink({ ...link, nodes: [OTHER] })).toBeNull();
      const asked = new URL(urls[1]!);
      expect(asked.pathname).toBe('/api/blob/fetch');
      expect(Object.fromEntries(asked.searchParams)).toEqual({ cap: CAP, room: 'room-1', hash: HASH, size: '42', from: OTHER, mime: 'video/webm', link: '1' });
      expect(await fetchFromLink({ ...link, nodes: [] })).toMatch(/node/);
      expect(urls).toHaveLength(2);
    });

    it('a file marked shareable says so, with the other holders its link named, until it is let go', async () => {
      withNode();
      let shared: Record<string, string[]> = { [HASH]: [OTHER], [FAR]: [] };
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/api/blob/share')) {
          const on = new URL(url).searchParams.get('on') === '1';
          shared = on ? { ...shared, [OTHER]: [] } : {};
          return new Response(JSON.stringify({ shared: on, via: on ? [FAR, 'nope'] : [] }), { status: 200 });
        }
        if (url.includes('/api/blob/forget')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        // FAR is shared but not held for this room: not this room's to say.
        return new Response(JSON.stringify({ held: [HASH, OTHER], reachable: [], shared }), { status: 200 });
      }));
      expect(nodeShares(HASH)).toBeNull(); // not said yet
      await refreshHeldBlobs(1_000);
      expect(nodeShares(HASH)).toEqual([OTHER]);
      expect(nodeShares(OTHER)).toBe(false);
      expect(nodeShares(FAR)).toBe(false);
      expect(await shareBlob(OTHER, true)).toEqual({ via: [FAR] });
      expect(nodeShares(OTHER)).toEqual([FAR]);
      expect(await shareBlob(OTHER, false)).toEqual({ via: [] });
      expect(nodeShares(OTHER)).toBe(false);
      expect(await forgetBlob(HASH)).toBeNull();
      expect(nodeShares(HASH)).toBe(false);
      expect(await shareBlob('not a hash', true)).toEqual({ error: expect.stringMatching(/node/) });
    });
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
