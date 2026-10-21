/**
 * 🧲 torrentLane — the page's half of the media lane's step 4 (plan §6,
 * brainstorming/smart-tv-arcade-media-plan.md; the node's half is
 * ssf-p2p-node/src/torrent_lane.rs, built with `--features torrent`).
 *
 * The remote's holder pastes a magnet; THEIR node fetches the one playable
 * file of it from the public swarm (no trackers, a client-only DHT, public
 * peers only) and puts it into the blob lane (blobLane.ts). When it is whole
 * the remote plays it as an ordinary `{ kind: 'blob' }` source, so viewers
 * press FETCH and take it from the holder's node: nobody else joins the
 * swarm, and the magnet itself never goes into the room record.
 *
 * Only this page starts a torrent, on the holder's START press: the routes
 * sit behind the blob lane's gate (an allowed Origin and this launch's token).
 */

import { blobLaneGeneration, blobLaneNodeId, blobLaneRoom, nodeRoute, torrentLaneReady } from './blobLane';
import type { TvSource } from './tvDoc';
import { sanitizeSource, TV_MAX_TITLE } from './tvDoc';

export type TorrentState =
  | { state: 'none' }
  | {
      state: 'metadata' | 'downloading' | 'importing' | 'complete' | 'failed' | 'stopped';
      id: string;
      name: string;
      have: number;
      size: number;
      peers: number;
      uploaded: number;
      why: string;
      /** Set once complete: the blob the file became, and its type. */
      hash: string | null;
      mime: string | null;
    }
  | { state: 'unknown' };

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;

let last: TorrentState = { state: 'unknown' };
let lastGen = -1;

export function parseTorrentState(body: unknown): TorrentState {
  if (!body || typeof body !== 'object') return { state: 'unknown' };
  const r = body as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  if (r.state === 'none') return { state: 'none' };
  switch (r.state) {
    case 'metadata': case 'downloading': case 'importing': case 'complete': case 'failed': case 'stopped': {
      const hash = typeof r.hash === 'string' && HEX_64.test(r.hash) ? r.hash : null;
      if (r.state === 'complete' && !hash) return { state: 'unknown' };
      return {
        state: r.state,
        id: typeof r.id === 'string' && HEX_40.test(r.id) ? r.id : '',
        name: str(r.name, 120),
        have: n(r.have),
        size: n(r.size),
        peers: n(r.peers),
        uploaded: n(r.uploaded),
        why: str(r.why, 300),
        hash,
        mime: typeof r.mime === 'string' ? r.mime.slice(0, 80) : null,
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
  if (!url) return torrentState();
  try {
    const res = await fetch(url, { redirect: 'error' });
    const st = parseTorrentState(res.ok ? await res.json() : null);
    if (gen === blobLaneGeneration()) {
      last = st;
      lastGen = gen;
    }
    return st;
  } catch {
    return torrentState();
  }
}

async function post(path: string, params: Record<string, string>, body?: string): Promise<string | null> {
  const url = nodeRoute(path, params);
  if (!url) return 'The TORRENT tile needs this station\'s node, built with torrents, running here.';
  try {
    // text/plain: a simple request, so no preflight; the node checks the Origin.
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

/** START: hand the pasted magnet to this page's node. Null when it took it. */
export async function startTorrent(magnet: string): Promise<string | null> {
  const text = magnet.trim();
  if (!text.startsWith('magnet:?')) return 'Paste a magnet link (it starts with magnet:?).';
  if (!torrentLaneReady()) return 'The TORRENT tile needs this station\'s node, built with torrents, running here.';
  const why = await post('/api/torrent/add', { room: blobLaneRoom() }, text);
  if (!why) void refreshTorrentState();
  return why;
}

export async function stopTorrent(): Promise<string | null> {
  const why = await post('/api/torrent/stop', {});
  void refreshTorrentState();
  return why;
}

/** The finished torrent as the TV's source: the blob it became, provided by
 *  this page's node. Null until it is complete. */
export function torrentSource(st: TorrentState = torrentState()): TvSource | null {
  const provider = blobLaneNodeId();
  if (st.state !== 'complete' || !st.hash || !provider) return null;
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
}
