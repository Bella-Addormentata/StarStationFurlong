/**
 * 🕹👀 arcadeReplay — the input batch on the wire, the checks on what an
 * emulator frame posts, and the drift ledger.
 */
import { describe, expect, it } from 'vitest';
import {
  batchRows, DriftLedger, packInputBatch, readFrameBatch, readFrameHash, readFrameSnapshot, replayStateHash,
  unpackInputBatch, ReplayReassembler, REPLAY_MAX_BATCH_INPUTS, REPLAY_MAX_FRAME, REPLAY_MAX_STATE_BYTES, REPLAY_WIRE_VERSION,
} from './arcadeReplay';
import type { ReplayBatch } from './arcadeReplay';

const batch: ReplayBatch = {
  from: 994,
  through: 1_000,
  inputs: [
    { frame: 994, player: 0, index: 8, value: 1 },
    { frame: 997, player: 0, index: 8, value: 0 },
    { frame: 1_000, player: 1, index: 16, value: -0x7fff },
  ],
};

describe('the input batch on the wire', () => {
  it('round-trips, eight bytes a row after a nine-byte header', () => {
    const bytes = packInputBatch(batch);
    expect(bytes.byteLength).toBe(9 + 8 * 3);
    expect(bytes[0]).toBe(REPLAY_WIRE_VERSION);
    expect(unpackInputBatch(bytes)).toEqual(batch);
  });

  it('carries an empty batch: `through` alone says the frames are final', () => {
    expect(unpackInputBatch(packInputBatch({ from: 37, through: 42, inputs: [] }))).toEqual({ from: 37, through: 42, inputs: [] });
  });

  it('refuses to pack what it could not read back', () => {
    expect(() => packInputBatch({ from: 5, through: 10, inputs: [{ frame: 11, player: 0, index: 0, value: 1 }] })).toThrow();
    expect(() => packInputBatch({ from: 5, through: 10, inputs: [{ frame: 4, player: 0, index: 0, value: 1 }] })).toThrow();
    expect(() => packInputBatch({ from: 0, through: 10, inputs: [{ frame: 1, player: 4, index: 0, value: 1 }] })).toThrow();
    expect(() => packInputBatch({ from: 0, through: 10, inputs: [{ frame: 1, player: 0, index: 24, value: 1 }] })).toThrow();
    expect(() => packInputBatch({ from: 11, through: 10, inputs: [] })).toThrow();
    expect(() => packInputBatch({ from: 0, through: 70_000, inputs: [] })).toThrow();
  });

  it('reads nothing malformed: version, length, a row out of range', () => {
    const bytes = packInputBatch(batch);
    const wrongVersion = bytes.slice();
    wrongVersion[0] = 9;
    expect(unpackInputBatch(wrongVersion)).toBeNull();
    expect(unpackInputBatch(bytes.slice(0, bytes.length - 1))).toBeNull();
    expect(unpackInputBatch(new Uint8Array(3))).toBeNull();
    const badIndex = bytes.slice();
    badIndex[9 + 5] = 30; // the first row's index
    expect(unpackInputBatch(badIndex)).toBeNull();
    const outsideSpan = bytes.slice();
    new DataView(outsideSpan.buffer).setUint32(9, 7, true); // frame 993, before `from`
    expect(unpackInputBatch(outsideSpan)).toBeNull();
    const zeroSpan = bytes.slice();
    new DataView(zeroSpan.buffer).setUint16(5, 0, true);
    expect(unpackInputBatch(zeroSpan)).toBeNull();
  });
});

describe('what the emulator frame posts is checked before anything uses it', () => {
  it('a batch: whole or not at all', () => {
    expect(readFrameBatch({ from: 994, through: 1_000, inputs: batchRows(batch) })).toEqual(batch);
    expect(readFrameBatch({ from: 994, through: 999, inputs: batchRows(batch) })).toBeNull(); // an input after `through`
    expect(readFrameBatch({ from: 995, through: 1_000, inputs: batchRows(batch) })).toBeNull(); // one before `from`
    expect(readFrameBatch({ from: 0, through: 1_000, inputs: [[1, 0, 0]] })).toBeNull();
    expect(readFrameBatch({ from: 0, through: 1_000, inputs: [[1, 0, 0, 0x8000]] })).toBeNull();
    expect(readFrameBatch({ from: 0, through: 1_000, inputs: [[1.5, 0, 0, 1]] })).toBeNull();
    expect(readFrameBatch({ from: 0, through: 'x', inputs: [] })).toBeNull();
    expect(readFrameBatch({ through: 10, inputs: [] })).toBeNull();
    const flood = Array.from({ length: REPLAY_MAX_BATCH_INPUTS + 1 }, () => [0, 0, 0, 1]);
    expect(readFrameBatch({ from: 0, through: 0, inputs: flood })).toBeNull();
  });

  it('a hash: a frame and FNV-1a hex with the length', () => {
    expect(readFrameHash({ frame: 60, hash: 'd5d7dc6e:13752' })).toEqual({ frame: 60, hash: 'd5d7dc6e:13752' });
    expect(readFrameHash({ frame: 60, hash: '<script>' })).toBeNull();
    expect(readFrameHash({ frame: REPLAY_MAX_FRAME + 1, hash: '0:1' })).toBeNull();
  });

  it('a snapshot: bounded bytes, held inputs in range', () => {
    const state = new Uint8Array([1, 2, 3]);
    const ok = { frame: 9, state, held: [[0, 8, 1]], hash: replayStateHash(state) };
    expect(readFrameSnapshot(ok)).toEqual({ ...ok, held: [[0, 8, 1]] });
    expect(readFrameSnapshot({ ...ok, state: new Uint8Array(0) })).toBeNull();
    expect(readFrameSnapshot({ ...ok, state: [1, 2, 3] })).toBeNull();
    expect(readFrameSnapshot({ ...ok, held: [[0, 99, 1]] })).toBeNull();
  });

  it('a snapshot is its whole buffer: a small view over a big one is refused', () => {
    const big = new Uint8Array(new ArrayBuffer(REPLAY_MAX_STATE_BYTES + 1), 0, 3);
    big.set([1, 2, 3]);
    const at = new Uint8Array(new ArrayBuffer(4), 1, 3);
    at.set([1, 2, 3]);
    for (const state of [big, at]) expect(readFrameSnapshot({ frame: 9, state, held: [], hash: replayStateHash(state) })).toBeNull();
  });

  it('hashes the way frame.html does', () => {
    expect(replayStateHash(new Uint8Array([]))).toBe('811c9dc5:0');
    expect(replayStateHash(new Uint8Array([0x61]))).toBe('e40c292c:1'); // FNV-1a 32 of "a"
  });
});

describe('the reassembler puts batches back in frame order', () => {
  const b = (from: number, through: number, frames: number[] = []): ReplayBatch => ({
    from, through, inputs: frames.map((frame) => ({ frame, player: 0, index: 8, value: 1 })),
  });

  it('passes batches that arrive in order straight through', () => {
    const r = new ReplayReassembler(10);
    expect(r.push(b(10, 15))).toEqual([b(10, 15)]);
    expect(r.push(b(16, 21))).toEqual([b(16, 21)]);
    expect(r.covered()).toBe(22);
  });

  it('holds a batch past a gap until the gap fills, then releases both in order', () => {
    const r = new ReplayReassembler(10);
    r.push(b(10, 15));
    expect(r.push(b(22, 27, [24]))).toEqual([]);
    expect(r.waiting()).toBe(1);
    expect(r.push(b(16, 21, [16]))).toEqual([b(16, 21, [16]), b(22, 27, [24])]);
    expect(r.covered()).toBe(28);
    expect(r.waiting()).toBe(0);
  });

  it('drops what is already covered, and keeps only the new part of a straddler', () => {
    const r = new ReplayReassembler(10);
    r.push(b(10, 15));
    expect(r.push(b(10, 15))).toEqual([]);
    expect(r.push(b(12, 20, [13, 18]))).toEqual([b(16, 20, [18])]);
  });

  it('holds a bounded number of batches', () => {
    const r = new ReplayReassembler(0, 2);
    r.push(b(0, 0));
    r.push(b(5, 5));
    r.push(b(7, 7));
    r.push(b(9, 9));
    expect(r.waiting()).toBe(2);
  });

  it("starts at a late joiner's save state, even when its first two batches came the wrong way round", () => {
    const r = new ReplayReassembler();
    // Taking the first batch heard as the start would have dropped the
    // earlier one, and the input at 14 with it.
    expect(r.push(b(16, 21, [18]))).toEqual([]);
    expect(r.push(b(10, 15, [11, 14]))).toEqual([]);
    expect(r.covered()).toBeNull();
    // The save state is of frame 12: every input from 12 on, in order.
    expect(r.start(12)).toEqual([b(12, 15, [14]), b(16, 21, [18])]);
    expect(r.covered()).toBe(22);
    expect(r.waiting()).toBe(0);
  });

  it('drops what came before the save state, and waits through a gap after it', () => {
    const r = new ReplayReassembler();
    r.push(b(4, 9, [5]));
    r.push(b(22, 27, [24]));
    expect(r.start(16)).toEqual([]);
    expect(r.waiting()).toBe(1);
    expect(r.push(b(10, 15, [12]))).toEqual([]);
    expect(r.push(b(16, 21))).toEqual([b(16, 21), b(22, 27, [24])]);
    expect(r.covered()).toBe(28);
  });

  it('takes the start once: a later save state (a re-sync) lands on a stream already in order', () => {
    const r = new ReplayReassembler();
    r.push(b(10, 15));
    expect(r.start(10)).toEqual([b(10, 15)]);
    expect(r.start(40)).toEqual([]);
    expect(r.covered()).toBe(16);
    expect(r.push(b(16, 21))).toEqual([b(16, 21)]);
  });
});

describe('the drift ledger', () => {
  it('pairs hashes by frame and counts the first mismatch', () => {
    const l = new DriftLedger();
    l.sourceHash(60, 'a:1');
    l.sourceHash(120, 'b:1');
    l.sourceHash(180, 'c:1');
    expect(l.followerHash(60, 'a:1')).toBe(true);
    expect(l.followerHash(120, 'x:1')).toBe(false);
    expect(l.followerHash(180, 'c:1')).toBe(true);
    expect(l.read()).toEqual({ compared: 3, matched: 2, mismatched: 1, firstMismatch: 120, lastCompared: 180 });
  });

  it('drops a follower hash with nothing to meet, and forgets source hashes it has passed', () => {
    const l = new DriftLedger();
    expect(l.followerHash(60, 'a:1')).toBeNull();
    l.sourceHash(60, 'a:1');
    l.sourceHash(120, 'b:1');
    expect(l.followerHash(120, 'b:1')).toBe(true);
    expect(l.followerHash(60, 'a:1')).toBeNull(); // passed over, gone
    expect(l.read().compared).toBe(1);
  });

  it('keeps a bounded number of source hashes waiting', () => {
    const l = new DriftLedger(2);
    l.sourceHash(1, 'a:1');
    l.sourceHash(2, 'b:1');
    l.sourceHash(3, 'c:1');
    expect(l.followerHash(1, 'a:1')).toBeNull();
    expect(l.followerHash(2, 'b:1')).toBe(true);
  });
});
