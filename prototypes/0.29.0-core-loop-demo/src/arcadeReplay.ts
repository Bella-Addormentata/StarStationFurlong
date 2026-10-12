/**
 * 🕹👀 arcadeReplay — spectators watch the cabinet by replaying player one's
 * inputs (#193, the spectator plan of 2026-10-11): every nearby spectator
 * runs the same core on the same ROM, player one's frame publishes only the
 * inputs it applied and the frame number it applied them at, and each
 * spectator's own emulator replays them a few frames behind. A late joiner
 * starts from a save state; periodic state hashes catch drift.
 *
 * This module is the page's side of that, DOM-free so it can be tested:
 *
 *  - the WIRE CODEC for an input batch — what a future signed `arcade`
 *    envelope would carry: `through` (every input at or before that frame
 *    is in this batch or an earlier one) and the inputs themselves;
 *  - the CHECKS on what an emulator frame posts: the frame is an opaque
 *    origin running a third party's engine on a ROM (arcadeEmulator.ts), so
 *    nothing it says is taken on its shape until it has been checked here —
 *    a batch the page would forward to the room most of all;
 *  - the DRIFT LEDGER that pairs player one's state hashes with a
 *    spectator's, frame by frame.
 *
 * Frame numbers are player one's emulator frame counter (EmulatorJS's
 * get_current_frame_count): an input stamped `frame: N` was applied after
 * frame N ran and before frame N + 1 did, and a hash stamped `frame: N` is
 * of the state after frame N. The frame side (public/arcade/frame.html)
 * keeps that contract on both ends.
 */

/** One input as EmulatorJS's simulate_input takes it: for a player 0–3, a
 *  RetroPad index (0–15 the buttons, 16–23 the analog sticks' halves) and a
 *  value: 0 or 1 for a button, up to ±0x7fff for an axis. */
export interface ReplayInput {
  frame: number;
  player: number;
  index: number;
  value: number;
}

/** A batch from player one's frame: every input stamped `from` through
 *  `through`, inclusive. Consecutive batches tile the frames with no gap
 *  (the next one's `from` is this one's `through` + 1), which is how a
 *  spectator knows it holds every input before a frame even when the
 *  network hands batches over out of order (ReplayReassembler). */
export interface ReplayBatch {
  from: number;
  through: number;
  inputs: ReplayInput[];
}

/** RetroPad indices above this are EmulatorJS's own hotkeys (save, load,
 *  fast-forward, rewind, slow motion): never replayed, the frame drops them. */
export const REPLAY_MAX_INDEX = 23;
export const REPLAY_MAX_PLAYER = 3;
export const REPLAY_AXIS_MAX = 0x7fff;
/** Frame numbers are a u32 on the wire. */
export const REPLAY_MAX_FRAME = 0xffff_ffff;
/** A batch spans at most this many frames (a u16 on the wire). */
export const REPLAY_MAX_SPAN = 0xffff;
/** A batch's input ceiling: sixty frames of four players pressing every
 *  button once is far below it; a frame posting more is refused whole. */
export const REPLAY_MAX_BATCH_INPUTS = 512;
/** A save state's ceiling (NES ~14 KB; arcade boards a few hundred KB). */
export const REPLAY_MAX_STATE_BYTES = 16 * 1024 * 1024;

export const REPLAY_WIRE_VERSION = 1;
/** version (1) ‖ through (4) ‖ span = through − from + 1 (2) ‖ count (2). */
const HEADER_BYTES = 9;
/** frame delta from `through` (4) ‖ player (1) ‖ index (1) ‖ value (2). */
const INPUT_BYTES = 8;

function isInt(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

/** Is this one valid input? */
export function isReplayInput(i: unknown): i is ReplayInput {
  if (!i || typeof i !== 'object') return false;
  const r = i as Record<string, unknown>;
  return (
    isInt(r.frame, 0, REPLAY_MAX_FRAME) &&
    isInt(r.player, 0, REPLAY_MAX_PLAYER) &&
    isInt(r.index, 0, REPLAY_MAX_INDEX) &&
    isInt(r.value, -REPLAY_AXIS_MAX, REPLAY_AXIS_MAX)
  );
}

/** A span the wire can carry: `from` ≤ `through`, at most REPLAY_MAX_SPAN
 *  frames. */
function isSpan(from: unknown, through: unknown): boolean {
  return (
    isInt(from, 0, REPLAY_MAX_FRAME) &&
    isInt(through, 0, REPLAY_MAX_FRAME) &&
    (from as number) <= (through as number) &&
    (through as number) - (from as number) < REPLAY_MAX_SPAN
  );
}

/** A batch as the frame posts it (`[frame, player, index, value]` rows), or
 *  null when anything in it is off: a span the wire cannot carry, a row out
 *  of range or outside the span, or too many rows. Never partially
 *  accepted. */
export function readFrameBatch(data: unknown): ReplayBatch | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { from?: unknown; through?: unknown; inputs?: unknown };
  if (!isSpan(d.from, d.through) || !Array.isArray(d.inputs)) return null;
  const from = d.from as number;
  const through = d.through as number;
  if (d.inputs.length > REPLAY_MAX_BATCH_INPUTS) return null;
  const inputs: ReplayInput[] = [];
  for (const row of d.inputs) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const input = { frame: row[0], player: row[1], index: row[2], value: row[3] };
    if (!isReplayInput(input) || input.frame < from || input.frame > through) return null;
    inputs.push(input);
  }
  return { from, through, inputs };
}

/** The rows the frame takes back (frame.html's follower). */
export function batchRows(batch: ReplayBatch): number[][] {
  return batch.inputs.map((i) => [i.frame, i.player, i.index, i.value]);
}

/** A state hash as the frame posts it: FNV-1a 32 of the state bytes, hex,
 *  then a colon and the state's length. */
const HASH = /^[0-9a-f]{1,8}:\d{1,9}$/;

export interface ReplayHash {
  frame: number;
  hash: string;
}

/** A state hash's text as the frame writes it (`hex:length`). */
export function isReplayStateHash(v: unknown): v is string {
  return typeof v === 'string' && HASH.test(v);
}

export function readFrameHash(data: unknown): ReplayHash | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { frame?: unknown; hash?: unknown };
  if (!isInt(d.frame, 0, REPLAY_MAX_FRAME) || typeof d.hash !== 'string' || !HASH.test(d.hash)) return null;
  return { frame: d.frame, hash: d.hash };
}

export interface ReplaySnapshot {
  frame: number;
  state: Uint8Array;
  /** The inputs held down at that frame, `[player, index, value]`: a save
   *  state carries the core's state, not the frontend's input array. */
  held: Array<[number, number, number]>;
  hash: string;
}

export function readFrameSnapshot(data: unknown): ReplaySnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { frame?: unknown; state?: unknown; held?: unknown; hash?: unknown };
  if (!isInt(d.frame, 0, REPLAY_MAX_FRAME)) return null;
  if (!(d.state instanceof Uint8Array) || d.state.byteLength === 0 || d.state.byteLength > REPLAY_MAX_STATE_BYTES) return null;
  // Only a view that is its whole buffer: handing a state on moves its
  // buffer, so a small view over a big one would carry the big one past the cap.
  if (d.state.byteOffset !== 0 || d.state.byteLength !== d.state.buffer.byteLength) return null;
  if (typeof d.hash !== 'string' || !HASH.test(d.hash)) return null;
  if (!Array.isArray(d.held) || d.held.length > (REPLAY_MAX_PLAYER + 1) * (REPLAY_MAX_INDEX + 1)) return null;
  const held: Array<[number, number, number]> = [];
  for (const row of d.held) {
    if (!Array.isArray(row) || row.length !== 3) return null;
    if (!isReplayInput({ frame: 0, player: row[0], index: row[1], value: row[2] })) return null;
    held.push([row[0], row[1], row[2]]);
  }
  return { frame: d.frame, state: d.state, held, hash: d.hash };
}

/** FNV-1a 32 over the bytes, as frame.html computes it (`hex:length`). */
export function replayStateHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${bytes.length}`;
}

/** The batch on the wire: little-endian, frames as deltas back from
 *  `through` so a row stays 8 bytes whatever the session's length. */
export function packInputBatch(batch: ReplayBatch): Uint8Array {
  if (!isSpan(batch.from, batch.through)) throw new RangeError('span out of range');
  if (batch.inputs.length > REPLAY_MAX_BATCH_INPUTS) throw new RangeError('too many inputs');
  const out = new Uint8Array(HEADER_BYTES + INPUT_BYTES * batch.inputs.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, REPLAY_WIRE_VERSION);
  dv.setUint32(1, batch.through, true);
  dv.setUint16(5, batch.through - batch.from + 1, true);
  dv.setUint16(7, batch.inputs.length, true);
  batch.inputs.forEach((i, k) => {
    if (!isReplayInput(i) || i.frame < batch.from || i.frame > batch.through) throw new RangeError('input out of range');
    const at = HEADER_BYTES + INPUT_BYTES * k;
    dv.setUint32(at, batch.through - i.frame, true);
    dv.setUint8(at + 4, i.player);
    dv.setUint8(at + 5, i.index);
    dv.setInt16(at + 6, i.value, true);
  });
  return out;
}

/** The inverse, or null for anything malformed (wrong version, a span the
 *  frames cannot hold, a length that is not the header plus whole rows, a
 *  row out of range or outside the span). */
export function unpackInputBatch(bytes: Uint8Array): ReplayBatch | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== REPLAY_WIRE_VERSION) return null;
  const through = dv.getUint32(1, true);
  const span = dv.getUint16(5, true);
  const count = dv.getUint16(7, true);
  if (span === 0 || span > through + 1) return null;
  const from = through - span + 1;
  if (count > REPLAY_MAX_BATCH_INPUTS || bytes.byteLength !== HEADER_BYTES + INPUT_BYTES * count) return null;
  const inputs: ReplayInput[] = [];
  for (let k = 0; k < count; k++) {
    const at = HEADER_BYTES + INPUT_BYTES * k;
    const back = dv.getUint32(at, true);
    if (back >= span) return null;
    const input = {
      frame: through - back,
      player: dv.getUint8(at + 4),
      index: dv.getUint8(at + 5),
      value: dv.getInt16(at + 6, true),
    };
    if (!isReplayInput(input)) return null;
    inputs.push(input);
  }
  return { from, through, inputs };
}

/**
 * Puts batches back in frame order for a spectator. The room's reliable
 * lane carries each envelope on a stream of its own, so two batches can
 * arrive in either order; a follower that took a later batch's `through`
 * as the word on every frame before it would run past inputs still on the
 * way. Batches go out only once every frame before them is covered.
 *
 * Where the order starts is the save state's frame, not the first batch
 * heard: a spectator joins mid-stream, and the first two batches it hears
 * can be the wrong way round too. So batches wait until the save state
 * says where it starts (`start`), or the constructor already knows.
 */
export class ReplayReassembler {
  private next: number | null;
  private readonly held = new Map<number, ReplayBatch>();

  /** `start`: the first frame whose inputs are wanted, when known up front
   *  (null: wait for `start()`). */
  constructor(start: number | null = null, private readonly maxHeld = 600) {
    this.next = start;
  }

  /** The save state the spectator starts from is of `frame`: from here on
   *  it needs every input stamped `frame` or later, in order. Returns the
   *  held batches now in order (possibly none). Only the first call counts:
   *  a later save state (a re-sync) lands on a stream already in order. */
  start(frame: number): ReplayBatch[] {
    if (this.next !== null) return [];
    this.next = frame;
    let first: ReplayBatch | undefined;
    for (const b of this.held.values()) {
      if (b.through < frame) this.held.delete(b.from);
      else if (b.from <= frame) first = b;
    }
    if (!first) return [];
    this.held.delete(first.from);
    return this.take(first);
  }

  /** Take a batch; get back the batches now in order (possibly none). */
  push(batch: ReplayBatch): ReplayBatch[] {
    if (this.next !== null && batch.through < this.next) return []; // already covered
    if (this.next === null || batch.from > this.next) {
      if (this.held.size < this.maxHeld) this.held.set(batch.from, batch);
      return [];
    }
    return this.take(batch);
  }

  /** `batch` covers `next`: out it goes, then every held batch it lets
   *  through. One straddling `next` (the save state's frame, or after a
   *  restart) keeps only what is new. */
  private take(batch: ReplayBatch): ReplayBatch[] {
    const next = this.next!;
    const out = [batch.from < next ? { ...batch, from: next, inputs: batch.inputs.filter((i) => i.frame >= next) } : batch];
    this.next = batch.through + 1;
    for (let b = this.held.get(this.next); b; b = this.held.get(this.next)) {
      this.held.delete(this.next);
      out.push(b);
      this.next = b.through + 1;
    }
    return out;
  }

  /** The first frame not yet covered, or null before the start is known. */
  covered(): number | null {
    return this.next;
  }

  /** Batches waiting on a gap. */
  waiting(): number {
    return this.held.size;
  }
}

/** What the ledger has seen so far. */
export interface DriftStats {
  /** Frames both sides have hashed. */
  compared: number;
  matched: number;
  mismatched: number;
  /** The first frame whose hashes differed, or null. */
  firstMismatch: number | null;
  /** The latest frame both sides hashed. */
  lastCompared: number | null;
}

/**
 * Pairs player one's state hashes with a spectator's by frame. The source
 * runs ahead, so its hashes wait (bounded) for the follower's; a follower
 * hash with no source hash to meet is dropped, never counted.
 */
export class DriftLedger {
  private readonly source = new Map<number, string>();
  private stats: DriftStats = { compared: 0, matched: 0, mismatched: 0, firstMismatch: null, lastCompared: null };

  constructor(private readonly keep = 4096) {}

  /** Player one hashed `frame`. */
  sourceHash(frame: number, hash: string): void {
    this.source.set(frame, hash);
    if (this.source.size > this.keep) {
      const oldest = Math.min(...this.source.keys());
      this.source.delete(oldest);
    }
  }

  /** The spectator hashed `frame`: compare, and say whether it matched
   *  (null when there was nothing to compare with). */
  followerHash(frame: number, hash: string): boolean | null {
    const theirs = this.source.get(frame);
    if (theirs === undefined) return null;
    this.source.delete(frame);
    for (const f of [...this.source.keys()]) if (f < frame) this.source.delete(f);
    const ok = theirs === hash;
    const s = this.stats;
    this.stats = {
      compared: s.compared + 1,
      matched: s.matched + (ok ? 1 : 0),
      mismatched: s.mismatched + (ok ? 0 : 1),
      firstMismatch: s.firstMismatch ?? (ok ? null : frame),
      lastCompared: frame,
    };
    return ok;
  }

  read(): DriftStats {
    return { ...this.stats };
  }
}

/**
 * Lockstep peers' state hashes, compared across every seat by frame: a
 * frame counts once all `seats` have hashed it, matched only when all
 * agree. Peers run within a few frames of each other but in no fixed
 * order, so every seat's hash waits (a bounded number of frames) for the
 * rest.
 */
export class LockstepLedger {
  private readonly frames = new Map<number, Map<number, string>>();
  private stats: DriftStats = { compared: 0, matched: 0, mismatched: 0, firstMismatch: null, lastCompared: null };

  constructor(private readonly seats: number, private readonly keep = 256) {}

  /** Seat `seat` hashed `frame`: true or false once every seat has (did
   *  they all agree), null while some have not. */
  record(seat: number, frame: number, hash: string): boolean | null {
    let byseat = this.frames.get(frame);
    if (!byseat) {
      if (this.frames.size >= this.keep) this.frames.delete(Math.min(...this.frames.keys()));
      byseat = new Map();
      this.frames.set(frame, byseat);
    }
    byseat.set(seat, hash);
    if (byseat.size < this.seats) return null;
    this.frames.delete(frame);
    const hashes = [...byseat.values()];
    const ok = hashes.every((h) => h === hashes[0]);
    const s = this.stats;
    this.stats = {
      compared: s.compared + 1,
      matched: s.matched + (ok ? 1 : 0),
      mismatched: s.mismatched + (ok ? 0 : 1),
      firstMismatch: s.firstMismatch ?? (ok ? null : frame),
      lastCompared: Math.max(frame, s.lastCompared ?? frame),
    };
    return ok;
  }

  read(): DriftStats {
    return { ...this.stats };
  }
}
