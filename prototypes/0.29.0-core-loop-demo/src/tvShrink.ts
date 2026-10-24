/**
 * 🗜 SHRINK — every film a player shares from a 🧲 TORRENT or a 📁 FILE is
 * made smaller on their own machine before the room sees it: TV_SHRINK_LINES
 * lines on the same timeline (tvShrinkWorker.ts), put in the node as a FILE
 * is, and that copy is what the set plays and every viewer's node fetches.
 * No press and nothing to choose: the remote says only that the film is
 * being got ready. Once the room plays the copy, the caller lets the
 * original go from this node (tvUI).
 *
 * A film plays as it is where there is nothing to gain or no way to: no
 * picture, a picture no taller than the copy's, a copy that came out no
 * smaller, or a browser that cannot re-encode (no WebCodecs, or none it
 * can use).
 *
 * One film at a time per page, while the page is open. A copy this machine
 * made is remembered in this browser (by node, room and original), so the
 * same film shared again in that room plays at once.
 */
import type { ShrinkAsk, ShrinkSay } from './tvShrinkWorker';
import { blobLaneGeneration, blobLaneNodeId, blobLaneRoom, blobStateNow, blobUrl, importBlob } from './blobLane';
import { sanitizeSource } from './tvDoc';
import type { TvBlobSource } from './tvDoc';

/** The height a copy is made at: the lines the TV's CRT look shows. One
 *  number to change if it wants a tweak. */
export const TV_SHRINK_LINES = 360;
/** What a copy is encoded at, in bits a second: about 550 MB for a two-hour film. */
export const TV_SHRINK_VIDEO_BITRATE = 520_000;
export const TV_SHRINK_AUDIO_BITRATE = 96_000;

/** What the room plays for a shared film, and what then leaves this node. */
export interface Ready {
  /** The copy, or the film as it is. */
  source: TvBlobSource;
  /** The original to let go once the room plays the copy; null when the film plays as it is. */
  drop: string | null;
}

/** This browser can re-encode video off the main thread into a file of its own. */
export function shrinkSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/** The film being got ready, by whoever asked last (the remote's progress line). */
interface Job {
  hash: string;
  room: string;
  /** The node it is made on (blobLaneGeneration): a node restarted or
   *  switched meanwhile holds neither the film nor its copy. */
  node: number;
  ready: Promise<Ready | null>;
  onProgress: (done: number) => void;
  stop: () => void;
}
let job: Job | null = null;

/** Get `original` (a film this page's node holds whole) ready for the room.
 *  Asked again for the same film while it is being made, the same answer
 *  comes; asked for another, the first is stopped. Null when it was stopped,
 *  or the room or node changed meanwhile: the share is void. */
export function readyForRoom(original: TvBlobSource, onProgress: (done: number) => void = () => undefined): Promise<Ready | null> {
  const room = blobLaneRoom();
  const node = blobLaneGeneration();
  if (job && job.hash === original.hash && job.room === room && job.node === node) {
    job.onProgress = onProgress;
    return job.ready;
  }
  job?.stop();
  let stopped = false;
  let stopWorker: () => void = () => undefined;
  const mine: Job = {
    hash: original.hash,
    room,
    node,
    onProgress,
    stop: () => {
      stopped = true;
      stopWorker();
    },
    ready: Promise.resolve(null),
  };
  // Void once stopped, or once the room or the node is another: the copy
  // would be offered from a node that never had it, under the wrong note.
  const voided = () => stopped || blobLaneRoom() !== room || blobLaneGeneration() !== node;
  mine.ready = make(original, room, (done) => mine.onProgress(done), voided, (stop) => { stopWorker = stop; })
    .finally(() => { if (job === mine) job = null; });
  job = mine;
  return mine.ready;
}

/** Stop the film being got ready (tests; a page that leaves). */
export function stopShrink(): void {
  job?.stop();
  job = null;
}

async function make(
  original: TvBlobSource,
  room: string,
  progress: (done: number) => void,
  voided: () => boolean,
  onStop: (stop: () => void) => void,
): Promise<Ready | null> {
  const asIs: Ready = { source: original, drop: null };
  const me = blobLaneNodeId();
  const url = blobUrl(original.hash);
  if (!me || !url) return null;
  if (original.mime && !original.mime.startsWith('video/')) return asIs;
  const before = await madeBefore(me, room, original);
  if (voided()) return null;
  if (before) return { source: before, drop: original.hash };
  if (!shrinkSupported()) return asIs;

  const file = `ssf-shrink-${original.hash.slice(0, 16)}.part`;
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
    await clearLeftovers(root);
  } catch {
    return asIs;
  }
  if (voided()) return null;
  const w = new Worker(new URL('./tvShrinkWorker.ts', import.meta.url), { type: 'module' });
  let said: Exclude<ShrinkSay, { kind: 'progress' }>;
  try {
    said = await new Promise((resolve) => {
      onStop(() => {
        w.terminate();
        resolve({ kind: 'failed', why: 'stopped' });
      });
      w.onmessage = (e: MessageEvent<ShrinkSay>) => {
        if (e.data.kind === 'progress') progress(0.95 * Math.max(0, Math.min(1, e.data.done)));
        else resolve(e.data);
      };
      w.onerror = (e) => resolve({ kind: 'failed', why: e.message || 'the encoder stopped' });
      w.postMessage({
        kind: 'start', url, file, lines: TV_SHRINK_LINES, videoBitrate: TV_SHRINK_VIDEO_BITRATE, audioBitrate: TV_SHRINK_AUDIO_BITRATE,
      } satisfies ShrinkAsk);
    });
  } finally {
    w.terminate();
  }
  try {
    if (voided()) return null;
    if (said.kind === 'asis') return asIs;
    if (said.kind === 'failed') {
      console.warn(`[tv] ${original.title ?? original.hash.slice(0, 8)} plays as it is: ${said.why}`);
      return asIs;
    }
    const made = await (await root.getFileHandle(file)).getFile();
    // Not whole, or nothing saved: the film plays as it is.
    if (made.size !== said.size || made.size === 0 || made.size >= original.size) return asIs;
    if (voided()) return null;
    const ext = said.mime === 'video/webm' ? 'webm' : 'mp4';
    const got = await importBlob(new File([made], `${original.title || 'film'} (${said.lines} lines).${ext}`, { type: said.mime }), (sent, total) => {
      progress(0.95 + 0.05 * (total > 0 ? sent / total : 0));
    });
    if (voided()) return null;
    if ('error' in got) {
      console.warn(`[tv] ${original.title ?? original.hash.slice(0, 8)} plays as it is: ${got.error}`);
      return asIs;
    }
    const copy = copyOf(original, { hash: got.hash, size: got.size, mime: said.mime }, me);
    if (!copy) return asIs;
    remember(me, room, original.hash, copy);
    return { source: copy, drop: original.hash };
  } finally {
    await root.removeEntry(file).catch(() => undefined);
  }
}

/** The copy as the room's record names it: this node's file, the
 *  original's title, and the original it `was`. */
export function copyOf(original: TvBlobSource, made: { hash: string; size: number; mime: string }, provider: string): TvBlobSource | null {
  const source = sanitizeSource({
    kind: 'blob', hash: made.hash, size: made.size, provider, mime: made.mime, title: original.title,
    was: { hash: original.hash, size: original.size },
  });
  return source?.kind === 'blob' && source.was ? source : null;
}

/** A copy a page that left mid-way never cleared up. One film at a time:
 *  every one there now is a leftover. */
async function clearLeftovers(root: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (/^ssf-shrink-[0-9a-f]{16}\.part$/.test(name)) names.push(name);
  }
  for (const name of names) await root.removeEntry(name).catch(() => undefined);
}

// ── Copies this machine made ─────────────────────────────────────────────────
// This browser's own notes, never a peer's: a copy in the room's library
// that says it `was` some film is only a peer's word, and a share of that
// film plays what its sharer's own machine made.

const MEMO_KEY = 'ssf-tv-shrunk';
const MEMO_MAX = 200;
interface Made { hash: string; size: number; mime: string; at: number }

function readMemo(): Record<string, Made> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MEMO_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, Made> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = v as Partial<Made> | null;
      if (m && typeof m.hash === 'string' && /^[0-9a-f]{64}$/.test(m.hash) && Number.isSafeInteger(m.size) && (m.size as number) > 0
        && typeof m.mime === 'string' && typeof m.at === 'number') out[k] = m as Made;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMemo(memo: Record<string, Made>): void {
  const kept = Object.entries(memo).sort((a, b) => b[1].at - a[1].at).slice(0, MEMO_MAX);
  try {
    localStorage.setItem(MEMO_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* this session only */ }
}

function remember(node: string, room: string, original: string, copy: TvBlobSource): void {
  const memo = readMemo();
  memo[`${node}:${room}:${original}`] = { hash: copy.hash, size: copy.size, mime: copy.mime ?? '', at: Date.now() };
  writeMemo(memo);
}

/** The copy of `original` this machine made for `room`, while its node
 *  still holds it whole; else null (and the note goes). */
export async function madeBefore(node: string, room: string, original: TvBlobSource): Promise<TvBlobSource | null> {
  const memo = readMemo();
  const key = `${node}:${room}:${original.hash}`;
  const made = memo[key];
  if (!made) return null;
  const copy = copyOf(original, made, node);
  const held = copy ? (await blobStateNow(made.hash)).state : 'none';
  if (held === 'complete') return copy;
  // Gone from the node (let go, or to make room): made again. A node that
  // did not answer keeps the note for next time.
  if (held !== 'unknown') {
    delete memo[key];
    writeMemo(memo);
  }
  return null;
}
