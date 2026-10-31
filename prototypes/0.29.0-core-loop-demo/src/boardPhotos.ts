/**
 * 📷📌 Photos on room-board notes (#315's fifth PR, issue 319's shots): the
 * viewer's half. A note's `attach` names a JPEG on the poster's node by its
 * BLAKE3 hash (the TV's blob reference, boardDoc.BoardPhoto); the bytes never
 * enter the room doc. This module gets the picture to the viewer's screen:
 *
 * - **Posting** (photoFromShot): a shot from the player's own film roll
 *   (filmRoll.ts) goes to their own node with the blob lane's IMPORT, as the
 *   TV's FILE does, and the note names that node as its provider. The
 *   room's members' nodes may then take it from there (blob_lane.rs serves a
 *   file to the connected members of the room it was imported for).
 * - **Fetching by itself** (photoAutoFetch): the TV's AUTO-FETCH budget
 *   (tvAutoFetch.makeAutoFetch) with photo-sized numbers — a cap per photo,
 *   a daily budget, the viewer's own switch on the board panel, each photo
 *   asked for at most once per page. A bigger photo, one past the day's
 *   budget, or any with the switch off waits for the panel's FETCH press.
 *   The node's own gates hold as for a press: it dials only the room's
 *   nodes (connected, or met there lately), and checks every byte against
 *   the hash.
 * - **Drawing**: once the viewer's node holds the photo whole, the page
 *   reads it from that node (`GET /blob/<hash>`), checks its size and its
 *   pixel count before decoding it, and keeps a few dozen decoded pictures
 *   for the board's face (boardFace.ts) and panel (boardUI.ts).
 *
 * Until then a photo's look (PhotoLook) says why it isn't drawn: on its way,
 * waiting for a press, not reachable, or no node on this machine at all.
 */

import {
  blobLaneNodeId,
  blobLaneReady,
  blobState,
  blobUrl,
  fetchBlob,
  freshNodeHolders,
  importBlob,
  recheckBlob,
  refreshHolders,
} from './blobLane';
import { MAX_PHOTO_BYTES, photoFromWire, type BoardPhoto, type BoardScreen, type PhotoLook } from './boardDoc';
import { cleanCaption, type FilmShot } from './filmRoll';
import { makeAutoFetch } from './tvAutoFetch';

/** The biggest photo a viewer's node takes without a press (a CAMERA shot
 *  is 40 to 60 KB). */
export const PHOTO_AUTO_FETCH_MAX = 256 * 1024;
/** What photos may take by themselves in a day, from this browser. */
export const PHOTO_AUTO_FETCH_DAY = 16 * 2 ** 20;
/** The least one ask counts against the day: 512 asks a day at most. */
export const PHOTO_AUTO_FETCH_MIN_CHARGE = 32 * 1024;

export const photoAutoFetch = makeAutoFetch({
  max: PHOTO_AUTO_FETCH_MAX,
  day: PHOTO_AUTO_FETCH_DAY,
  minCharge: PHOTO_AUTO_FETCH_MIN_CHARGE,
  switchKey: 'ssf-board-photo-auto-fetch',
  spentKey: 'ssf-board-photo-auto-fetch-spent',
});

/** The most pixels a photo may decode to (a shot is at most 512 × 512): a
 *  small file can declare a huge picture, and decoding one takes memory by
 *  its pixels, not its bytes. */
export const MAX_PHOTO_PIXELS = 4_000_000;
/** Asks out to the node at once by themselves (it runs two transfers and
 *  queues the rest). */
const MAX_ASKING = 4;
/** How long an ask by itself waits for WHERE to say which of the room's
 *  nodes hold the photo (the ask names them beside its provider). */
const WHERE_WAIT_MS = 3_000;
/** A picture that could not be read is tried again after this long. */
const LOAD_RETRY_MS = 15_000;
/** Decoded pictures kept in this page, the ones drawn longest ago go first:
 *  four boards of 24 notes would be 96. */
const KEPT_PICTURES = 48;

export interface Picture {
  /** An object URL of the bytes, for the panel's <img>. */
  url: string;
  /** The decoded picture, for the face's canvas. */
  img: CanvasImageSource & { width: number; height: number };
}

/** What a page decodes a picture with: an <img> on an object URL in the game;
 *  tests hand in their own. */
export interface PictureMaker {
  make(bytes: Blob, mime: string): Promise<Picture>;
  drop(p: Picture): void;
}

const browserMaker: PictureMaker = {
  async make(bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { url, img };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  },
  drop(p) {
    URL.revokeObjectURL(p.url);
  },
};

let maker: PictureMaker = browserMaker;
/** hash → picture, the most recently used last. */
const pictures = new Map<string, Picture>();
const loading = new Set<string>();
/** hash → when a read last failed (performance.now ms). */
const loadFailed = new Map<string, number>();
/** hash → why the node refused the last ask for it (by itself or pressed). */
const refusedWhy = new Map<string, string>();
/** hash → when an ask by itself began waiting for WHERE. */
const whereSince = new Map<string, number>();
/** The photos asked for whose answer from the node is still on its way. */
const inFlight = new Set<string>();

// ── Sizes, read from the bytes before any decode ────────────────────────────

/** A picture's width and height from its header (JPEG, PNG or WebP), or
 *  null when the bytes aren't one this can read. */
export function imageSizeOf(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  // PNG: the signature, then IHDR's width and height.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && u32(12) === 0x49484452) {
    return { width: u32(16), height: u32(20) };
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null; // the end, or the picture, before any frame
      const len = u16(i + 2);
      if (len < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return i + 9 <= b.length ? { width: u16(i + 7), height: u16(i + 5) } : null;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP, then its one chunk says the size.
  if (b.length >= 30 && u32(0) === 0x52494646 && u32(8) === 0x57454250) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 };
    if (chunk === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** May these bytes be decoded as this photo: its declared size, a header
 *  this reads, and no more than MAX_PHOTO_PIXELS. */
export function photoBytesOk(bytes: Uint8Array, photo: Pick<BoardPhoto, 'size'>): boolean {
  if (bytes.length !== photo.size || bytes.length > MAX_PHOTO_BYTES) return false;
  const dims = imageSizeOf(bytes);
  return !!dims && dims.width > 0 && dims.height > 0 && dims.width * dims.height <= MAX_PHOTO_PIXELS;
}

// ── The pictures this page keeps ────────────────────────────────────────────

function keep(hash: string, p: Picture): void {
  const old = pictures.get(hash);
  if (old && old !== p) maker.drop(old);
  pictures.delete(hash);
  pictures.set(hash, p);
  while (pictures.size > KEPT_PICTURES) {
    const [first, pic] = pictures.entries().next().value as [string, Picture];
    pictures.delete(first);
    maker.drop(pic);
  }
}

/** The decoded picture for `hash`, when this page holds it (a use: it is
 *  kept longer). */
export function photoPicture(hash: string): Picture | null {
  const p = pictures.get(hash);
  if (!p) return null;
  pictures.delete(hash);
  pictures.set(hash, p);
  return p;
}

/** Read a whole photo from this page's node and decode it, once at a time
 *  per photo. A read that fails is tried again after LOAD_RETRY_MS, the
 *  node asked again meanwhile whether it still holds the file. */
function loadPicture(photo: BoardPhoto, now: number): void {
  const { hash } = photo;
  if (loading.has(hash) || pictures.has(hash) || now - (loadFailed.get(hash) ?? -Infinity) < LOAD_RETRY_MS) return;
  const url = blobUrl(hash);
  if (!url) return;
  loading.add(hash);
  void (async () => {
    try {
      const res = await fetch(url, { redirect: 'error' });
      if (!res.ok) throw new Error(`node answered ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!photoBytesOk(bytes, photo)) throw new Error('not a photo this board shows');
      keep(hash, await maker.make(new Blob([bytes], { type: photo.mime }), photo.mime));
      loadFailed.delete(hash);
    } catch {
      loadFailed.set(hash, now);
      recheckBlob(hash);
    } finally {
      loading.delete(hash);
    }
  })();
}

// ── Where a photo is, and the asks by itself ────────────────────────────────

/** Ask this viewer's node for a photo without a press, if the budget says
 *  it may. True when an ask is out or waiting its turn (the photo is on its
 *  way), false when it waits for a press. */
function askByItself(photo: BoardPhoto, now: number): boolean {
  const verdict = photoAutoFetch.verdict(photo.hash, photo.size);
  // Asked for already: on its way while the node's answer is, else the
  // node has let it go since, and it is the press's to ask again.
  if (verdict === 'asked') return inFlight.has(photo.hash);
  if (verdict !== 'go') return false;
  if (inFlight.size >= MAX_ASKING) return true;
  if (freshNodeHolders(photo.hash, now) === null) {
    void refreshHolders([photo.hash], now);
    const since = whereSince.get(photo.hash) ?? now;
    whereSince.set(photo.hash, since);
    if (now - since < WHERE_WAIT_MS) return true;
  }
  whereSince.delete(photo.hash);
  photoAutoFetch.note(photo.hash, photo.size);
  ask(photo);
  return true;
}

function ask(photo: BoardPhoto): void {
  if (inFlight.has(photo.hash)) return;
  inFlight.add(photo.hash);
  refusedWhy.delete(photo.hash);
  void fetchBlob(photo.hash, photo.size, photo.provider, photo.mime)
    .then((refused) => {
      if (refused) {
        refusedWhy.set(photo.hash, refused);
        recheckBlob(photo.hash);
      }
    })
    .finally(() => { inFlight.delete(photo.hash); });
}

/** Where `photo` is for this viewer now, moving it along: an ask by itself
 *  when the budget allows, and a read once the node holds it. Called by the
 *  board's 1 Hz face push and by its open panel. */
export function photoLook(photo: BoardPhoto, now = performance.now()): PhotoLook {
  if (pictures.has(photo.hash)) return 'ready';
  if (!blobLaneReady()) return 'no-node';
  const st = blobState(photo.hash, now);
  switch (st.state) {
    case 'complete':
      loadPicture(photo, now);
      // A read that failed waits for its retry, and says so meanwhile.
      return loadFailed.has(photo.hash) && !loading.has(photo.hash) ? 'unreachable' : 'loading';
    case 'failed':
      return 'unreachable';
    case 'none':
      if (refusedWhy.has(photo.hash)) return 'unreachable';
      return askByItself(photo, now) ? 'loading' : 'fetch';
    default:
      return 'loading';
  }
}

/** Why the last ask for this photo was refused or failed, for the panel. */
export function photoTrouble(photo: BoardPhoto, now = performance.now()): string {
  const st = blobLaneReady() ? blobState(photo.hash, now) : null;
  if (st?.state === 'failed') return st.why || 'the last try stopped';
  return refusedWhy.get(photo.hash) ?? (loadFailed.has(photo.hash) ? 'your node could not hand it over' : '');
}

/** The panel's FETCH: this press is the consent, for this photo at this size
 *  from this provider. Asks no more by itself for it from this page. */
export function pressFetch(photo: BoardPhoto): void {
  photoAutoFetch.notePressed(photo.hash);
  loadFailed.delete(photo.hash);
  ask(photo);
}

/** A board's face with each photo's look added, moving each photo along. */
export function lookBoardPhotos(screen: BoardScreen, now = performance.now()): BoardScreen {
  if (!screen.notes.some((n) => n.attach)) return screen;
  return { ...screen, notes: screen.notes.map((n) => (n.attach ? { ...n, photoLook: photoLook(n.attach, now) } : n)) };
}

// ── Posting a shot from the film roll ────────────────────────────────────────

/** Put a film-roll shot on this player's node and answer the note's photo
 *  reference, or why it can't be pinned. The picture is kept in this page at
 *  once, so the poster sees it on the board before any read. */
export async function photoFromShot(shot: FilmShot): Promise<{ photo: BoardPhoto } | { error: string }> {
  if (!blobLaneReady()) return { error: 'Pinning a photo needs this station’s node (the desktop app) running here.' };
  if (shot.jpeg.size === 0 || shot.jpeg.size > MAX_PHOTO_BYTES) return { error: 'That shot is too big to pin.' };
  const bytes = new Uint8Array(await shot.jpeg.arrayBuffer());
  if (!photoBytesOk(bytes, { size: bytes.length })) return { error: 'That shot can’t be read.' };
  const file = new File([bytes], `ssf-shot-${shot.id}.jpg`, { type: 'image/jpeg' });
  const got = await importBlob(file);
  if ('error' in got) return got;
  const provider = blobLaneNodeId();
  if (!provider) return { error: 'Your node went away while it took the photo. Try again.' };
  const caption = cleanCaption(shot.caption);
  const photo = photoFromWire({
    kind: 'blob',
    hash: got.hash,
    size: got.size,
    provider,
    mime: 'image/jpeg',
    takenAt: shot.ts,
    ...(caption ? { caption } : {}),
  });
  if (!photo) return { error: 'That shot can’t be pinned.' };
  if (!pictures.has(photo.hash)) {
    try {
      keep(photo.hash, await maker.make(new Blob([bytes], { type: 'image/jpeg' }), 'image/jpeg'));
    } catch { /* read back from the node like anyone's */ }
  }
  return { photo };
}

/** Tests: a fresh page, decoding with `m` (the browser's <img> by default). */
export function resetBoardPhotosForTest(m: PictureMaker | null = null): void {
  for (const p of pictures.values()) maker.drop(p);
  pictures.clear();
  loading.clear();
  loadFailed.clear();
  refusedWhy.clear();
  whereSince.clear();
  inFlight.clear();
  photoAutoFetch.reset();
  maker = m ?? browserMaker;
}
