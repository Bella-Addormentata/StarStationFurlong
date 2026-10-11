/**
 * 🕹️ Arcade netplay: the wire and the bookkeeping, pure and tested.
 *
 * A shared game on a cabinet runs on every computer in the room at once.
 * The HOST (the player who started it) runs the reference copy. Each frame
 * it applies both pads, player 1's from its own keys and player 2's from the
 * guest's ticks (or a second pad on the host's own computer), and sends the
 * resulting pad bytes to everyone. Every other copy (the guest's, every
 * watcher's) runs the same frames with the same bytes, so it shows the same
 * game. Nothing but button presses crosses the network: two bytes a frame.
 *
 * A copy that joins late, or loses track (missed ticks, a failed check),
 * asks for a SAVE STATE; the host writes a compact one into the room doc
 * (arcadeSession.ts) and the copy carries on from it.
 *
 * THE WIRE is the room's 13-byte tick lane (network/protocol.ts), the only
 * unreliable datagram the node relays. All four lane kinds are taken, so
 * arcade ticks are a subtype of kind 1 (air-hockey mallet): flags bit 5 set,
 * which no mallet tick ever sets. Bytes 1–4, the x float, are a quiet NaN
 * whose spare bits carry the match id. A client from before this change
 * hands a kind-1 tick to air hockey, which drops any tick whose x is not
 * finite, so an arcade tick can never pose as a mallet or an avatar there.
 *
 *   [0]     flags: 0b01 1 vvv tt (kind 1, arcade bit, version 0, type)
 *   [1..2]  match id, u16 LE (1–65535)
 *   [3]     0b11 cccccc: NaN exponent/quiet bits + a 6-bit field (check)
 *   [4]     0x7f: the rest of the NaN exponent
 *   [5..12] the type's own eight bytes (see packArcadeTick)
 *
 * FRAMES (host → room) carry the pad bytes as two runs: the current pair,
 * held for the last run0+1 frames, and the pair before it, held run1+1
 * frames before that. Pads change a few times a second, so each tick repeats
 * a long stretch of history, and a copy that lost a few ticks fills the gap
 * from the next one. Frame numbers are u16 and wrap (18 minutes); every
 * comparison here is serial arithmetic, so a long game never runs out.
 */

import type { MachineState, NesButton } from './arcadeMachine';
import { MAX_SNAPSHOT_BYTES } from './games/arcade';
import { TICK_BYTES } from './network/protocol';

// ── Pad bytes ────────────────────────────────────────────────────────────────

/** NES button → bit in a pad byte (jsnes's button numbering). */
export const PAD_BIT: Readonly<Record<NesButton, number>> = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
};

export function padByte(buttons: Iterable<NesButton>): number {
  let byte = 0;
  for (const button of buttons) byte |= PAD_BIT[button];
  return byte;
}

// ── u16 serial arithmetic ────────────────────────────────────────────────────

/** `a − b` on the wrapping u16 frame clock, as a signed distance. */
export function frameDiff(a: number, b: number): number {
  return ((((a - b) & 0xffff) ^ 0x8000) - 0x8000);
}

export function frameAdd(a: number, n: number): number {
  return (a + n) & 0xffff;
}

// ── The wire ─────────────────────────────────────────────────────────────────

/** Flags bit 5 inside the kind-1 lane: this tick is the arcade's. */
export const ARCADE_TICK_BIT = 0x20;
const KIND_1 = 0x40;
const TYPE_FRAMES = 0;
const TYPE_GUEST = 1;
const TYPE_SYNC = 2;

export type ArcadeTick =
  /** Host → room: pad bytes ending at `frame` (p1 | p2 << 8 per frame). */
  | { type: 'frames'; match: number; frame: number; cur: number; run0: number; prev: number; run1: number; check: number }
  /** Guest → host: the guest's pad. `changes` counts its changes (u8) so a
   *  host that missed one can replay `prev` for a frame. */
  | { type: 'guest'; match: number; token: number; cur: number; prev: number; changes: number; seq: number }
  /** Any copy → host: please write a save state. */
  | { type: 'sync'; match: number; nonce: number };

/** Is this flags byte an arcade tick's (kind 1 with the arcade bit)? */
export function isArcadeTickFlags(flags: number): boolean {
  return (flags & 0xe0) === (KIND_1 | ARCADE_TICK_BIT);
}

export function packArcadeTick(t: ArcadeTick): Uint8Array {
  const b = new Uint8Array(TICK_BYTES);
  const type = t.type === 'frames' ? TYPE_FRAMES : t.type === 'guest' ? TYPE_GUEST : TYPE_SYNC;
  b[0] = KIND_1 | ARCADE_TICK_BIT | type;
  b[1] = t.match & 0xff;
  b[2] = (t.match >> 8) & 0xff;
  b[3] = 0xc0 | (t.type === 'frames' ? t.check & 0x3f : 0);
  b[4] = 0x7f;
  if (t.type === 'frames') {
    b[5] = t.frame & 0xff;
    b[6] = (t.frame >> 8) & 0xff;
    b[7] = t.cur & 0xff;
    b[8] = (t.cur >> 8) & 0xff;
    b[9] = Math.max(0, Math.min(255, t.run0));
    b[10] = t.prev & 0xff;
    b[11] = (t.prev >> 8) & 0xff;
    b[12] = Math.max(0, Math.min(255, t.run1));
  } else if (t.type === 'guest') {
    b[5] = t.token & 0xff;
    b[6] = (t.token >> 8) & 0xff;
    b[7] = t.cur & 0xff;
    b[8] = t.prev & 0xff;
    b[9] = t.changes & 0xff;
    b[10] = t.seq & 0xff;
    b[11] = (t.seq >> 8) & 0xff;
  } else {
    b[5] = t.nonce & 0xff;
    b[6] = (t.nonce >> 8) & 0xff;
  }
  return b;
}

/** Decode a bare 13-byte tick; null if it isn't a well-formed arcade tick
 *  (another lane's, a newer version's, or garbage from a peer). */
export function unpackArcadeTick(b: Uint8Array): ArcadeTick | null {
  if (b.byteLength < TICK_BYTES || !isArcadeTickFlags(b[0])) return null;
  if (b[0] & 0x1c) return null; // a later wire version
  if ((b[3] & 0xc0) !== 0xc0 || b[4] !== 0x7f) return null; // not NaN-boxed
  const match = b[1] | (b[2] << 8);
  if (match === 0) return null;
  const u16 = (i: number) => b[i] | (b[i + 1] << 8);
  switch (b[0] & 0x03) {
    case TYPE_FRAMES:
      return {
        type: 'frames', match, frame: u16(5),
        cur: u16(7), run0: b[9], prev: u16(10), run1: b[12], check: b[3] & 0x3f,
      };
    case TYPE_GUEST:
      return { type: 'guest', match, token: u16(5), cur: b[7], prev: b[8], changes: b[9], seq: u16(10) };
    case TYPE_SYNC:
      return { type: 'sync', match, nonce: u16(5) };
    default:
      return null;
  }
}

// ── Host: the runs it sends ──────────────────────────────────────────────────

/**
 * The host's record of the pad pairs it ran, kept as the last two runs:
 * exactly what a FRAMES tick carries.
 */
export class PadRuns {
  private last = -1;
  private cur = 0;
  private curStart = 0;
  private prev = 0;
  private prevStart = -1;

  /** Frame `frame` (u16) ran with `pads`. Frames arrive in order. */
  record(frame: number, pads: number): void {
    if (this.last < 0) {
      this.cur = pads;
      this.curStart = frame;
    } else if (pads !== this.cur) {
      this.prev = this.cur;
      this.prevStart = this.curStart;
      this.cur = pads;
      this.curStart = frame;
    }
    this.last = frame;
  }

  /** The FRAMES fields for the latest frame, or null before any. */
  tick(): { frame: number; cur: number; run0: number; prev: number; run1: number } | null {
    if (this.last < 0) return null;
    const run0 = Math.min(255, frameDiff(this.last, this.curStart));
    const hasPrev = this.prevStart >= 0 && run0 < 255;
    return {
      frame: this.last,
      cur: this.cur,
      run0,
      prev: hasPrev ? this.prev : 0,
      run1: hasPrev ? Math.min(255, frameDiff(this.curStart, this.prevStart) - 1) : 0,
    };
  }
}

// ── Every other copy: the pads it knows ──────────────────────────────────────

/** Frames of history a copy keeps (~2 minutes). */
const LOG_SIZE = 8192;

/**
 * The pad pairs a copy has learned, by frame (u16). FRAMES ticks fill it a
 * run at a time; the copy runs frame f once `has(f)`.
 */
export class PadLog {
  private readonly frameAt = new Int32Array(LOG_SIZE).fill(-1);
  private readonly pads = new Uint16Array(LOG_SIZE);
  /** Newest frame any tick has mentioned, or null. */
  latest: number | null = null;

  has(frame: number): boolean {
    return this.frameAt[frame & (LOG_SIZE - 1)] === frame;
  }

  get(frame: number): number {
    return this.has(frame) ? this.pads[frame & (LOG_SIZE - 1)] : 0;
  }

  set(frame: number, pads: number): void {
    const i = frame & (LOG_SIZE - 1);
    this.frameAt[i] = frame;
    this.pads[i] = pads;
  }

  /** File a FRAMES tick's runs. The earlier run is placed only when the
   *  current one's start is exact (run0 not capped at 255) and isn't the
   *  match's first frame, which has nothing before it. */
  addTick(t: { frame: number; cur: number; run0: number; prev: number; run1: number }): void {
    const curFrom = frameAdd(t.frame, -t.run0);
    this.fill(curFrom, t.frame, t.cur);
    if (t.run0 < 255 && curFrom !== 0) {
      const prevTo = frameAdd(curFrom, -1);
      const prevFrom = frameAdd(prevTo, -t.run1);
      this.fill(prevFrom, prevTo, t.prev);
    }
    if (this.latest === null || frameDiff(t.frame, this.latest) > 0) this.latest = t.frame;
  }

  private fill(from: number, to: number, pads: number): void {
    const n = frameDiff(to, from);
    if (n < 0 || n >= LOG_SIZE) return;
    for (let k = 0; k <= n; k++) {
      const f = frameAdd(from, k);
      if (!this.has(f)) this.set(f, pads);
    }
  }

  /** How many frames in a row, from `from`, are known. */
  run(from: number, max = LOG_SIZE): number {
    let n = 0;
    while (n < max && this.has(frameAdd(from, n))) n++;
    return n;
  }

  clear(): void {
    this.frameAt.fill(-1);
    this.latest = null;
  }
}

// ── Host: the guest's pad ────────────────────────────────────────────────────

/**
 * Player 2's pad on the host, from the guest's ticks. Each distinct pad the
 * guest reports is held for at least one frame, so a quick tap still lands;
 * a tick that shows two changes since the last one also replays the pad
 * between them (`prev`).
 */
export class GuestPad {
  private queue: number[] = [];
  private applied = 0;
  private seenChanges: number | null = null;
  private lastSeq: number | null = null;

  onTick(t: { cur: number; prev: number; changes: number; seq: number }): void {
    if (this.lastSeq !== null && frameDiff(t.seq, this.lastSeq) <= 0) return; // stale or repeated
    this.lastSeq = t.seq;
    if (this.seenChanges === null) {
      this.queue.push(t.cur);
    } else {
      const d = (t.changes - this.seenChanges) & 0xff;
      if (d >= 2) this.queue.push(t.prev & 0xff, t.cur);
      else if (d === 1) this.queue.push(t.cur);
    }
    this.seenChanges = t.changes;
    // A long backlog means ticks bunched up: keep the newest few.
    if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8);
  }

  /** The guest's pad for the host's next frame. */
  next(): number {
    const queued = this.queue.shift();
    if (queued !== undefined) this.applied = queued;
    return this.applied;
  }

  /** The guest went quiet: let go of everything. */
  reset(): void {
    this.queue = [];
    this.applied = 0;
    this.seenChanges = null;
    this.lastSeq = null;
  }
}

// ── Save states, compact ─────────────────────────────────────────────────────

const isInt = Number.isInteger;

/**
 * Subtract the ROM's power-on state, leaf by leaf, so what didn't change
 * (the ROM bytes mirrored into memory, most of video memory) becomes zeros.
 * Only integers are subtracted; anything else passes through as is, and
 * undoDelta applies the same rule, so the pair is exact.
 */
function delta(s: unknown, r: unknown): unknown {
  if (typeof s === 'number') return typeof r === 'number' && isInt(s) && isInt(r) ? s - r : s;
  if (Array.isArray(s)) {
    const ra = Array.isArray(r) ? r : [];
    return s.map((v, i) => delta(v, ra[i]));
  }
  if (s && typeof s === 'object') {
    const ro = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(s)) out[k] = delta((s as Record<string, unknown>)[k], ro[k]);
    return out;
  }
  return s;
}

function undoDelta(d: unknown, r: unknown): unknown {
  if (typeof d === 'number') return typeof r === 'number' && isInt(d) && isInt(r) ? d + r : d;
  if (Array.isArray(d)) {
    const ra = Array.isArray(r) ? r : [];
    return d.map((v, i) => undoDelta(v, ra[i]));
  }
  if (d && typeof d === 'object') {
    const ro = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(d)) out[k] = undoDelta((d as Record<string, unknown>)[k], ro[k]);
    return out;
  }
  return d;
}

/** The most JSON a save state may inflate to (a whole jsnes state is about
 *  a megabyte; its difference from power-on is less). */
export const MAX_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;

/** Run bytes through a (de)compression stream, read chunk by chunk, giving
 *  up the moment the output passes `maxOut` (a deflate bomb in the doc). */
async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maxOut = Infinity,
): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOut) {
      await reader.cancel().catch(() => undefined);
      throw new Error('save state too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * A save state as deflated JSON of its difference from the ROM's power-on
 * state (`boot`, ArcadeMachine.bootState): about 10–20 KB for the bundled
 * games, against roughly a megabyte of plain jsnes JSON.
 */
export async function encodeSnapshot(state: MachineState, boot: MachineState): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(delta(state, boot)));
  return pipe(json, new CompressionStream('deflate'));
}

/** Undo encodeSnapshot against the same ROM's power-on state. Throws on
 *  anything that isn't one (a corrupt or hostile doc entry). */
export async function decodeSnapshot(data: Uint8Array, boot: MachineState): Promise<MachineState> {
  if (data.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('save state too large');
  const json = await pipe(data, new DecompressionStream('deflate'), MAX_SNAPSHOT_JSON_BYTES);
  const state = undoDelta(JSON.parse(new TextDecoder().decode(json)), boot);
  if (!state || typeof state !== 'object') throw new Error('not a save state');
  for (const part of ['cpu', 'mmap', 'ppu', 'papu']) {
    if (!(state as Record<string, unknown>)[part] || typeof (state as Record<string, unknown>)[part] !== 'object') {
      throw new Error('not a save state');
    }
  }
  return state as MachineState;
}
