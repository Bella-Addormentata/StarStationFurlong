/**
 * 🧲 torrentLane — the page's half of the media lane's step 4 (plan §6,
 * brainstorming/smart-tv-arcade-media-plan.md; the node's half is
 * ssf-p2p-node/src/torrent_lane.rs, built with `--features torrent`).
 *
 * The remote's holder pastes a magnet or chooses a .torrent file; THEIR
 * node reads the torrent's file list (from the swarm for a magnet: no
 * trackers, a client-only DHT, public peers only) and shows it: nothing
 * downloads until the holder picks a file and presses ⬇ DOWNLOAD. The file
 * then goes into the blob lane (blobLane.ts), and when it is whole the
 * remote plays it as an ordinary `{ kind: 'blob' }` source, so viewers press
 * FETCH and take it from the holder's node: nobody else joins the swarm.
 * The programme names only the blob; the room's library (tvDoc) keeps the
 * torrent's info hash and file number beside it, for 🧲 GET AGAIN.
 *
 * Only this page starts a torrent, on the holder's START or GET AGAIN press:
 * the routes sit behind the blob lane's gate (an allowed Origin and this
 * launch's token).
 */

import { blobLaneGeneration, blobLaneNodeId, blobLaneRoom, nodeRoute, torrentLaneReady } from './blobLane';
import type { TvSource, TvTorrentOrigin } from './tvDoc';
import { sanitizeSource, TV_MAX_TITLE } from './tvDoc';

/** One playable file of the torrent, as the node listed it. `fits`: this
 *  node's cap and quota would take it. */
export interface TorrentFile {
  index: number;
  name: string;
  size: number;
  fits: boolean;
}

export type TorrentState =
  | { state: 'none' }
  | {
      /** `ready`: the file list is here, and nothing downloads until the
       *  holder confirms a file of it (confirmTorrent). */
      state: 'metadata' | 'ready' | 'downloading' | 'importing' | 'complete' | 'failed' | 'stopped';
      id: string;
      name: string;
      have: number;
      size: number;
      peers: number;
      uploaded: number;
      why: string;
      /** The room the node holds the file for: the only room PLAY may name it in. */
      room: string;
      /** Set once complete: the blob the file became, and its type. */
      hash: string | null;
      mime: string | null;
      /** The playable files (from `ready` on), and the one offered or chosen. */
      files: TorrentFile[];
      pick: number | null;
    }
  | { state: 'unknown' };

/** The most files the remote lists (the node lists at most 200). */
const MAX_FILES = 200;
/** The largest .torrent the node reads. */
export const MAX_TORRENT_FILE = 4 * 1024 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;

let last: TorrentState = { state: 'unknown' };
let lastGen = -1;
/** Moves at every START and STOP: a status asked before one describes what
 *  it changed, and is dropped on arrival. */
let epoch = 0;
/** Orders status answers: an older request's answer never lands over a
 *  newer one's. */
let asked = 0;
let landed = 0;

export function parseTorrentState(body: unknown): TorrentState {
  if (!body || typeof body !== 'object') return { state: 'unknown' };
  const r = body as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  if (r.state === 'none') return { state: 'none' };
  switch (r.state) {
    case 'metadata': case 'ready': case 'downloading': case 'importing': case 'complete': case 'failed': case 'stopped': {
      const hash = typeof r.hash === 'string' && HEX_64.test(r.hash) ? r.hash : null;
      if (r.state === 'complete' && !hash) return { state: 'unknown' };
      const index = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
      const files: TorrentFile[] = [];
      for (const f of Array.isArray(r.files) ? r.files.slice(0, MAX_FILES) : []) {
        const e = f && typeof f === 'object' ? (f as Record<string, unknown>) : null;
        const i = e ? index(e.index) : null;
        if (e && i !== null && !files.some((x) => x.index === i)) files.push({ index: i, name: str(e.name, 120), size: n(e.size), fits: e.fits !== false });
      }
      const pick = index(r.pick);
      return {
        state: r.state,
        id: typeof r.id === 'string' && HEX_40.test(r.id) ? r.id : '',
        name: str(r.name, 120),
        have: n(r.have),
        size: n(r.size),
        peers: n(r.peers),
        uploaded: n(r.uploaded),
        why: str(r.why, 300),
        room: str(r.room, 256),
        hash,
        mime: typeof r.mime === 'string' ? r.mime.slice(0, 80) : null,
        files,
        pick: pick !== null && (files.length === 0 || files.some((f) => f.index === pick)) ? pick : null,
      };
    }
    default: return { state: 'unknown' };
  }
}

/** What this page's node last said: 'unknown' before it answered, or once
 *  it restarted. */
export function torrentState(): TorrentState {
  if (lastGen !== blobLaneGeneration()) last = { state: 'unknown' };
  return last;
}

/** Ask the node now. Resolves the new state (also kept for torrentState). */
export async function refreshTorrentState(): Promise<TorrentState> {
  const url = nodeRoute('/api/torrent/status', {});
  const gen = blobLaneGeneration();
  const at = epoch;
  const n = ++asked;
  if (!url) return torrentState();
  try {
    const res = await fetch(url, { redirect: 'error' });
    const st = parseTorrentState(res.ok ? await res.json() : null);
    if (gen !== blobLaneGeneration() || at !== epoch || n < landed) return torrentState();
    last = st;
    lastGen = gen;
    landed = n;
    return st;
  } catch {
    return torrentState();
  }
}

async function post(path: string, params: Record<string, string>, body?: string | Blob): Promise<string | null> {
  const url = nodeRoute(path, params);
  if (!url) return 'The TORRENT tile needs this station\'s node, built with torrents, running here.';
  try {
    // text/plain: a simple request, so no preflight; the node checks the
    // Origin (a .torrent's bytes go the same way, named by `kind`).
    const res = await fetch(url, { method: 'POST', redirect: 'error', body, headers: body === undefined ? undefined : { 'Content-Type': 'text/plain' } });
    if (res.ok) return null;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === 'string' && b.error) return `Your node: ${b.error}.`;
    } catch { /* not JSON */ }
    return 'Your node did not take that.';
  } catch {
    return 'Your node did not answer.';
  }
}

/** START: hand the pasted magnet to this page's node. Null when it took it.
 *  `file` is the file the list offers first (a library entry's). */
export async function startTorrent(magnet: string, file?: number): Promise<string | null> {
  const text = magnet.trim();
  if (!text.startsWith('magnet:?')) return 'Paste a magnet link (it starts with magnet:?), or choose a .torrent file.';
  return add(text, file === undefined ? {} : { file: String(file) });
}

/** START with a chosen .torrent file: its bytes go to the node, which keeps
 *  only its `info` (no tracker, web seed or comment reaches the client). */
export async function startTorrentFile(file: Blob): Promise<string | null> {
  if (file.size === 0) return 'That .torrent file is empty.';
  if (file.size > MAX_TORRENT_FILE) return 'That is too big for a .torrent file (over 4 MB).';
  return add(file, { kind: 'torrent' });
}

/** 🧲 GET AGAIN: the torrent a library entry came from, by its info hash
 *  alone, with the file played before offered first. The node shows the
 *  torrent's own file list again before anything downloads. */
export function startTorrentAgain(origin: TvTorrentOrigin): Promise<string | null> {
  if (!HEX_40.test(origin.ih)) return Promise.resolve('That library entry does not say which torrent it came from.');
  return startTorrent(`magnet:?xt=urn:btih:${origin.ih}`, origin.file);
}

async function add(body: string | Blob, params: Record<string, string>): Promise<string | null> {
  if (!torrentLaneReady()) return 'The TORRENT tile needs this station\'s node, built with torrents, running here.';
  const why = await post('/api/torrent/add', { room: blobLaneRoom(), ...params }, body);
  if (!why) {
    // The finished file the remote held is no longer the node's answer:
    // nothing is playable until the node says so of the new torrent.
    epoch++;
    last = { state: 'unknown' };
    void refreshTorrentState();
  }
  return why;
}

/** ⬇ DOWNLOAD: the holder's pick from the list. Null when the node took it. */
export async function confirmTorrent(file: number): Promise<string | null> {
  if (!Number.isSafeInteger(file) || file < 0) return 'Pick a file first.';
  const why = await post('/api/torrent/confirm', { file: String(file) });
  if (!why) void refreshTorrentState();
  return why;
}

export async function stopTorrent(): Promise<string | null> {
  const why = await post('/api/torrent/stop', {});
  epoch++;
  last = { state: 'unknown' };
  void refreshTorrentState();
  return why;
}

/** Where the finished torrent's file came from, for the library's GET
 *  AGAIN. Null until it is complete. */
export function torrentOrigin(st: TorrentState = torrentState()): TvTorrentOrigin | null {
  if (st.state !== 'complete' || !HEX_40.test(st.id) || st.pick === null) return null;
  return { ih: st.id, file: st.pick };
}

/** The torrent is somewhere between START and its file in the blob lane:
 *  STOP is what the remote offers. */
export function torrentRunning(st: TorrentState = torrentState()): boolean {
  return st.state === 'metadata' || st.state === 'ready' || st.state === 'downloading' || st.state === 'importing';
}

/** The finished torrent as the TV's source: the blob it became, provided by
 *  this page's node. Null until it is complete. */
export function torrentSource(st: TorrentState = torrentState()): TvSource | null {
  const provider = blobLaneNodeId();
  // The node serves the blob only to members of the room it was fetched
  // for: in another room the viewers' FETCH would be refused.
  if (st.state !== 'complete' || !st.hash || !provider || st.room !== blobLaneRoom()) return null;
  return sanitizeSource({
    kind: 'blob', hash: st.hash, size: st.size, provider, mime: st.mime ?? '',
    title: (st.name || 'a torrent').slice(0, TV_MAX_TITLE),
  });
}

/** The status line the remote shows. */
export function torrentLine(st: TorrentState, fmt: (n: number) => string): string {
  switch (st.state) {
    case 'unknown': return '';
    case 'none': return 'No torrent yet: paste a magnet and press 🧲 START.';
    case 'metadata': return `🧲 Asking the swarm for ${st.name || 'the file list'}…`;
    case 'ready': {
      const n = st.files.length;
      return `📋 ${st.name || 'The torrent'}: ${n} file${n === 1 ? '' : 's'} the TV can play. Nothing downloads until you pick one and press ⬇ DOWNLOAD.`;
    }
    case 'downloading': {
      const pct = st.size ? Math.floor((st.have / st.size) * 100) : 0;
      return `🧲 ${st.name || 'Downloading'}: ${pct}% of ${fmt(st.size)} · ${st.peers} peer${st.peers === 1 ? '' : 's'} · shared ${fmt(st.uploaded)}`;
    }
    case 'importing': return `🧲 ${st.name || 'The file'} is whole; handing it to your node's blob lane…`;
    case 'complete': return `✅ ${st.name || 'The file'} (${fmt(st.size)}) is on your node, and has stopped sharing. ▶ PLAY NOW puts it on the TV.`;
    case 'failed': return `⚠️ ${st.why || 'The torrent failed.'}`;
    case 'stopped': return 'Stopped, and its pieces deleted.';
  }
}

/** Tests only. */
export function forgetTorrentLane(): void {
  last = { state: 'unknown' };
  lastGen = -1;
  epoch = 0;
  asked = 0;
  landed = 0;
}
