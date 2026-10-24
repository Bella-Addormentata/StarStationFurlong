/**
 * 🗜 tvShrink — what the room plays for a film shared from this node: the
 * copy this machine made of it, or the film as it is where there is nothing
 * to gain or no way to make one. The re-encode itself needs a browser's
 * WebCodecs (tried by hand in Chromium); these are the choices around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TvBlobSource } from './tvDoc';

const lane = vi.hoisted(() => ({ state: 'complete' as string, asked: [] as string[], gen: 1, restartOnAsk: false }));
vi.mock('./blobLane', () => ({
  blobLaneNodeId: () => 'a'.repeat(64),
  blobLaneRoom: () => 'room-1',
  blobLaneGeneration: () => lane.gen,
  blobUrl: (hash: string) => `http://127.0.0.1:1/blob/${hash}`,
  importBlob: async () => ({ error: 'not in tests' }),
  blobStateNow: async (hash: string) => {
    lane.asked.push(hash);
    if (lane.restartOnAsk) lane.gen++; // the node restarts while it is asked
    return { state: lane.state, have: 1, size: 1 };
  },
}));

import { copyOf, readyForRoom, stopShrink, TV_SHRINK_LINES } from './tvShrink';

const ME = 'a'.repeat(64);
const FILM: TvBlobSource = { kind: 'blob', hash: 'b'.repeat(64), size: 2_000_000_000, provider: ME, mime: 'video/mp4', title: 'Sintel' };
const COPY = 'c'.repeat(64);
const MEMO = 'ssf-tv-shrunk';

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  lane.state = 'complete';
  lane.asked = [];
  lane.restartOnAsk = false;
});
afterEach(() => {
  stopShrink();
  vi.unstubAllGlobals();
});

const madeHere = (room = 'room-1', node = ME) => store.set(MEMO, JSON.stringify({
  [`${node}:${room}:${FILM.hash}`]: { hash: COPY, size: 500_000_000, mime: 'video/mp4', at: 1 },
}));

describe('🗜 a film shared from this node', () => {
  it('is made at the lines the CRT look shows', () => {
    expect(TV_SHRINK_LINES).toBe(360);
  });

  it('plays as it is when it has no picture to make smaller, or the browser cannot re-encode', async () => {
    expect(await readyForRoom({ ...FILM, mime: 'audio/mpeg' })).toEqual({ source: { ...FILM, mime: 'audio/mpeg' }, drop: null });
    // No WebCodecs here (as in a webview without them): as it is.
    expect(await readyForRoom(FILM)).toEqual({ source: FILM, drop: null });
  });

  it('plays the copy this machine made of it before, while the node holds that, and lets the original go', async () => {
    madeHere();
    const ready = await readyForRoom(FILM);
    expect(ready).toEqual({
      source: { kind: 'blob', hash: COPY, size: 500_000_000, provider: ME, mime: 'video/mp4', title: 'Sintel', was: { hash: FILM.hash, size: FILM.size } },
      drop: FILM.hash,
    });
    expect(lane.asked).toEqual([COPY]);
  });

  it('makes it again when the node let the copy go, and keeps the note when the node did not answer', async () => {
    madeHere();
    lane.state = 'unknown';
    expect((await readyForRoom(FILM))?.drop).toBeNull();
    expect(store.get(MEMO)).toContain(COPY);
    lane.state = 'none';
    expect((await readyForRoom(FILM))?.drop).toBeNull();
    expect(store.get(MEMO)).not.toContain(COPY);
  });

  it('takes no copy made for another room or by another node', async () => {
    madeHere('room-2');
    expect(await readyForRoom(FILM)).toEqual({ source: FILM, drop: null });
    madeHere('room-1', 'd'.repeat(64));
    expect(await readyForRoom(FILM)).toEqual({ source: FILM, drop: null });
    expect(lane.asked).toEqual([]);
  });

  it('reads a broken note as none', async () => {
    store.set(MEMO, '{not json');
    expect(await readyForRoom(FILM)).toEqual({ source: FILM, drop: null });
    store.set(MEMO, JSON.stringify({ [`${ME}:room-1:${FILM.hash}`]: { hash: 'nope', size: 5, mime: 'video/mp4', at: 1 } }));
    expect(await readyForRoom(FILM)).toEqual({ source: FILM, drop: null });
  });

  it('asked twice for the same film while it is being got ready, gives one answer', () => {
    madeHere();
    expect(readyForRoom(FILM)).toBe(readyForRoom(FILM));
  });

  it('is void when the node restarts or changes while it is got ready, and asked again then, starts over', async () => {
    madeHere();
    lane.restartOnAsk = true;
    const first = readyForRoom(FILM);
    expect(await first).toBeNull(); // never offered from a node that may not hold it
    lane.restartOnAsk = false;
    const again = readyForRoom(FILM);
    expect(again).not.toBe(first);
    expect((await again)?.drop).toBe(FILM.hash);
    // A job still running when the node changes is not joined either.
    stopShrink();
    const running = readyForRoom(FILM);
    lane.gen++;
    expect(readyForRoom(FILM)).not.toBe(running);
  });
});

describe('🗜 the copy as the room names it', () => {
  it('is this node\'s file, under the original\'s title, naming the original it was', () => {
    expect(copyOf(FILM, { hash: COPY, size: 5, mime: 'video/webm' }, 'e'.repeat(64))).toEqual({
      kind: 'blob', hash: COPY, size: 5, provider: 'e'.repeat(64), mime: 'video/webm', title: 'Sintel', was: { hash: FILM.hash, size: FILM.size },
    });
    // The original itself is no copy of it.
    expect(copyOf(FILM, { hash: FILM.hash, size: 5, mime: 'video/mp4' }, ME)).toBeNull();
  });
});
