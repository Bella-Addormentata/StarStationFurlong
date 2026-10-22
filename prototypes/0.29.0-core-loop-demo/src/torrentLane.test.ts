/**
 * 🧲 torrentLane — the page's half of the torrent lane: only a node built
 * with it is offered, the magnet goes to the node and never into a source,
 * the node's answers are shape-checked, and PLAY takes only the finished
 * blob.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBlob, forgetBlob, forgetBlobLane, formatBytes, nodeHolders, nodeHolds, nodeHostCopies, nodeLibrarySpace, nodeReaches, refreshHeldBlobs,
  refreshHolders, setBlobLaneNode, setBlobLaneRoom, setHostCopies, torrentLaneReady,
} from './blobLane';
import {
  confirmTorrent, forgetTorrentLane, MAX_TORRENT_FILE, parseTorrentState, refreshTorrentState, startTorrent, startTorrentAgain, startTorrentFile,
  torrentLine, torrentOrigin, torrentRunning, torrentSource, torrentState,
} from './torrentLane';
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

const complete = {
  state: 'complete', id: INFO, room: 'room-1', name: 'Sintel', have: 129_000_000, size: 129_000_000, peers: 0, uploaded: 0, why: '', hash: HASH, mime: 'video/mp4',
  pick: 2, files: [{ index: 2, name: 'Sintel/Sintel.mp4', size: 129_000_000, fits: true }],
};
const ready = { ...complete, state: 'ready', size: 0, have: 0, hash: null, mime: null, pick: 2, files: [
  { index: 0, name: 'Sintel/Sintel.mkv', size: 900_000_000, fits: false },
  { index: 2, name: 'Sintel/Sintel.mp4', size: 129_000_000, fits: true },
] };

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

  it('plays nothing held for another room', () => {
    withNode(true);
    expect(torrentSource(parseTorrentState({ ...complete, room: 'room-2' }))).toBeNull();
  });

  it('drops the finished file at START, and an answer asked before it', async () => {
    withNode(true);
    const pending: Array<(r: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(complete), { status: 200 })));
    await refreshTorrentState();
    expect(torrentSource()).not.toBeNull();
    // A status asked before START answers only after it: it must not land.
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/status')
      ? new Promise<Response>((r) => { pending.push(r); })
      : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 }))));
    const stale = refreshTorrentState();
    expect(await startTorrent(`magnet:?xt=urn:btih:${INFO}`)).toBeNull();
    expect(torrentSource()).toBeNull();
    // The stale one answers last, after START's own ask came back.
    pending[1]!(new Response(JSON.stringify({ ...complete, state: 'metadata', hash: null }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    pending[0]!(new Response(JSON.stringify(complete), { status: 200 }));
    await stale;
    expect(torrentState().state).toBe('metadata');
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

  it('reads the file list a torrent stops at, and offers only a file that is on it', () => {
    const st = parseTorrentState(ready);
    expect(st.state === 'ready' && [st.files.map((f) => [f.index, f.fits]), st.pick]).toEqual([[[0, false], [2, true]], 2]);
    expect(torrentRunning(st)).toBe(true);
    expect(torrentLine(st, formatBytes)).toMatch(/2 files the TV can play\. Nothing downloads until you pick one/);
    // A pick that is not on the list, duplicates and junk rows are dropped.
    const odd = parseTorrentState({ ...ready, pick: 7, files: [...ready.files, { index: 2, name: 'again' }, { index: -1 }, 'x', null] });
    expect(odd.state === 'ready' && [odd.files.length, odd.pick]).toEqual([2, null]);
    // A long list is bounded.
    const many = parseTorrentState({ ...ready, files: Array.from({ length: 900 }, (_, i) => ({ index: i, name: `e${i}.mp4`, size: 1 })) });
    expect(many.state === 'ready' && many.files.length).toBe(200);
  });

  it('confirms the pick, and sends a .torrent file as its bytes', async () => {
    withNode(true);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.includes('/status') ? ready : { ok: true }), { status: url.includes('/add') ? 202 : 200 });
    }));
    expect(await confirmTorrent(2)).toBeNull();
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/torrent/confirm?cap=${CAP}&file=2`);
    expect(calls[0]!.init?.method).toBe('POST');
    calls.length = 0;
    const file = new Blob([new Uint8Array([100, 52, 58])]);
    expect(await startTorrentFile(file)).toBeNull();
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/torrent/add?cap=${CAP}&room=room-1&kind=torrent`);
    expect(calls[0]!.init?.body).toBe(file);
    expect(await startTorrentFile(new Blob([]))).toMatch(/empty/);
    expect(await startTorrentFile({ size: MAX_TORRENT_FILE + 1 } as Blob)).toMatch(/too big/);
  });

  it('GET AGAIN asks by the info hash alone, with the file played before offered first', async () => {
    withNode(true);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }));
    expect(await startTorrentAgain({ ih: INFO, file: 3 })).toBeNull();
    expect(calls[0]).toBe(`${ORIGIN}/api/torrent/add?cap=${CAP}&room=room-1&file=3 magnet:?xt=urn:btih:${INFO}`);
    expect(await startTorrentAgain({ ih: 'nope', file: 3 })).toMatch(/does not say which torrent/);
  });

  it('says where a finished file came from, for the library', () => {
    expect(torrentOrigin(parseTorrentState(complete))).toEqual({ ih: INFO, file: 2 });
    expect(torrentOrigin(parseTorrentState(ready))).toBeNull();
    expect(torrentOrigin(parseTorrentState({ ...complete, id: 'x' }))).toBeNull();
  });
});

describe('what this node holds, for the library', () => {
  it('asks once for the room, and answers per hash and per provider', async () => {
    withNode(true);
    let asks = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asks++;
      expect(url).toBe(`${ORIGIN}/api/blob/held?cap=${CAP}&room=room-1`);
      return new Response(JSON.stringify({ held: [HASH, 'junk'], reachable: [ID] }), { status: 200 });
    }));
    expect(nodeReaches(ID)).toBeNull(); // not asked yet
    await refreshHeldBlobs(1_000);
    await refreshHeldBlobs(2_000); // within the poll interval: not asked again
    expect(asks).toBe(1);
    expect(nodeHolds(HASH)).toBe(true);
    expect(nodeHolds('e'.repeat(64))).toBe(false);
    expect(nodeReaches(ID)).toBe(true);
    expect(nodeReaches('f'.repeat(64))).toBe(false);
    // Another room's answer is not this one's.
    setBlobLaneRoom('room-2');
    expect(nodeHolds(HASH)).toBe(false);
    expect(nodeReaches(ID)).toBeNull();
  });

  it('says how much the node keeps, and lets one of its files go', async () => {
    withNode(true);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/forget')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ held: [HASH], reachable: [], keep: true, kept: 129_000_000, quota: 8 * 1024 ** 3 }), { status: 200 });
    }));
    expect(nodeLibrarySpace()).toBeNull();
    await refreshHeldBlobs(1_000);
    expect(nodeLibrarySpace()).toEqual({ keep: true, kept: 129_000_000, quota: 8 * 1024 ** 3 });
    expect(await forgetBlob(HASH)).toBeNull();
    expect(calls[1]).toBe(`POST ${ORIGIN}/api/blob/forget?cap=${CAP}&hash=${HASH}`);
    expect(nodeHolds(HASH)).toBe(false);
    // The space changed: the next paint asks again at once.
    await refreshHeldBlobs(1_500);
    expect(calls).toHaveLength(3);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'that file is still on its way — wait for it' }), { status: 409 })));
    expect(await forgetBlob(HASH)).toBe('Your node: that file is still on its way — wait for it.');
    expect(await forgetBlob('nope')).toMatch(/node/);
  });
});

describe('🏠 the room\'s host keeps copies, and WHERE finds them', () => {
  const HOST = 'd'.repeat(64);

  it('a room this machine hosts is declared to its node once, and the switch answers with what it spent', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/api/blob/host')) {
        const on = !url.includes('on=0');
        return new Response(JSON.stringify({ host: { on, cap: 4 * 1024 ** 3, day: 8 * 1024 ** 3, spent: 0, files: 0, dayFiles: 24 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ held: [], reachable: [], keep: true, kept: 0, quota: 1, host: { on: true, cap: 4 * 1024 ** 3, day: 8 * 1024 ** 3, spent: 129_000_000, files: 1, dayFiles: 24 } }), { status: 200 });
    }));
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneNode({ origin: ORIGIN, cap: CAP, irohId: ID, torrent: false });
    setBlobLaneRoom('room-1', true);
    setBlobLaneRoom('room-1', true); // the same room again: not declared twice
    await Promise.resolve();
    expect(calls).toEqual([`POST ${ORIGIN}/api/blob/host?cap=${CAP}&room=room-1`]);
    expect(nodeHostCopies()).toBeNull(); // the node has not said yet
    await refreshHeldBlobs(1_000);
    expect(nodeHostCopies()).toEqual({ on: true, cap: 4 * 1024 ** 3, day: 8 * 1024 ** 3, spent: 129_000_000, files: 1, dayFiles: 24 });
    expect(await setHostCopies(false)).toBeNull();
    expect(calls.at(-1)).toBe(`POST ${ORIGIN}/api/blob/host?cap=${CAP}&room=room-1&on=0`);
    expect(nodeHostCopies()?.on).toBe(false);
    // A visitor's page declares nothing.
    calls.length = 0;
    setBlobLaneRoom('room-2', false);
    expect(calls).toEqual([]);
  });

  it('asks who holds the files, at most every half minute each, and FETCH names them after the provider', async () => {
    withNode(true);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/where')) return new Response(JSON.stringify({ holders: { [HASH]: [HOST, 'junk'], ['e'.repeat(64)]: [] } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    expect(nodeHolders(HASH)).toBeNull();
    await refreshHolders([HASH, 'e'.repeat(64), 'not a hash'], 1_000);
    expect(calls).toEqual([`GET ${ORIGIN}/api/blob/where?cap=${CAP}&room=room-1&hashes=${HASH}%2C${'e'.repeat(64)}`]);
    expect(nodeHolders(HASH)).toEqual([HOST]);
    expect(nodeHolders('e'.repeat(64))).toEqual([]);
    await refreshHolders([HASH], 20_000); // asked lately: not again
    expect(calls).toHaveLength(1);
    // A file the answer leaves out (the node was busy asking) stays unknown.
    await refreshHolders(['f'.repeat(64)], 20_000);
    expect(nodeHolders('f'.repeat(64))).toBeNull();
    expect(await fetchBlob(HASH, 1000, ID, 'video/webm')).toBeNull();
    expect(calls.at(-1)).toBe(`POST ${ORIGIN}/api/blob/fetch?cap=${CAP}&room=room-1&hash=${HASH}&size=1000&from=${ID}%2C${HOST}&mime=video%2Fwebm`);
    // Another room's answer is not this one's.
    setBlobLaneRoom('room-2');
    expect(nodeHolders(HASH)).toBeNull();
  });
});
