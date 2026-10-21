/**
 * 🧲 torrentLane — the page's half of the torrent lane: only a node built
 * with it is offered, the magnet goes to the node and never into a source,
 * the node's answers are shape-checked, and PLAY takes only the finished
 * blob.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBlobLane, formatBytes, setBlobLaneNode, setBlobLaneRoom, torrentLaneReady } from './blobLane';
import { forgetTorrentLane, parseTorrentState, refreshTorrentState, startTorrent, torrentLine, torrentSource, torrentState } from './torrentLane';
import { setNodeMediaOrigin } from './tvConsent';
import { tvNow, tvWallNow } from './tvDoc';

const ORIGIN = 'http://127.0.0.1:8080';
const CAP = 'c'.repeat(64);
const ID = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const INFO = '08ada5a7a6183aae1e09d831df6748d566095a10';

function withNode(torrent: boolean) {
  setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
  setBlobLaneRoom('room-1');
  setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID, torrent });
}

const complete = { state: 'complete', id: INFO, name: 'Sintel', have: 129_000_000, size: 129_000_000, peers: 0, uploaded: 0, why: '', hash: HASH, mime: 'video/mp4' };

afterEach(() => {
  vi.unstubAllGlobals();
  forgetTorrentLane();
  forgetBlobLane();
  setNodeMediaOrigin(null, tvNow(), tvWallNow());
});

describe('torrentLane', () => {
  it('is offered only by a node built with it', () => {
    withNode(false);
    expect(torrentLaneReady()).toBe(false);
    withNode(true);
    expect(torrentLaneReady()).toBe(true);
    setNodeMediaOrigin(null, tvNow(), tvWallNow());
    expect(torrentLaneReady()).toBe(false);
  });

  it('hands the pasted magnet to the node as the body, with the token and room', async () => {
    withNode(true);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, id: INFO }), { status: 202 });
    }));
    expect(await startTorrent('not a magnet')).toMatch(/magnet/);
    expect(calls).toHaveLength(0);
    const magnet = `magnet:?xt=urn:btih:${INFO}&dn=Sintel`;
    expect(await startTorrent(`  ${magnet} `)).toBeNull();
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/torrent/add?cap=${CAP}&room=room-1`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(magnet);
  });

  it('says the node\'s reason when it refuses', async () => {
    withNode(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'a torrent is already running on this node' }), { status: 409 })));
    expect(await startTorrent(`magnet:?xt=urn:btih:${INFO}`)).toBe('Your node: a torrent is already running on this node.');
  });

  it('reads the node\'s status, and drops what is not its shape', () => {
    expect(parseTorrentState({ state: 'none' })).toEqual({ state: 'none' });
    expect(parseTorrentState(null)).toEqual({ state: 'unknown' });
    expect(parseTorrentState({ state: 'seeding' })).toEqual({ state: 'unknown' });
    // Complete with no blob hash is not complete.
    expect(parseTorrentState({ ...complete, hash: 'nope' })).toEqual({ state: 'unknown' });
    const st = parseTorrentState({ ...complete, have: -5, name: 'x'.repeat(500), id: 'evil' });
    expect(st.state === 'complete' && [st.have, st.name.length, st.id]).toEqual([0, 120, '']);
  });

  it('plays only the finished download, as a blob from this node', async () => {
    withNode(true);
    expect(torrentSource(parseTorrentState({ ...complete, state: 'downloading', hash: null }))).toBeNull();
    const source = torrentSource(parseTorrentState(complete));
    expect(source).toEqual({ kind: 'blob', hash: HASH, size: 129_000_000, provider: ID, mime: 'video/mp4', title: 'Sintel' });
    // No magnet, tracker or info hash ever rides in the record.
    expect(JSON.stringify(source)).not.toContain(INFO);
  });

  it('forgets a restarted node\'s torrent', async () => {
    withNode(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(complete), { status: 200 })));
    await refreshTorrentState();
    expect(torrentState().state).toBe('complete');
    setBlobLaneNode({ origin: ORIGIN, cap: 'd'.repeat(64), irohId: ID, torrent: true });
    expect(torrentState().state).toBe('unknown');
  });

  it('words the progress for the remote', () => {
    const dl = parseTorrentState({ ...complete, state: 'downloading', have: 64_500_000, peers: 1, uploaded: 2_000_000, hash: null });
    expect(torrentLine(dl, formatBytes)).toBe('🧲 Sintel: 50% of 123 MB · 1 peer · shared 1.9 MB');
    expect(torrentLine(parseTorrentState({ ...complete, state: 'failed', why: 'no peer sent anything' }), formatBytes)).toBe('⚠️ no peer sent anything');
    expect(torrentLine(parseTorrentState(complete), formatBytes)).toMatch(/stopped sharing/);
  });
});
