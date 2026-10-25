/**
 * 📺 tvUI — the remote's gate on what this build writes into the room: a
 * source this build would refuse to play is said no to with the reason, and
 * never written — from the paste box and from PREVIOUSLY ON alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agoText, libraryKind, libraryView, playRefusal, tvNavIndex, whereabouts } from './tvUI';
import { tvNow, tvWallNow, type TvLibraryEntry } from './tvDoc';
import { forgetMediaConsent, setNodeMediaOrigin, setOwnMediaOrigins } from './tvConsent';
import { forgetBlobLane, refreshHeldBlobs, refreshHolders, setBlobLaneNode, setBlobLaneRoom } from './blobLane';
import { setConvenienceLanesForTest } from './sovereignty';

beforeEach(() => {
  forgetMediaConsent();
  setOwnMediaOrigins(['http://localhost:4173', 'http://127.0.0.1:8080']);
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('what the remote refuses to write, serverless only (the build default)', () => {
  beforeEach(() => { setConvenienceLanesForTest(false); });

  it('a lane this build does not offer, a link on another server, a private host, a non-link — each with its reason', () => {
    expect(playRefusal({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toMatch(/YouTube is off here/);
    expect(playRefusal({ kind: 'archive', identifier: 'metropolis', file: '' })).toMatch(/archive\.org is off here/);
    expect(playRefusal({ kind: 'url', url: 'https://archive.org/download/metropolis/a%20film.mp4' })).toMatch(/on another server/);
    expect(playRefusal({ kind: 'url', url: 'https://example.org/a.mp4' })).toMatch(/on another server/);
    expect(playRefusal({ kind: 'url', url: 'http://192.168.1.20/x.mp4' })).toMatch(/private network/);
    expect(playRefusal({ kind: 'url', url: 'not a url' })).toMatch(/not a link/);
  });

  it('a link on this page\'s own origin or its node plays here: nothing to refuse', () => {
    expect(playRefusal({ kind: 'url', url: 'http://localhost:4173/film.mp4' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'http://127.0.0.1:8080/blob/abc' })).toBeNull();
  });
});

describe('the remote by keyboard: ↑/↓ step through the visible controls and wrap', () => {
  it('steps and wraps at both ends, lands on the first from nowhere, and has nowhere to go with no control', () => {
    expect(tvNavIndex(5, 0, 1)).toBe(1);
    expect(tvNavIndex(5, 4, 1)).toBe(0); // ↓ from the last wraps to the first
    expect(tvNavIndex(5, 0, -1)).toBe(4); // ↑ from the first wraps to the last
    expect(tvNavIndex(5, 2, -1)).toBe(1);
    expect(tvNavIndex(5, -1, 1)).toBe(0); // focus on the view itself: the first control
    expect(tvNavIndex(5, -1, -1)).toBe(0);
    expect(tvNavIndex(5, 9, 1)).toBe(0); // a control that just left the list (a repaint): the first
    expect(tvNavIndex(1, 0, 1)).toBe(0); // one control: it stays
    expect(tvNavIndex(1, 0, -1)).toBe(0);
    expect(tvNavIndex(0, -1, 1)).toBe(-1); // nothing visible: nowhere to go
  });
});

describe('with the convenience lanes on', () => {
  beforeEach(() => { setConvenienceLanesForTest(true); });

  it('the product\'s lanes and a public host pass (the theatre asks the viewer); a private host never', () => {
    expect(playRefusal({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBeNull();
    expect(playRefusal({ kind: 'archive', identifier: 'metropolis', file: '' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'https://example.org/a.mp4' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'http://nas.local/a.mp4' })).toMatch(/private network/);
    expect(playRefusal({ kind: 'url', url: 'http://[fe80::1]/a.mp4' })).toMatch(/private network/);
  });
});

describe('📚 the library on the remote', () => {
  const blob = { kind: 'blob' as const, hash: 'b'.repeat(64), size: 9, provider: 'c'.repeat(64) };
  const lib: TvLibraryEntry[] = [
    { source: { ...blob, title: 'Sintel' }, title: 'Sintel', addedAt: 1, playedAt: 30, plays: 2, torrent: { ih: 'a'.repeat(40), file: 0 } },
    { source: { ...blob, hash: 'd'.repeat(64), title: 'Holiday' }, title: 'Holiday', addedAt: 2, playedAt: 20, plays: 1 },
    { source: { kind: 'url', url: 'https://example.org/clip.mp4' }, title: 'example.org · clip.mp4', addedAt: 3, playedAt: 10, plays: 1 },
  ];

  it('sorts files, torrents and links apart', () => {
    expect(lib.map(libraryKind)).toEqual(['torrents', 'files', 'links']);
  });

  it('joins this set\'s older PREVIOUSLY ON, newest first, without doubling an entry', () => {
    const history = [
      { source: { kind: 'youtube' as const, videoId: 'uPwPecwX2zs' }, title: 'Metropolis', playedAt: 25 },
      { source: { ...blob, title: 'Sintel' }, title: 'Sintel', playedAt: 5 },
    ];
    const all = libraryView(lib, history, 'all', '');
    expect(all.map((e) => e.title)).toEqual(['Sintel', 'Metropolis', 'Holiday', 'example.org · clip.mp4']);
    expect(all[0]!.plays).toBe(2); // the library's entry, not the history's
  });

  it('filters and searches', () => {
    expect(libraryView(lib, [], 'torrents', '').map((e) => e.title)).toEqual(['Sintel']);
    expect(libraryView(lib, [], 'files', '').map((e) => e.title)).toEqual(['Holiday']);
    expect(libraryView(lib, [], 'links', '').map((e) => e.title)).toEqual(['example.org · clip.mp4']);
    expect(libraryView(lib, [], 'all', '  HOLI ').map((e) => e.title)).toEqual(['Holiday']);
    expect(libraryView(lib, [], 'all', 'example.org')).toHaveLength(1);
    expect(libraryView(lib, [], 'files', 'sintel')).toEqual([]);
  });

  it('says how long ago', () => {
    const now = 10 * 86_400_000;
    expect(agoText(now - 5_000, now)).toBe('just now');
    expect(agoText(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(agoText(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(agoText(now - 2 * 86_400_000, now)).toBe('2 d ago');
    expect(agoText(now + 60_000, now)).toBe('just now'); // a peer's clock ahead
  });
});

describe('📚 where a library file plays from', () => {
  const ORIGIN = 'http://127.0.0.1:8080';
  const [ME, SHARER, HOST, FAR, HASH] = ['a', 'e', 'd', 'f', 'b'].map((c) => c.repeat(64));
  const entry: TvLibraryEntry = { source: { kind: 'blob', hash: HASH!, size: 9, provider: SHARER! }, title: 'Sintel', addedAt: 1, playedAt: 2, plays: 1 };
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetBlobLane();
  });

  /** This page's node says who is connected in the room, and WHERE who holds the file. */
  async function nodeSays(reachable: string[], holders: string[]): Promise<void> {
    forgetBlobLane();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/api/blob/where')
      ? { holders: { [HASH!]: holders } }
      : { held: [], reachable }), { status: 200 })));
    setNodeMediaOrigin(ORIGIN, tvNow(), tvWallNow());
    setBlobLaneRoom('room-1');
    setBlobLaneNode({ origin: ORIGIN, cap: 'c'.repeat(64), irohId: ME!, torrent: false });
    await refreshHeldBlobs(1_000);
    await refreshHolders([HASH!], 1_000);
  }

  it('its sharer here, a copy here, or a node met in the room lately that has it where it is online now', async () => {
    expect(whereabouts(entry)).toBe('unknown'); // the node has not said
    await nodeSays([SHARER!], []);
    expect(whereabouts(entry)).toBe('theirs');
    await nodeSays([HOST!], [FAR!, HOST!]);
    expect(whereabouts(entry)).toBe('copy'); // a node here before one elsewhere
    await nodeSays([], [ME!, SHARER!]);
    expect(whereabouts(entry)).toBe('elsewhere');
    await nodeSays([], [FAR!]);
    expect(whereabouts(entry)).toBe('elsewhere');
    await nodeSays([], []);
    expect(whereabouts(entry)).toBe('away');
  });
});
