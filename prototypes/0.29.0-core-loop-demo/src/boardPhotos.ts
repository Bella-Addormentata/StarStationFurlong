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
  blobLaneRoom,
  blobState,
  blobUrl,
  fetchBlob,
  freshNodeHolders,
  importBlob,
  recheckBlob,
  refreshHolders,
  whereAskedAt,
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
/** How long an ask waits for WHERE to say which of the room's nodes hold
 *  the photo (the ask names them beside its provider, so the host's copy is
 *  found once the poster has left), counted from when a WHERE naming it
 *  went out. The lane sends one WHERE at a time and names at most 16 files
 *  in it, so a full board's photos go out in turns, and a wait counted from
 *  the first look would run out before the later turns (#340 review). The
 *  node gives WHERE 4 s, so this leaves room for asking again when an
 *  answer leaves a photo out; past it the ask goes to the provider alone
 *  (a node without WHERE). */
const WHERE_WAIT_MS = 10_000;
/** The longest an ask waits for WHERE however its turn goes (a WHERE that
 *  never comes back holds up the lane's next). */
const WHERE_MOST_MS = 60_000;
/** A picture that could not be read is tried again after this long. */
const LOAD_RETRY_MS = 15_000;
/** Decoded pictures kept in this page when some are no longer looked at:
 *  the ones looked at longest ago go first. */
const KEPT_PICTURES = 48;
/** Pictures looked at within this long are on a board in front of the
 *  player (the faces are looked at every second), and are never dropped
 *  for another: dropping one only to read it again next second would read
 *  and decode photos without end (#340 review). */
const IN_USE_MS = 10_000;
/** The most pictures a page holds, all in use: four boards of 24 notes.
 *  Past it a photo stays LOADING until one goes out of view, unless the
 *  open panel shows it: the panel's photos take the place of a face's. */
const MOST_PICTURES = 96;

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
/** hash → picture, when it was last looked at (the longest ago first), and
 *  when the open panel last showed it. */
const pictures = new Map<string, { pic: Picture; usedAt: number; panelAt: number }>();
/** The photos whose FETCH press waits for WHERE before it asks. */
const pressing = new Set<string>();
const loading = new Set<string>();
/** hash → when a read last failed (performance.now ms). */
const loadFailed = new Map<string, number>();
/** hash → why the node refused the last ask for it (by itself or pressed). */
const refusedWhy = new Map<string, string>();
/** hash → an ask by itself waiting for WHERE: the room it is for, when it
 *  began waiting, when a WHERE naming it went out (null while it waits its
 *  turn), and when it was last looked at. The oldest first, as WHERE takes
 *  them. */
const whereWaits = new Map<string, { room: string; since: number; sentAt: number | null; lookedAt: number }>();
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

/** Drop pictures nobody has looked at lately, the longest ago first, down
 *  to KEPT_PICTURES. Those in use stay, however many. */
function dropIdle(now: number): void {
  for (const [hash, e] of pictures) {
    if (pictures.size <= KEPT_PICTURES || now - e.usedAt < IN_USE_MS) break; // the rest were looked at later
    pictures.delete(hash);
    maker.drop(e.pic);
  }
}

function keep(hash: string, p: Picture, now: number, panel = false): void {
  const old = pictures.get(hash);
  if (old && old.pic !== p) maker.drop(old.pic);
  pictures.delete(hash);
  pictures.set(hash, { pic: p, usedAt: now, panelAt: panel ? now : -Infinity });
  dropIdle(now);
}

/** A look at a held picture: kept, as in use (and as the panel's, from it). */
function touch(hash: string, now: number, panel = false): boolean {
  const e = pictures.get(hash);
  if (!e) return false;
  e.usedAt = Math.max(e.usedAt, now);
  if (panel) e.panelAt = Math.max(e.panelAt, now);
  pictures.delete(hash);
  pictures.set(hash, e);
  return true;
}

/** Room for one of the open panel's photos when every picture held is in
 *  use: the one looked at longest ago that the panel isn't showing goes. A
 *  face that loses it waits, as for any photo past the most, and takes no
 *  room back from the panel. */
function dropForPanel(now: number): boolean {
  for (const [hash, e] of pictures) {
    if (now - e.panelAt < IN_USE_MS) continue;
    pictures.delete(hash);
    maker.drop(e.pic);
    return true;
  }
  return false;
}

/** The decoded picture for `hash`, when this page holds it (a use: it is
 *  kept longer). */
export function photoPicture(hash: string, now = performance.now()): Picture | null {
  return touch(hash, now) ? pictures.get(hash)!.pic : null;
}

/** At most `limit` bytes of a response, or null when it holds more: the
 *  read stops at the first chunk past the limit, so a note naming some big
 *  file this node holds under a photo's small size costs no more than the
 *  limit (#340 review). */
export async function readAtMost(res: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const out = new Uint8Array(limit);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > limit) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    out.set(value, n);
    n += value.length;
  }
  return out.slice(0, n);
}

/** Read a whole photo from this page's node and decode it, once at a time
 *  per photo. A read that fails is tried again after LOAD_RETRY_MS, the
 *  node asked again meanwhile whether it still holds the file. */
function loadPicture(photo: BoardPhoto, now: number, panel: boolean): void {
  const { hash } = photo;
  if (loading.has(hash) || pictures.has(hash) || now - (loadFailed.get(hash) ?? -Infinity) < LOAD_RETRY_MS) return;
  // Room for it first: none while every picture held is in use, unless the
  // open panel shows it and a face's can go.
  dropIdle(now);
  if (pictures.size + loading.size >= MOST_PICTURES && !(panel && dropForPanel(now))) return;
  const url = blobUrl(hash);
  if (!url) return;
  loading.add(hash);
  void (async () => {
    try {
      const res = await fetch(url, { redirect: 'error' });
      if (!res.ok) throw new Error(`node answered ${res.status}`);
      const bytes = await readAtMost(res, Math.min(photo.size, MAX_PHOTO_BYTES));
      if (!bytes || !photoBytesOk(bytes, photo)) throw new Error('not a photo this board shows');
      keep(hash, await maker.make(new Blob([bytes], { type: photo.mime }), photo.mime), now, panel);
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
  // WHERE first, whatever asks are out: it moves no file.
  if (freshNodeHolders(photo.hash, now) === null && !waitedForWhere(photo.hash, now)) return true;
  if (inFlight.size >= MAX_ASKING) return true;
  whereWaits.delete(photo.hash);
  photoAutoFetch.note(photo.hash, photo.size);
  ask(photo);
  return true;
}

/** Whether an ask by itself for `hash` has waited for WHERE as long as it
 *  may: WHERE_WAIT_MS from when a WHERE naming it went out, WHERE_MOST_MS
 *  at most. Asks WHERE meanwhile. */
function waitedForWhere(hash: string, now: number): boolean {
  const room = blobLaneRoom();
  let w = whereWaits.get(hash);
  if (!w || w.room !== room) {
    whereWaits.delete(hash);
    w = { room, since: now, sentAt: null, lookedAt: now };
    whereWaits.set(hash, w);
  }
  w.lookedAt = Math.max(w.lookedAt, now);
  void askWhere(now);
  return (w.sentAt !== null && now - w.sentAt >= WHERE_WAIT_MS) || now - w.since >= WHERE_MOST_MS;
}

/** One WHERE for every photo waiting in this room, `first` ahead: the node
 *  answers one at a time, and one asked alone would leave the others
 *  waiting longer. Notes which went out in it. Photos for another room, or
 *  not looked at lately (off the boards in view), stop waiting. */
function askWhere(now: number, first?: string): Promise<void> {
  const room = blobLaneRoom();
  for (const [hash, w] of whereWaits) if (w.room !== room || now - w.lookedAt >= IN_USE_MS) whereWaits.delete(hash);
  const waiting = [...whereWaits.keys()];
  const asking = refreshHolders(first ? [first, ...waiting] : waiting, now);
  // The lane notes what it sends before it waits for the node.
  for (const [hash, w] of whereWaits) w.sentAt ??= sentSince(hash, w.since);
  return asking;
}

/** When a WHERE naming `hash` went out at or after `since`, else null. */
function sentSince(hash: string, since: number): number | null {
  const at = whereAskedAt(hash);
  return at !== null && at >= since ? at : null;
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
 *  board's 1 Hz face push, and by its open panel with `panel` set: the
 *  panel's photos get room ahead of the faces' (#340 review). */
export function photoLook(photo: BoardPhoto, now = performance.now(), panel = false): PhotoLook {
  if (touch(photo.hash, now, panel)) return 'ready';
  if (!blobLaneReady()) return 'no-node';
  const st = blobState(photo.hash, now);
  switch (st.state) {
    case 'complete':
      // The node's file under this name isn't the size the note says: not
      // this photo, and not read.
      if (st.size !== photo.size) {
        refusedWhy.set(photo.hash, 'your node holds a different file under this photo’s name');
        return 'unreachable';
      }
      loadPicture(photo, now, panel);
      // A read that failed waits for its retry, and says so meanwhile.
      return loadFailed.has(photo.hash) && !loading.has(photo.hash) ? 'unreachable' : 'loading';
    case 'failed':
      return 'unreachable';
    case 'none':
      if (pressing.has(photo.hash) || inFlight.has(photo.hash)) return 'loading';
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
 *  from this provider. Asks no more by itself for it from this page. WHERE
 *  first, as for an ask by itself, so the ask names the room's nodes that
 *  hold it (the host's copy, once the poster has left), not the poster
 *  alone (#340 review). */
export async function pressFetch(photo: BoardPhoto): Promise<void> {
  photoAutoFetch.notePressed(photo.hash);
  loadFailed.delete(photo.hash);
  refusedWhy.delete(photo.hash);
  if (pressing.has(photo.hash) || inFlight.has(photo.hash)) return;
  // The press is for this room's board: a fetch sent after a room change
  // would be the next room's, and the node shares a fetched file with the
  // room it was asked for (#340 review).
  const room = blobLaneRoom();
  pressing.add(photo.hash);
  try {
    await holdersFor(photo.hash);
  } finally {
    pressing.delete(photo.hash);
  }
  if (blobLaneRoom() !== room) return;
  ask(photo);
}

/** Wait for a fresh WHERE on `hash`, as an ask by itself does: asked ahead
 *  of the others waiting, again while another ask is out, and for up to
 *  WHERE_WAIT_MS once one naming it has gone out. */
async function holdersFor(hash: string): Promise<void> {
  const since = performance.now();
  let sentAt: number | null = null;
  for (;;) {
    const now = performance.now();
    if (freshNodeHolders(hash, now) !== null) return;
    if ((sentAt !== null && now - sentAt >= WHERE_WAIT_MS) || now - since >= WHERE_MOST_MS) return;
    const asking = askWhere(now, hash);
    sentAt ??= sentSince(hash, since);
    await asking;
    if (freshNodeHolders(hash) !== null) return;
    await new Promise((r) => setTimeout(r, 250));
  }
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
  // The node shares an import with the room it is sent for: one sent after
  // a room change would go to the next room's members (#340 review).
  const room = blobLaneRoom();
  const bytes = new Uint8Array(await shot.jpeg.arrayBuffer());
  if (!photoBytesOk(bytes, { size: bytes.length })) return { error: 'That shot can’t be read.' };
  if (blobLaneRoom() !== room) return { error: 'You changed rooms while the photo was read. Pin it again here.' };
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
      keep(photo.hash, await maker.make(new Blob([bytes], { type: 'image/jpeg' }), 'image/jpeg'), performance.now());
    } catch { /* read back from the node like anyone's */ }
  }
  return { photo };
}

/** Tests: a fresh page, decoding with `m` (the browser's <img> by default). */
export function resetBoardPhotosForTest(m: PictureMaker | null = null): void {
  for (const e of pictures.values()) maker.drop(e.pic);
  pictures.clear();
  pressing.clear();
  loading.clear();
  loadFailed.clear();
  refusedWhy.clear();
  whereWaits.clear();
  inFlight.clear();
  photoAutoFetch.reset();
  maker = m ?? browserMaker;
}
