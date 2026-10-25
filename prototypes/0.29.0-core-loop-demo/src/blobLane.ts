/**
 * 📦 blobLane — the page's half of the media lane's step 1 (plan §4,
 * brainstorming/smart-tv-arcade-media-plan.md; the node's half is
 * ssf-p2p-node/src/blob_lane.rs).
 *
 * A file the remote's holder picks is streamed to THEIR node, which stores
 * it as a BLAKE3 blob and answers its hash; the TV record then carries
 * `{ kind: 'blob', hash, size, provider }`, the provider being that node's
 * iroh id. A viewer's theatre shows FETCH with the size: the press asks the
 * viewer's OWN node to take the blob from the provider (only if the two
 * nodes are already connected in this room — the node dials nobody by an
 * address the record names), and once it is whole the theatre plays it from
 * that node, `<video crossorigin>` on the node's origin.
 *
 * Nothing here fetches on its own: the record is peer-writable, so every
 * transfer is one this viewer pressed for (§4: never automatic beyond a cap
 * and a budget). The one automatic fetch is the NODE's, in a room this page
 * says it hosts: the host keeps a copy of what the room's TV played, under
 * its own cap and daily budget (blob_lane.rs), so a later visitor's FETCH
 * finds it there — WHERE asks the room's connected nodes who holds a file,
 * and FETCH names them beside the provider.
 *
 * 🔗 An SSF link (ssfLink.ts) is the one fetch from nodes outside the room:
 * a link pasted on THIS page's blaster names them, and the node dials them
 * for that paste alone (fetchFromLink). A file the page marks shareable
 * (shareBlob) is served by the node to anyone who asks for it by hash.
 *
 * The node's routes ask for this launch's capability token (`blob_cap` in
 * the fingerprint) and an allowed Origin; the token rides in the query so a
 * <video> can carry it.
 */

import { trustedNodeMediaOrigin } from './tvConsent';
import type { SsfFilmLink } from './ssfLink';

export interface BlobNode {
  /** The node's HTTP origin, as the fingerprint probe found it. */
  origin: string;
  /** This launch's blob-lane token (fingerprint `blob_cap`). */
  cap: string;
  /** The node's iroh id: the provider a blob imported here names. */
  irohId: string;
  /** 🧲 The node runs the torrent lane too (torrentLane.ts). */
  torrent?: boolean;
}

export type BlobState =
  | { state: 'none' }
  | { state: 'importing' | 'queued' | 'fetching' | 'complete'; have: number; size: number }
  | { state: 'failed'; have: number; size: number; why: string }
  /** The node did not answer the status route (yet). */
  | { state: 'unknown' };

const HEX_64 = /^[0-9a-f]{64}$/;
const CAP_RE = /^[0-9a-f]{64}$/;

let node: BlobNode | null = null;
let room = '';
/** Moves whenever the node's token changes (a restarted node, or none): an
 *  answer to a request made under an older one describes a store that is
 *  gone, and is dropped on arrival rather than written over the new node's. */
let generation = 0;

/** main.ts, on every fingerprint probe: the node and its token, or null
 *  when the node did not answer or runs without the lane. */
export function setBlobLaneNode(n: BlobNode | null): void {
  const ok = n && CAP_RE.test(n.cap) && HEX_64.test(n.irohId) ? n : null;
  if (ok?.cap !== node?.cap) {
    // A restarted node is asked afresh (it keeps only its whole files): what
    // the old one said goes, and so do its polls still in flight (their
    // answers are dropped by generation).
    generation++;
    statuses.clear();
    polling.clear();
    lastPoll.clear();
    holdersHere.clear();
  }
  node = ok;
  declareHosted();
}

/** This machine hosts the room (main.ts's roomHostedHere): its node keeps
 *  copies of what the room's TV plays, unless switched off. */
let hosted = false;
/** main.ts, on every join: the room a blob is imported or fetched FOR — the
 *  node serves it only to members of that room — and whether this machine
 *  hosts it. */
export function setBlobLaneRoom(id: string, hostedHere = false): void {
  room = id;
  hosted = hostedHere;
  declareHosted();
}

/** The (generation, room) the node was last told this machine hosts. */
let declared = '';
/** Tell the node, once per node and room, that this machine hosts the room:
 *  copies go on for it unless its page switched them off before. */
function declareHosted(): void {
  const key = `${generation}|${room}`;
  if (!hosted || declared === key) return;
  const url = route('/api/blob/host', { room });
  if (!url) return;
  declared = key;
  void fetch(url, { method: 'POST', redirect: 'error' })
    .then((res) => { if (!res.ok) declared = ''; else if (heldHere) heldHere.at = -Infinity; })
    .catch(() => { declared = ''; });
}

/** The node runs the lane, and the page trusts the node's origin now. */
export function blobLaneReady(): boolean {
  return node !== null && room !== '' && trustedNodeMediaOrigin() === node.origin;
}

/** This page's node id, for the record's `provider` (null without a node). */
export function blobLaneNodeId(): string | null {
  return blobLaneReady() ? node!.irohId : null;
}

/** 🧲 The node runs the torrent lane, and the blob lane is ready. */
export function torrentLaneReady(): boolean {
  return blobLaneReady() && node!.torrent === true;
}

/** The room the lane imports for (torrentLane.ts sends it with a magnet). */
export function blobLaneRoom(): string {
  return room;
}

/** A gated route on this page's node, or null without one. */
export function nodeRoute(path: string, params: Record<string, string>): string | null {
  return route(path, params);
}

/** Moves whenever the node's token changes (torrentLane.ts drops answers
 *  from before, as this module does). */
export function blobLaneGeneration(): number {
  return generation;
}

function route(path: string, params: Record<string, string>): string | null {
  if (!blobLaneReady()) return null;
  const q = new URLSearchParams({ cap: node!.cap, ...params });
  return `${node!.origin}${path}?${q.toString()}`;
}

/** Where the theatre's <video> reads a whole blob from this page's node. */
export function blobUrl(hash: string): string | null {
  return HEX_64.test(hash) ? route(`/blob/${hash}`, {}) : null;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The node's words for why a request failed, or a plain fallback. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch { /* not JSON */ }
  return fallback;
}

/** Stream `file` to this page's node. Resolves the hash and size, or the
 *  reason it could not. XHR rather than fetch: an upload's progress. */
export function importBlob(
  file: File,
  onProgress: (sent: number, total: number) => void = () => undefined,
): Promise<{ hash: string; size: number } | { error: string }> {
  const url = route('/api/blob/import', { room, mime: file.type });
  if (!url) return Promise.resolve({ error: 'The FILE tile needs this station\'s node (the desktop app) running.' });
  if (file.size === 0) return Promise.resolve({ error: 'That file is empty.' });
  const gen = generation;
  // The node shares the file with the room it was sent for, and only that
  // one: an answer that lands after a room change is not this room's file.
  const asked = room;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total || file.size);
    xhr.onerror = () => resolve({ error: 'Your node did not take the file.' });
    xhr.onload = () => {
      let body: { hash?: unknown; size?: unknown; error?: unknown } = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* not JSON */ }
      if (gen !== generation) {
        resolve({ error: 'Your node restarted while taking the file — choose it again.' });
      } else if (asked !== room) {
        resolve({ error: 'You changed rooms while your node took the file — choose it again here.' });
      } else if (xhr.status === 200 && typeof body.hash === 'string' && HEX_64.test(body.hash) && body.size === file.size) {
        bumpStatus(body.hash);
        statuses.set(body.hash, { state: 'complete', have: file.size, size: file.size });
        // Held for this room now: the library says so before its next ask.
        heldEpoch++;
        if (heldHere && heldHere.gen === gen && heldHere.room === asked) {
          heldHere.held.add(body.hash);
          heldHere.at = -Infinity;
        }
        resolve({ hash: body.hash, size: file.size });
      } else {
        resolve({ error: typeof body.error === 'string' && body.error ? `Your node: ${body.error}.` : 'Your node did not take the file.' });
      }
    };
    xhr.send(file);
  });
}

/** FETCH: ask this page's node to take `hash` from `provider`. The press is
 *  the consent; the size is the one the button showed. Null when the node
 *  took the ask, else why not. */
export async function fetchBlob(hash: string, size: number, provider: string, mime = ''): Promise<string | null> {
  // The provider first, then the room's nodes WHERE said hold it (the host's
  // copy, once the provider has left): the node dials only those it is
  // connected to in this room or met in it lately (online elsewhere now),
  // and checks every byte against the hash.
  const from = [...new Set([provider, ...(nodeHolders(hash) ?? [])])].filter((id) => HEX_64.test(id)).slice(0, 4);
  const url = HEX_64.test(hash) && HEX_64.test(provider) ? route('/api/blob/fetch', { room, hash, size: String(size), from: from.join(','), mime }) : null;
  if (!url) return 'The FILE lane needs this station\'s node (the desktop app) running.';
  const gen = generation;
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error' });
    if (gen !== generation) return 'Your node restarted — press FETCH again.';
    if (res.ok) {
      bumpStatus(hash);
      statuses.set(hash, { state: 'queued', have: 0, size });
      return null;
    }
    return await errorOf(res, 'Your node did not take the ask.');
  } catch {
    return 'Your node did not answer.';
  }
}

/** 🔗 FETCH from an SSF link pasted on this page: the node dials the nodes
 *  the link names by id — this paste is the consent, as FETCH's press is —
 *  besides the room's, takes the file under the size the link declares,
 *  and checks every byte against its hash. It is then this room's, as any
 *  fetch is. Null when the node took the ask, else why not. Never called
 *  for a link read in a room record: a peer's word dials nobody. */
export async function fetchFromLink(link: SsfFilmLink): Promise<string | null> {
  const from = link.nodes.filter((id) => HEX_64.test(id)).slice(0, 4);
  const url = HEX_64.test(link.hash) && from.length
    ? route('/api/blob/fetch', { room, hash: link.hash, size: String(link.size), from: from.join(','), mime: link.mime, link: '1' })
    : null;
  if (!url) return 'An SSF link needs this station\'s node (the desktop app) running here.';
  const gen = generation;
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error' });
    if (gen !== generation) return 'Your node restarted — SEND the link again.';
    if (res.ok) {
      bumpStatus(link.hash);
      statuses.delete(link.hash);
      return null;
    }
    return `Your node: ${await errorOf(res, 'it did not take the link')}.`;
  } catch {
    return 'Your node did not answer.';
  }
}

/** 🔗 Mark a whole file on this page's node shareable by its SSF link (`on`),
 *  or not: while it is, the node serves it to any node that asks for it by
 *  hash. The other holders the link it came from named, or why not. */
export async function shareBlob(hash: string, on: boolean): Promise<{ via: string[] } | { error: string }> {
  const url = HEX_64.test(hash) ? route('/api/blob/share', { hash, on: on ? '1' : '0' }) : null;
  if (!url) return { error: 'That needs this station\'s node running here.' };
  const gen = generation;
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error' });
    if (!res.ok) return { error: `Your node: ${await errorOf(res, 'it did not take that')}.` };
    const body = (await res.json()) as { via?: unknown };
    const via = hexList(body.via, 3);
    if (gen === generation) {
      heldEpoch++; // a held answer asked before says the file as it was
      if (heldHere && heldHere.gen === gen) {
        if (on) heldHere.shared.set(hash, via);
        else heldHere.shared.delete(hash);
      }
    }
    return { via };
  } catch {
    return { error: 'Your node did not answer.' };
  }
}

function hexList(v: unknown, max: number): string[] {
  return (Array.isArray(v) ? v : []).filter((id): id is string => typeof id === 'string' && HEX_64.test(id)).slice(0, max);
}

// ── What this node holds, for the TV library ─────────────────────────────────

/** The node's last answer to the held route: the whole blobs it serves to
 *  this room, and the room members a FETCH from it could dial now. `more`:
 *  the node cut its list, so a hash not on it may still be held. */
let heldHere: {
  gen: number; room: string; held: Set<string>; more: boolean; reachable: Set<string>; at: number;
  /** The node keeps its files across restarts, and how much of its quota they take. */
  keep: boolean; kept: number; quota: number;
  /** Copies for this room, when its page said this machine hosts it. */
  host: HostCopies | null;
  /** 🔗 The held files shared by their SSF link, each with the other
   *  holders its link named. */
  shared: Map<string, string[]>;
} | null = null;

/** What the room's host node copies (blob_lane.rs): on or off, its per-file
 *  cap, its daily budget, and what the last day spent. */
export interface HostCopies {
  on: boolean;
  cap: number;
  day: number;
  spent: number;
  files: number;
  dayFiles: number;
}

function parseHost(v: unknown): HostCopies | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  return { on: r.on === true, cap: n(r.cap), day: n(r.day), spent: n(r.spent), files: n(r.files), dayFiles: n(r.dayFiles) };
}
let heldAsking = false;
/** Moves when this page changes what the node holds (an import, a forget)
 *  or its host switch: an answer asked before describes the node as it was,
 *  and is dropped. */
let heldEpoch = 0;
const HELD_POLL_MS = 5_000;

/** Ask the node again, at most every HELD_POLL_MS (the library calls this
 *  on every paint). Resolves once the answer is in, or at once. */
export async function refreshHeldBlobs(now = performance.now()): Promise<void> {
  const fresh = heldHere && heldHere.gen === generation && heldHere.room === room && now - heldHere.at < HELD_POLL_MS;
  if (fresh || heldAsking) return;
  const url = route('/api/blob/held', { room });
  if (!url) return;
  const gen = generation;
  const asked = room;
  const epoch = heldEpoch;
  heldAsking = true;
  try {
    const res = await fetch(url, { redirect: 'error' });
    const body = (res.ok ? await res.json() : null) as {
      held?: unknown; more?: unknown; reachable?: unknown; keep?: unknown; kept?: unknown; quota?: unknown; host?: unknown; shared?: unknown;
    } | null;
    const hexes = (v: unknown) => new Set((Array.isArray(v) ? v.slice(0, 1000) : []).filter((h): h is string => typeof h === 'string' && HEX_64.test(h)));
    const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const more = body?.more === true || (Array.isArray(body?.held) && body.held.length > 1000);
    if (gen === generation && asked === room && epoch === heldEpoch && body) {
      const held = hexes(body.held);
      const shared = new Map<string, string[]>();
      if (body.shared && typeof body.shared === 'object' && !Array.isArray(body.shared)) {
        for (const [h, via] of Object.entries(body.shared as Record<string, unknown>)) {
          if (held.has(h)) shared.set(h, hexList(via, 3));
        }
      }
      heldHere = {
        gen, room: asked, held, more, reachable: hexes(body.reachable), at: now,
        keep: body.keep === true, kept: n(body.kept), quota: n(body.quota), host: parseHost(body.host), shared,
      };
    }
  } catch { /* kept as it was; the next paint asks again */ } finally {
    heldAsking = false;
  }
}

/** Whether this page's node holds `hash` whole for this room, as it last
 *  said: null when it has not said (no node, not asked yet, or a cut list
 *  that does not name it). */
export function nodeHolds(hash: string): boolean | null {
  if (!heldHere || heldHere.gen !== generation || heldHere.room !== room) return null;
  return heldHere.held.has(hash) ? true : heldHere.more ? null : false;
}

/** 🔗 Whether this page's node shares `hash` by its SSF link, as it last
 *  said: the other holders the link names after it, false when it does not,
 *  null when it has not said. */
export function nodeShares(hash: string): string[] | false | null {
  if (!heldHere || heldHere.gen !== generation || heldHere.room !== room) return null;
  return heldHere.shared.get(hash) ?? (heldHere.held.has(hash) || !heldHere.more ? false : null);
}

/** Whether this page's node keeps its files across restarts, and how much
 *  of its quota they take — null before it said. */
export function nodeLibrarySpace(): { keep: boolean; kept: number; quota: number } | null {
  if (!heldHere || heldHere.gen !== generation || heldHere.room !== room) return null;
  return { keep: heldHere.keep, kept: heldHere.kept, quota: heldHere.quota };
}

/** What this machine's node copies for this room as its host — null when
 *  the room is not one this machine hosts, or the node has not said. */
export function nodeHostCopies(): HostCopies | null {
  if (!heldHere || heldHere.gen !== generation || heldHere.room !== room) return null;
  return heldHere.host;
}

/** The host's switch: keep copies of what this room's TV plays, or not.
 *  Null when the node took it, else why not. */
export async function setHostCopies(on: boolean): Promise<string | null> {
  const url = route('/api/blob/host', { room, on: on ? '1' : '0' });
  if (!url) return 'That needs this station\'s node running here.';
  const gen = generation;
  const asked = room;
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error' });
    if (!res.ok) return `Your node: ${await errorOf(res, 'it did not take that')}.`;
    const body = (await res.json()) as { host?: unknown };
    // The answer is the asked room's: it lands only while the page is there.
    if (gen === generation && asked === room) {
      heldEpoch++; // a held answer asked before says the switch as it was
      if (heldHere && heldHere.gen === gen && heldHere.room === asked) heldHere.host = parseHost(body.host);
    }
    return null;
  } catch {
    return 'Your node did not answer.';
  }
}

// ── WHERE: which of the room's nodes hold a file ────────────────────────────

/** WHERE's answers: file → the room's nodes holding it whole: its connected
 *  members, and the few nodes met in it lately that answered from wherever
 *  they are online now. */
const holdersHere = new Map<string, { room: string; at: number; ids: string[] }>();
let whereAsking = false;
/** An answer is asked again after this long (the node keeps its own for a minute). */
const WHERE_POLL_MS = 30_000;
/** The most files one ask names (the node takes 16). */
const WHERE_MAX = 16;

/** Ask the node which of the room's nodes hold these files, for those not
 *  asked lately. Resolves once the answer is in, or at once. */
export async function refreshHolders(hashes: string[], now = performance.now()): Promise<void> {
  const due = [...new Set(hashes)].filter((h) => {
    const known = holdersHere.get(h);
    return HEX_64.test(h) && !(known && known.room === room && now - known.at < WHERE_POLL_MS);
  }).slice(0, WHERE_MAX);
  if (due.length === 0 || whereAsking) return;
  const url = route('/api/blob/where', { room, hashes: due.join(',') });
  if (!url) return;
  const gen = generation;
  const asked = room;
  whereAsking = true;
  try {
    const res = await fetch(url, { redirect: 'error' });
    const body = (res.ok ? await res.json() : null) as { holders?: unknown } | null;
    const got = body?.holders && typeof body.holders === 'object' ? (body.holders as Record<string, unknown>) : null;
    if (gen === generation && asked === room && got) {
      // A file the answer leaves out is unknown yet (the node was busy
      // asking), and is asked again on the next paint.
      for (const h of due) {
        const ids = got[h];
        if (!Array.isArray(ids)) continue;
        holdersHere.set(h, { room: asked, at: now, ids: ids.filter((id): id is string => typeof id === 'string' && HEX_64.test(id)).slice(0, 8) });
      }
    }
  } catch { /* asked again on the next paint */ } finally {
    whereAsking = false;
  }
}

/** The room's nodes WHERE last said hold `hash` whole; null before it was
 *  asked. */
export function nodeHolders(hash: string): string[] | null {
  const known = holdersHere.get(hash);
  return known && known.room === room ? known.ids : null;
}

/** The same, only while the answer is fresh (asked within WHERE_POLL_MS),
 *  else null: for an ask that names them once and for good (the theatre's
 *  AUTO-FETCH), where an answer from long ago — nobody held it then, or
 *  members since gone — would leave out the host that holds it now. */
export function freshNodeHolders(hash: string, now = performance.now()): string[] | null {
  const known = holdersHere.get(hash);
  return known && known.room === room && now - known.at < WHERE_POLL_MS ? known.ids : null;
}

/** 🗑 Let a whole file go from this page's node (the room's library entry
 *  stays). Null when it went, else why not. */
export async function forgetBlob(hash: string): Promise<string | null> {
  const url = HEX_64.test(hash) ? route('/api/blob/forget', { hash }) : null;
  if (!url) return 'That needs this station\'s node running here.';
  const gen = generation;
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error' });
    if (!res.ok) return `Your node: ${await errorOf(res, 'it did not let the file go')}.`;
    if (gen === generation) {
      heldEpoch++;
      bumpStatus(hash);
      statuses.delete(hash);
      heldHere?.held.delete(hash);
      heldHere?.shared.delete(hash);
      if (heldHere) heldHere.at = -Infinity; // ask again: the space changed
    }
    return null;
  } catch {
    return 'Your node did not answer.';
  }
}

/** Whether `provider` is connected to this page's node in the room now:
 *  true, false, or null when the node has not said (no node, or not asked
 *  yet). One that is not may still be reached where it is online now, when
 *  the two met in the room lately (WHERE finds it). */
export function nodeReaches(provider: string): boolean | null {
  if (!heldHere || heldHere.gen !== generation || heldHere.room !== room) return null;
  return heldHere.reachable.has(provider);
}

// ── Status, polled while a theatre watches it ────────────────────────────────

const statuses = new Map<string, BlobState>();
const polling = new Set<string>();
const lastPoll = new Map<string, number>();
/** Moves per hash when this page changes it on the node (an import, a
 *  forget, a recheck): a status asked before lands on nothing. */
const statusVersion = new Map<string, number>();
const POLL_MS = 1_000;
/** A whole file can still go (let go from the remote, or to make room), so
 *  `complete` is asked about again this often while a theatre reads it. */
const COMPLETE_POLL_MS = 15_000;

function bumpStatus(hash: string): void {
  statusVersion.set(hash, (statusVersion.get(hash) ?? 0) + 1);
}

/** Forget what the node said about `hash` and ask again at the next look:
 *  a player that could not read a `complete` file asks before it mounts
 *  it again (the node may have let it go). */
export function recheckBlob(hash: string): void {
  bumpStatus(hash);
  statuses.delete(hash);
  lastPoll.delete(hash);
}

function parseState(body: unknown): BlobState {
  if (!body || typeof body !== 'object') return { state: 'unknown' };
  const r = body as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  switch (r.state) {
    case 'none': return { state: 'none' };
    case 'importing': case 'queued': case 'fetching': case 'complete':
      return { state: r.state, have: n(r.have), size: n(r.size) };
    case 'failed':
      return { state: 'failed', have: n(r.have), size: n(r.size), why: typeof r.why === 'string' ? r.why.slice(0, 200) : '' };
    default: return { state: 'unknown' };
  }
}

/** What this page's node last said about `hash`; asks again in the
 *  background at most once a second, so a theatre tick can call it freely. */
export function blobState(hash: string, now = performance.now()): BlobState {
  const known = statuses.get(hash) ?? { state: 'unknown' };
  const every = known.state === 'complete' ? COMPLETE_POLL_MS : POLL_MS;
  if (!polling.has(hash) && now - (lastPoll.get(hash) ?? -Infinity) >= every) {
    const url = HEX_64.test(hash) ? route('/api/blob/status', { hash }) : null;
    if (url) {
      const gen = generation;
      const version = statusVersion.get(hash) ?? 0;
      polling.add(hash);
      lastPoll.set(hash, now);
      void fetch(url, { redirect: 'error' })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => { if (gen === generation && version === (statusVersion.get(hash) ?? 0)) statuses.set(hash, parseState(body)); })
        .catch(() => { /* kept as it was; the next tick asks again */ })
        .finally(() => { if (gen === generation) polling.delete(hash); });
    }
  }
  return known;
}

/** What this page's node says about `hash`, asked now rather than read
 *  from the polled answers blobState keeps. */
export async function blobStateNow(hash: string): Promise<BlobState> {
  const url = HEX_64.test(hash) ? route('/api/blob/status', { hash }) : null;
  if (!url) return { state: 'unknown' };
  try {
    const res = await fetch(url, { redirect: 'error' });
    return parseState(res.ok ? await res.json() : null);
  } catch {
    return { state: 'unknown' };
  }
}

/** What identifies the node a blob is read from now — its origin and its
 *  token's first digits — for the theatre's mount key: a node that changed
 *  under a mounted player is a new mount, not a stale `src`. '' without one. */
export function blobNodeTag(): string {
  return blobLaneReady() ? `${node!.origin}#${node!.cap.slice(0, 8)}` : '';
}

/** Tests only. */
export function forgetBlobLane(): void {
  node = null;
  room = '';
  hosted = false;
  declared = '';
  holdersHere.clear();
  whereAsking = false;
  heldHere = null;
  heldAsking = false;
  heldEpoch = 0;
  statuses.clear();
  polling.clear();
  lastPoll.clear();
  statusVersion.clear();
}

export const __test = { parseState };
