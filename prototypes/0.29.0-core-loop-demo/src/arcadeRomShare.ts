/**
 * 🕹 arcadeRomShare — the owner's own game file, sent to the players who
 * press play (#193; Dorkmo's call: every game the owner loads from disk is
 * sent). Before this, a game from the owner's disk ran only for players
 * who brought their own copy.
 *
 * THE ROOM DOC CARRIES IT, AND ONLY WHILE SOMEONE IS ASKING. There is no
 * file lane between players yet (the envelope kind `asset` is reserved for
 * one), and the room doc is the reliable path every page already has. So:
 *
 *   romask:<sha>:<page>  → { at }                a player's page that pressed
 *                                                play and lacks the file
 *   romsend:<sha>        → { size, chunks, by, at }  the page sending it
 *   romc:<sha>:<i>       → Uint8Array            the file, in ROM_CHUNK_BYTES
 *
 * Any page that HOLDS the file — the owner's, which picked it, and every
 * page that has received it since — answers an ask: it claims the send
 * (romsend), writes CHUNKS_PER_TICK chunks a tick, and once nobody has
 * asked for LINGER_MS, deletes it all. A receiver assembles the chunks,
 * checks the SHA-256 the owner's game record names (arcadeDoc's
 * `game.sha256`), holds the bytes for this page's life, and withdraws its
 * ask. Deleted content leaves the doc (Yjs collects it), so a room's
 * records do not keep a game file once it has been delivered: the room
 * cache and every later join stay small. The bytes do pass through every
 * page in the room on their way (the doc goes to everyone), and every node
 * keeps its recent envelopes a while for peers that missed one.
 *
 * Nobody is a keeper: whoever holds the file and is here sends it; two
 * pages that claim at once write the same bytes, and the claim's LWW picks
 * one to finish. A send that stops (its page left) goes stale after
 * SEND_LAPSE_MS, as THIS page saw it — never by another page's clock — and
 * the next holder takes over, or anyone clears it. Files over
 * ROM_SHARE_MAX_BYTES are not sent: their players bring their own copy.
 *
 * Every read is shape-checked (a peer can write anything here): hashes are
 * 64 hex digits, sizes are capped, a chunk is bytes of exactly its length,
 * and nothing runs until the whole file matches its hash.
 */

import {
  arcadeDocEpoch, arcadePageId, arcadeRawDelete, arcadeRawGet, arcadeRawKeys, arcadeRawSet,
} from './arcadeDoc';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The largest file the room sends (NES, SNES, Game Boy, Mega Drive, most
 *  arcade romsets and many GBA games fit). */
export const ROM_SHARE_MAX_BYTES = 8 * 1024 * 1024;
export const ROM_CHUNK_BYTES = 64 * 1024;
/** Chunks a sender writes per tick (World's arcade beat is 2 Hz): ~1 MB/s. */
export const CHUNKS_PER_TICK = 8;
/** A waiting player re-stamps its ask this often… */
export const ASK_RENEW_MS = 3_000;
/** …and an ask unchanged this long (as this page saw it) is gone. */
export const ASK_LAPSE_MS = 10_000;
/** A send whose record stopped moving this long is stale: taken over or cleared. */
export const SEND_LAPSE_MS = 15_000;
/** A finished send is cleared once nobody has asked for this long. */
export const LINGER_MS = 5_000;
/** Files this page holds for others, most recent kept. */
const HELD_MAX = 8;

const SHA_RE = /^[0-9a-f]{64}$/;
export const isSha256 = (s: unknown): s is string => typeof s === 'string' && SHA_RE.test(s);

const askPrefix = (sha: string) => `romask:${sha}:`;
const askKey = (sha: string, page: string) => `romask:${sha}:${page}`;
const sendKey = (sha: string) => `romsend:${sha}`;
const chunkKey = (sha: string, i: number) => `romc:${sha}:${i}`;
const chunkCount = (size: number) => Math.ceil(size / ROM_CHUNK_BYTES);
const chunkLength = (size: number, i: number) => Math.min(ROM_CHUNK_BYTES, size - i * ROM_CHUNK_BYTES);

let clock: () => number = () => Date.now();
export function setRomShareClock(fn: () => number): void {
  clock = fn;
}

/** SHA-256 of the bytes, as 64 hex digits. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── This page: what it holds, what it wants ─────────────────────────────────

const held = new Map<string, Uint8Array>();

/** This page has the file (its owner picked it, or it arrived and checked
 *  out): it sends it to whoever asks. */
export function holdRom(sha: string, bytes: Uint8Array): void {
  if (!isSha256(sha) || bytes.length === 0 || bytes.length > ROM_SHARE_MAX_BYTES) return;
  held.delete(sha);
  held.set(sha, bytes);
  while (held.size > HELD_MAX) held.delete(held.keys().next().value!);
  wants.delete(sha);
}

export function heldRom(sha: string | undefined): Uint8Array | null {
  return sha ? held.get(sha) ?? null : null;
}

interface Want {
  size: number;
  since: number;
  lastAsk: number;
  /** A check of the assembled bytes is running. */
  checking: boolean;
  /** Chunks it had last tick (progress for the stage). */
  got: number;
  /** The assembled bytes failed their hash: said once, then asked again. */
  bad: boolean;
}
const wants = new Map<string, Want>();

/** Ask the room for a file this page lacks (a player pressed play). */
export function wantRom(sha: string, size: number): void {
  if (!isSha256(sha) || held.has(sha) || wants.has(sha)) return;
  if (!(size > 0 && size <= ROM_SHARE_MAX_BYTES)) return;
  const now = clock();
  wants.set(sha, { size, since: now, lastAsk: -Infinity, checking: false, got: 0, bad: false });
  ask(sha, now);
}

/** Stop asking (the player stood up before it came). */
export function dropWant(sha: string | undefined): void {
  if (!sha || !wants.delete(sha)) return;
  arcadeRawDelete([askKey(sha, arcadePageId())]);
}

export type RomProgress =
  | { state: 'have'; bytes: Uint8Array }
  /** Chunks are coming: `got` of `of`. */
  | { state: 'receiving'; got: number; of: number }
  /** Asked; nobody has started sending (`since`: this page's clock). */
  | { state: 'asking'; since: number; bad: boolean }
  | { state: 'none' };

export function romProgress(sha: string | undefined): RomProgress {
  if (!sha) return { state: 'none' };
  const bytes = held.get(sha);
  if (bytes) return { state: 'have', bytes };
  const want = wants.get(sha);
  if (!want) return { state: 'none' };
  if (want.got > 0) return { state: 'receiving', got: want.got, of: chunkCount(want.size) };
  return { state: 'asking', since: want.since, bad: want.bad };
}

function ask(sha: string, now: number): void {
  const want = wants.get(sha);
  if (!want) return;
  want.lastAsk = now;
  arcadeRawSet(askKey(sha, arcadePageId()), { at: now });
}

// ── What this page has seen (staleness by our clock, never theirs) ─────────

let seenEpoch = -1;
const seen = new Map<string, { stamp: string; at: number }>();

/** When this page first saw the key holding this value. */
function seenAt(key: string, stamp: string, now: number): number {
  const s = seen.get(key);
  if (s && s.stamp === stamp) return s.at;
  seen.set(key, { stamp, at: now });
  return now;
}

interface SendRecord {
  size: number;
  chunks: number;
  by: string;
  at: number;
}

function readSend(sha: string): SendRecord | null {
  const raw = arcadeRawGet(sendKey(sha)) as Partial<SendRecord> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const size = raw.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > ROM_SHARE_MAX_BYTES) return null;
  if (raw.chunks !== chunkCount(size)) return null;
  return {
    size, chunks: raw.chunks, by: typeof raw.by === 'string' ? raw.by.slice(0, 64) : '',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
  };
}

function readChunk(sha: string, i: number, size: number): Uint8Array | null {
  const raw = arcadeRawGet(chunkKey(sha, i));
  return raw instanceof Uint8Array && raw.length === chunkLength(size, i) ? raw : null;
}

/** The pages asking for this file now (their asks still moving). */
function liveAsks(sha: string, now: number): string[] {
  const live: string[] = [];
  for (const key of arcadeRawKeys(askPrefix(sha), 256)) {
    const raw = arcadeRawGet(key) as { at?: unknown } | undefined;
    const at = raw && typeof raw === 'object' && typeof raw.at === 'number' ? raw.at : NaN;
    if (now - seenAt(key, String(at), now) < ASK_LAPSE_MS) live.push(key.slice(askPrefix(sha).length));
  }
  return live;
}

/** Every hash with any record in the doc, bounded. */
function shasInDoc(): Set<string> {
  const out = new Set<string>();
  for (const key of [...arcadeRawKeys('romask:', 512), ...arcadeRawKeys('romsend:', 64), ...arcadeRawKeys('romc:', 2048)]) {
    const sha = key.split(':')[1];
    if (isSha256(sha)) out.add(sha);
  }
  return out;
}

function clearSend(sha: string, size: number | null): void {
  const n = size ? chunkCount(size) : chunkCount(ROM_SHARE_MAX_BYTES);
  const keys = [sendKey(sha)];
  for (let i = 0; i < n; i++) keys.push(chunkKey(sha, i));
  arcadeRawDelete(keys);
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** The sends this page is making: the next chunk, and when the last ask went. */
const sending = new Map<string, { next: number; quietSince: number | null }>();

function sendTick(sha: string, bytes: Uint8Array, now: number): void {
  const me = arcadePageId();
  const asks = liveAsks(sha, now).filter((p) => p !== me);
  const rec = readSend(sha);
  let mine = sending.get(sha);
  if (rec && rec.by !== me) {
    // Someone else is sending: leave it to them unless it has stopped.
    const stale = now - seenAt(sendKey(sha), `${rec.by}:${rec.at}`, now) >= SEND_LAPSE_MS;
    if (!stale || asks.length === 0) {
      sending.delete(sha);
      return;
    }
    mine = undefined;
  }
  if (!mine) {
    if (asks.length === 0) return;
    mine = { next: 0, quietSince: null };
    sending.set(sha, mine);
  }
  const size = bytes.length;
  const n = chunkCount(size);
  if (asks.length === 0) {
    mine.quietSince ??= now;
    if (now - mine.quietSince >= LINGER_MS) {
      clearSend(sha, size);
      sending.delete(sha);
    }
    return;
  }
  mine.quietSince = null;
  arcadeRawSet(sendKey(sha), { size, chunks: n, by: me, at: now } satisfies SendRecord);
  let wrote = 0;
  while (mine.next < n && wrote < CHUNKS_PER_TICK) {
    const i = mine.next++;
    if (readChunk(sha, i, size)) continue; // already there (another sender's)
    arcadeRawSet(chunkKey(sha, i), bytes.subarray(i * ROM_CHUNK_BYTES, i * ROM_CHUNK_BYTES + chunkLength(size, i)).slice());
    wrote++;
  }
  // A chunk deleted under us (a stale clear) is written again.
  if (mine.next >= n) {
    for (let i = 0; i < n; i++) {
      if (!readChunk(sha, i, size)) {
        mine.next = i;
        break;
      }
    }
  }
}

// ── Receiving ────────────────────────────────────────────────────────────────

function receiveTick(sha: string, want: Want, now: number): void {
  if (now - want.lastAsk >= ASK_RENEW_MS) ask(sha, now);
  if (want.checking) return;
  const rec = readSend(sha);
  if (!rec || rec.size !== want.size) {
    want.got = 0;
    return;
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < rec.chunks; i++) {
    const c = readChunk(sha, i, rec.size);
    if (c) parts.push(c);
  }
  want.got = parts.length;
  if (parts.length < rec.chunks) return;
  const bytes = new Uint8Array(rec.size);
  parts.forEach((c, i) => bytes.set(c, i * ROM_CHUNK_BYTES));
  want.checking = true;
  void sha256Hex(bytes).then(
    (hash) => {
      want.checking = false;
      if (wants.get(sha) !== want) return;
      if (hash !== sha) {
        // Not the file the owner put on: ask again, from whoever sends next.
        want.bad = true;
        want.got = 0;
        return;
      }
      holdRom(sha, bytes);
      arcadeRawDelete([askKey(sha, arcadePageId())]);
    },
    () => {
      want.checking = false;
    },
  );
}

// ── The tick (World's arcade beat) ───────────────────────────────────────────

/** Ask, send, receive, and clear what nobody needs. */
export function tickRomShare(now = clock()): void {
  if (arcadeDocEpoch() !== seenEpoch) {
    // Another room's doc: nothing seen there counts here, and a send this
    // page was making there is not one here.
    seenEpoch = arcadeDocEpoch();
    seen.clear();
    sending.clear();
    for (const want of wants.values()) want.lastAsk = -Infinity;
  }
  for (const [sha, want] of wants) receiveTick(sha, want, now);
  for (const [sha, bytes] of held) sendTick(sha, bytes, now);
  // Housekeeping anyone may do: asks that stopped moving, and sends nobody
  // holds up — stale, with nobody asking.
  for (const sha of shasInDoc()) {
    if (held.has(sha) && sending.has(sha)) continue;
    const asks = liveAsks(sha, now);
    const stale = arcadeRawKeys(askPrefix(sha), 256).filter((k) => !asks.includes(k.slice(askPrefix(sha).length)));
    if (stale.length) arcadeRawDelete(stale);
    const rec = readSend(sha);
    const sendStale = !rec || now - seenAt(sendKey(sha), `${rec.by}:${rec.at}`, now) >= SEND_LAPSE_MS;
    if (sendStale && asks.length === 0 && (rec || arcadeRawKeys(`romc:${sha}:`, 1).length)) clearSend(sha, rec?.size ?? null);
  }
  for (const key of [...seen.keys()]) if (arcadeRawGet(key) === undefined) seen.delete(key);
}

/** Forget everything this page holds and wants (tests). */
export function resetRomShare(): void {
  held.clear();
  wants.clear();
  sending.clear();
  seen.clear();
  seenEpoch = -1;
}
