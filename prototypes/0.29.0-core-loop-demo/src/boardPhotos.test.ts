/**
 * 📷📌 boardPhotos: a board note's photo, from the poster's film roll to the
 * viewer's screen (#315 PR 5). The blob lane is stood in for: these tests
 * are about the photo's own rules (headers before decoding, the budget,
 * the looks), not the node's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const lane = vi.hoisted(() => ({
  ready: true,
  nodeId: 'b'.repeat(64) as string | null,
  states: new Map<string, { state: string; why?: string; have?: number; size?: number }>(),
  holders: new Map<string, string[]>(),
  fetches: [] as { hash: string; size: number; provider: string; mime: string }[],
  refuse: null as string | null,
  imports: [] as File[],
  importAnswer: null as { hash: string; size: number } | { error: string } | null,
  rechecks: [] as string[],
}));

vi.mock('./blobLane', () => ({
  blobLaneReady: () => lane.ready,
  blobLaneNodeId: () => (lane.ready ? lane.nodeId : null),
  blobState: (hash: string) => lane.states.get(hash) ?? { state: 'unknown' },
  blobUrl: (hash: string) => (lane.ready ? `http://node.test/blob/${hash}` : null),
  fetchBlob: async (hash: string, size: number, provider: string, mime: string) => {
    lane.fetches.push({ hash, size, provider, mime });
    if (!lane.refuse) lane.states.set(hash, { state: 'queued', have: 0, size });
    return lane.refuse;
  },
  freshNodeHolders: (hash: string) => lane.holders.get(hash) ?? null,
  refreshHolders: async (hashes: string[]) => {
    for (const h of hashes) lane.holders.set(h, []);
  },
  importBlob: async (file: File) => {
    lane.imports.push(file);
    return lane.importAnswer ?? { error: 'no answer' };
  },
  recheckBlob: (hash: string) => {
    lane.rechecks.push(hash);
  },
}));

import type { BoardPhoto, BoardScreen } from './boardDoc';
import {
  MAX_PHOTO_PIXELS,
  PHOTO_AUTO_FETCH_MAX,
  imageSizeOf,
  lookBoardPhotos,
  photoAutoFetch,
  photoBytesOk,
  photoFromShot,
  photoLook,
  photoPicture,
  photoTrouble,
  pressFetch,
  resetBoardPhotosForTest,
  type Picture,
  type PictureMaker,
} from './boardPhotos';
import type { FilmShot } from './filmRoll';

/** A JPEG's first bytes: SOI, an APP0 segment, then a baseline frame. */
function jpegHeader(width: number, height: number, pad = 0): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(pad).fill(0)]);
}

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function webpHeader(chunk: 'VP8X' | 'VP8 ' | 'VP8L', width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  b.set([...chunk].map((c) => c.charCodeAt(0)), 12);
  const v = new DataView(b.buffer);
  if (chunk === 'VP8X') {
    const w = width - 1;
    const h = height - 1;
    b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
    b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  } else if (chunk === 'VP8 ') {
    v.setUint16(26, width, true);
    v.setUint16(28, height, true);
  } else {
    b[20] = 0x2f;
    v.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  }
  return b;
}

const HASH = 'a'.repeat(64);
const SHARER = 'c'.repeat(64);
const photo = (over: Partial<BoardPhoto> = {}): BoardPhoto => ({
  kind: 'blob', hash: HASH, size: 50_000, provider: SHARER, mime: 'image/jpeg', takenAt: 1_700_000_000_000, ...over,
});

/** Pictures "decoded" without a browser: each made one is counted. */
function fakeMaker(): PictureMaker & { made: number; dropped: number } {
  const m = {
    made: 0,
    dropped: 0,
    async make(bytes: Blob): Promise<Picture> {
      m.made++;
      return { url: `blob:fake/${m.made}`, img: { width: 512, height: 384, size: bytes.size } as unknown as Picture['img'] };
    },
    drop() {
      m.dropped++;
    },
  };
  return m;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  lane.ready = true;
  lane.nodeId = 'b'.repeat(64);
  lane.states.clear();
  lane.holders.clear();
  lane.fetches.length = 0;
  lane.refuse = null;
  lane.imports.length = 0;
  lane.importAnswer = null;
  lane.rechecks.length = 0;
  try { localStorage.clear(); } catch { /* none in this runner */ }
  resetBoardPhotosForTest(fakeMaker());
  vi.unstubAllGlobals();
});

describe('📷 a photo’s size, read from its header before any decode', () => {
  it('reads JPEG, PNG and WebP', () => {
    expect(imageSizeOf(jpegHeader(512, 384))).toEqual({ width: 512, height: 384 });
    expect(imageSizeOf(pngHeader(300, 200))).toEqual({ width: 300, height: 200 });
    expect(imageSizeOf(webpHeader('VP8X', 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSizeOf(webpHeader('VP8 ', 320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSizeOf(webpHeader('VP8L', 100, 50))).toEqual({ width: 100, height: 50 });
  });

  it('reads nothing it doesn’t know, nor a JPEG that ends before its frame', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(imageSizeOf(jpegHeader(512, 384).slice(0, 22))).toBeNull();
    expect(imageSizeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  it('takes a photo only at its declared size and a sane pixel count', () => {
    const shot = jpegHeader(512, 384, 100);
    expect(photoBytesOk(shot, { size: shot.length })).toBe(true);
    expect(photoBytesOk(shot, { size: shot.length + 1 })).toBe(false);
    // A small file that declares a huge picture is never decoded.
    const bomb = jpegHeader(30_000, 30_000, 100);
    expect(30_000 * 30_000).toBeGreaterThan(MAX_PHOTO_PIXELS);
    expect(photoBytesOk(bomb, { size: bomb.length })).toBe(false);
    expect(photoBytesOk(new Uint8Array(10), { size: 10 })).toBe(false);
  });
});

describe('📷 where a photo is for this viewer', () => {
  it('needs a node on this machine', () => {
    lane.ready = false;
    expect(photoLook(photo())).toBe('no-node');
    expect(lane.fetches).toHaveLength(0);
  });

  it('comes by itself under the cap, once WHERE has said who holds it', async () => {
    lane.states.set(HASH, { state: 'none' });
    // WHERE first: the ask names the room's holders beside the sharer.
    expect(photoLook(photo(), 0)).toBe('loading');
    expect(lane.fetches).toHaveLength(0);
    expect(photoLook(photo(), 1)).toBe('loading');
    expect(lane.fetches).toEqual([{ hash: HASH, size: 50_000, provider: SHARER, mime: 'image/jpeg' }]);
    await flush();
    // Asked once per page, and counted against the day.
    expect(photoLook(photo(), 2)).toBe('loading');
    expect(lane.fetches).toHaveLength(1);
    expect(photoAutoFetch.spent()).toBeGreaterThanOrEqual(50_000);
  });

  it('waits for FETCH when it is too big, the day is used, or the switch is off', () => {
    lane.states.set(HASH, { state: 'none' });
    lane.holders.set(HASH, []);
    expect(photoLook(photo({ size: PHOTO_AUTO_FETCH_MAX + 1 }))).toBe('fetch');
    photoAutoFetch.setOn(false);
    expect(photoLook(photo())).toBe('fetch');
    expect(lane.fetches).toHaveLength(0);
    photoAutoFetch.setOn(true);
    for (let i = 0; i < 600; i++) photoAutoFetch.note(`${i}`.padStart(64, '0'), 32 * 1024);
    expect(photoLook(photo())).toBe('fetch');
    expect(lane.fetches).toHaveLength(0);
  });

  it('says when the node refused, and FETCH asks again', async () => {
    lane.states.set(HASH, { state: 'none' });
    lane.holders.set(HASH, []);
    lane.refuse = 'not connected to anyone who has it';
    expect(photoLook(photo())).toBe('loading');
    await flush();
    expect(photoLook(photo())).toBe('unreachable');
    expect(photoTrouble(photo())).toBe('not connected to anyone who has it');
    lane.refuse = null;
    pressFetch(photo());
    await flush();
    expect(lane.fetches).toHaveLength(2);
    expect(photoLook(photo())).toBe('loading');
  });

  it('is read from the viewer’s own node once whole, then drawn', async () => {
    const bytes = jpegHeader(512, 384, 200);
    lane.states.set(HASH, { state: 'complete', have: bytes.length, size: bytes.length });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(bytes);
    });
    const p = photo({ size: bytes.length });
    expect(photoLook(p)).toBe('loading');
    await flush();
    await flush();
    expect(asked).toEqual([`http://node.test/blob/${HASH}`]);
    expect(photoLook(p)).toBe('ready');
    expect(photoPicture(HASH)?.url).toMatch(/^blob:fake\//);
  });

  it('won’t draw bytes that aren’t the photo the note names', async () => {
    const bytes = jpegHeader(512, 384, 200);
    lane.states.set(HASH, { state: 'complete' });
    vi.stubGlobal('fetch', async () => new Response(bytes));
    const p = photo({ size: bytes.length + 5 });
    photoLook(p, 0);
    await flush();
    await flush();
    expect(photoPicture(HASH)).toBeNull();
    expect(lane.rechecks).toContain(HASH);
    // Said, and not read again before the retry is due.
    expect(photoLook(p, 1)).toBe('unreachable');
  });

  it('adds each photo’s look to a board’s face', () => {
    lane.ready = false;
    const screen: BoardScreen = {
      kind: 'open',
      hiddenCount: 0,
      notes: [
        { id: '01', text: 'a', authorName: 'A', colour: 'yellow', x: 0.5, y: 0.5, unseen: false, photo: false },
        { id: '02', text: '', authorName: 'B', colour: 'yellow', x: 0.2, y: 0.2, unseen: true, photo: true, attach: photo() },
      ],
    };
    const looked = lookBoardPhotos(screen);
    expect(looked.notes[0].photoLook).toBeUndefined();
    expect(looked.notes[1].photoLook).toBe('no-node');
  });
});

describe('📷 pinning a shot from the film roll', () => {
  const shot = (bytes: Uint8Array<ArrayBuffer>, caption = ''): FilmShot => ({
    id: 'shot-1', ts: 1_700_000_000_000, roomId: 'r', roomName: 'Room', caption, width: 512, height: 384,
    jpeg: new Blob([bytes], { type: 'image/jpeg' }),
  });

  it('puts the shot on this player’s node and names it there', async () => {
    const bytes = jpegHeader(512, 384, 300);
    lane.importAnswer = { hash: HASH, size: bytes.length };
    const got = await photoFromShot(shot(bytes, 'The view'));
    expect(lane.imports).toHaveLength(1);
    expect(lane.imports[0].type).toBe('image/jpeg');
    expect(got).toEqual({
      photo: { kind: 'blob', hash: HASH, size: bytes.length, provider: 'b'.repeat(64), mime: 'image/jpeg', takenAt: 1_700_000_000_000, caption: 'The view' },
    });
    // The poster sees it at once, before any read back.
    expect(photoPicture(HASH)).not.toBeNull();
  });

  it('says why not: no node, an unreadable shot, or the node’s refusal', async () => {
    const bytes = jpegHeader(512, 384, 300);
    lane.ready = false;
    expect(await photoFromShot(shot(bytes))).toEqual({ error: expect.stringContaining('node') });
    lane.ready = true;
    expect(await photoFromShot(shot(new Uint8Array(40)))).toEqual({ error: 'That shot can’t be read.' });
    lane.importAnswer = { error: 'Your node: full.' };
    expect(await photoFromShot(shot(bytes))).toEqual({ error: 'Your node: full.' });
  });
});
