/**
 * 🕹🕹🕹🕹 arcadeLockstep — the double-wide cabinet's players in step, page
 * against page: each page its own Y.Doc (the room's updates relayed between
 * them, late), its own controller, and a stand-in for its emulator frame
 * that keeps frame.html's lockstep protocol (role 'peer') over a toy core
 * whose state is a hash of every button it was ever given, frame by frame.
 * Seats that run the same frames on the same buttons hash alike; any slip
 * (a button a frame late, a load in the wrong place) shows as a mismatch.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { EmulatorEvent } from './arcadeEmulator';
import {
  lockstepChunkKey, lockstepEpochKey, lockstepLaneKey, readEpoch, readLane, LockstepController,
  EXCLUDE_MS, JOIN_MS, LANE_LAPSE_MS, LOCKSTEP_DELAY,
} from './arcadeLockstep';
import type { LockstepView } from './arcadeLockstep';
import { packInputBatch, replayStateHash } from './arcadeReplay';
import type { ReplayInput } from './arcadeReplay';

const CAB = 'arcade-cabinet-wide-1';
const GAME = 'nes:file:lj65.nes:40976@station';

// ── A stand-in for frame.html's peer role ────────────────────────────────────

type Row = [number, number, number, number];
const fnv = (h: number, x: number) => Math.imul(h ^ x, 0x01000193) >>> 0;

class FakeFrame {
  /** The toy core: a frame counter, a state, and its input array. */
  frameNum = 0;
  state = 0x51f15e;
  private input = new Map<string, number>();
  private loadInPlace: Uint8Array | null = null;
  /** A hidden tab (no frames run) or a frame that never loads a state. */
  frozen = false;
  brokenLoads = false;
  phase: 'waiting' | 'free' | 'loading' | 'lockstep' | 'stalled' = 'waiting';
  nonce = '';
  private active: number[] = [];
  private start = 0;
  private queue = new Map<number, Map<number, Array<[number, number, number]>>>();
  private thru = new Map<number, number>();
  private offset = 0;
  private snap: { frame: number; state: Uint8Array; held: Array<[number, number, number]>; hash: string } | null = null;
  private loadTries = 0;
  private settling = false;
  private pending: Row[] = [];
  private nextFrom = 0;
  private lastBatch = 0;
  private wantBegin: { nonce: string; seats: number[] } | null = null;
  private down = new Map<string, [number, number, number]>();
  private lastAt = new Map<number, number>();
  private lastStatus = -Infinity;
  stalls = 0;

  constructor(
    readonly seat: number,
    private readonly emit: (ev: EmulatorEvent) => void,
    private readonly now: () => number,
    private readonly delay = LOCKSTEP_DELAY,
    private readonly batchFrames = 3,
    private readonly hashEvery = 60,
  ) {}

  at(): number { return this.frameNum + this.offset; }
  bytes(): Uint8Array {
    const b = new Uint8Array(64);
    new DataView(b.buffer).setUint32(0, this.state);
    return b;
  }
  hash(): string { return replayStateHash(this.bytes()); }
  private apply(p: number, i: number, v: number): void {
    if (v !== 0) this.input.set(`${p}:${i}`, v);
    else this.input.delete(`${p}:${i}`);
  }
  private feed(p: number, i: number, v: number): void {
    if (v !== 0) this.down.set(`${p}:${i}`, [p, i, v]);
    else this.down.delete(`${p}:${i}`);
    this.apply(p, i, v);
  }
  private runFrame(): void {
    let h = this.state;
    for (const [k, v] of [...this.input.entries()].sort()) {
      for (const c of k) h = fnv(h, c.charCodeAt(0));
      h = fnv(h, v & 0xffff);
    }
    this.state = fnv(h, 0x9e);
    this.frameNum += 1;
  }
  private status(extra: Record<string, unknown> = {}): void {
    let others = Infinity;
    for (const k of this.active) if (k !== this.seat) others = Math.min(others, this.thru.get(k)!);
    this.emit({ type: 'replay-status', status: { nonce: this.nonce, phase: this.phase, frame: this.at(), through: others === Infinity ? -1 : others, stalls: this.stalls, ...extra } });
  }
  private enqueue(k: number, row: Row): void {
    if (row[0] < this.start) return;
    let bySeat = this.queue.get(row[0]);
    if (!bySeat) this.queue.set(row[0], (bySeat = new Map()));
    const rows = bySeat.get(k) ?? [];
    rows.push([row[1], row[2], row[3]]);
    bySeat.set(k, rows);
  }
  private enter(tag: string, seats: number[], from: number): void {
    this.nonce = tag;
    this.active = seats.slice();
    this.start = from;
    this.queue.clear();
    this.thru.clear();
    for (const k of seats) this.thru.set(k, from - 1);
    this.pending = [];
    this.nextFrom = from;
    this.lastBatch = from;
    this.lastAt.clear();
    this.settling = false;
  }
  private flush(): void {
    const through = this.at() + this.delay - 1;
    if (through < this.nextFrom) return;
    const out = this.pending.filter((r) => r[0] <= through);
    this.pending = this.pending.filter((r) => r[0] > through);
    const inputs: ReplayInput[] = out.map((r) => ({ frame: r[0], player: r[1], index: r[2], value: r[3] }));
    this.emit({ type: 'replay-inputs', nonce: this.nonce, batch: { from: this.nextFrom, through, inputs } });
    this.nextFrom = through + 1;
    this.lastBatch = this.at();
  }
  private begin(): void {
    const b = this.wantBegin!;
    this.wantBegin = null;
    for (const d of [...this.down.values()]) if (!b.seats.includes(d[0])) this.feed(d[0], d[1], 0);
    if (b.seats.length < 2) {
      this.enter(b.nonce, [this.seat], this.at());
      this.phase = 'free';
      this.status();
      return;
    }
    const st = this.bytes();
    const held = [...this.down.values()].map((d) => [d[0], d[1], d[2]] as [number, number, number]);
    this.enter(b.nonce, b.seats, this.at());
    this.phase = 'lockstep';
    this.emit({ type: 'replay-snapshot', nonce: this.nonce, snapshot: { frame: this.start, state: st, held, hash: replayStateHash(st) } });
    this.status();
  }
  private land(h: string): void {
    const snap = this.snap!;
    this.offset = snap.frame - this.frameNum;
    for (const [k, d] of [...this.down.entries()]) if (!snap.held.some((r) => `${r[0]}:${r[1]}` === k)) this.feed(d[0], d[1], 0);
    for (const r of snap.held) this.feed(r[0], r[1], r[2]);
    this.nextFrom = this.start;
    this.lastBatch = this.start;
    this.pending = [];
    this.lastAt.clear();
    this.phase = 'stalled';
    this.settling = true;
    this.status({ loaded: snap.frame, hash: h, matches: true, tries: this.loadTries });
  }
  /** The local player's button (EmulatorJS's input, played as this seat). */
  press(i: number, v: number): void {
    if (this.phase === 'free') return this.feed(this.seat, i, v);
    if (this.phase !== 'lockstep' && this.phase !== 'stalled') return;
    let f = this.at() + this.delay;
    if (i < 16) {
      const last = this.lastAt.get(i);
      if (last !== undefined && f <= last) f = last + 1;
      this.lastAt.set(i, f);
    }
    const row: Row = [f, this.seat, i, v];
    this.pending.push(row);
    this.enqueue(this.seat, row);
  }
  private pre(): boolean {
    if (this.phase === 'loading') {
      const h = this.hash();
      if (h !== this.snap!.hash) return true;
      this.land(h);
    }
    if (this.wantBegin) this.begin();
    if (this.phase === 'free') return true;
    if (this.phase === 'waiting') return false;
    const s = this.at();
    for (const k of this.active) {
      if (k === this.seat || this.thru.get(k)! >= s) continue;
      if (this.phase !== 'stalled') {
        this.phase = 'stalled';
        this.stalls += 1;
      }
      this.flush();
      if (this.now() - this.lastStatus > 1000) {
        this.lastStatus = this.now();
        this.status();
      }
      return false;
    }
    this.phase = 'lockstep';
    const bySeat = this.queue.get(s);
    if (bySeat) {
      for (const k of this.active) for (const r of bySeat.get(k) ?? []) this.feed(r[0], r[1], r[2]);
      this.queue.delete(s);
    }
    return true;
  }
  private post(): void {
    if (this.phase === 'loading') {
      this.loadTries += 1;
      const h = this.hash();
      if (h === this.snap!.hash) this.land(h);
      else if (this.loadTries >= 240) {
        this.phase = 'waiting';
        this.status({ loaded: this.snap!.frame, hash: h, matches: false, tries: this.loadTries });
      }
      return;
    }
    if (this.phase === 'free') return;
    if (this.phase !== 'lockstep' && this.phase !== 'stalled') return;
    if (this.settling) {
      if (this.hash() === this.snap!.hash) this.offset = this.start - this.frameNum;
      else this.settling = false;
    }
    const s = this.at();
    if (this.pending.length > 0 || s - this.lastBatch >= this.batchFrames) this.flush();
    if (s % this.hashEvery === 0) this.emit({ type: 'replay-hash', nonce: this.nonce, hash: { frame: s, hash: this.hash() } });
    if (this.now() - this.lastStatus > 1000) {
      this.lastStatus = this.now();
      this.status();
    }
  }
  /** One main-loop iteration (a sixtieth of a second). */
  iterate(): void {
    if (this.frozen) return;
    if (this.loadInPlace) {
      // A load is in place by the next pre-hook (measured on fceumm).
      if (!this.brokenLoads) this.state = new DataView(this.loadInPlace.buffer).getUint32(0);
      this.loadInPlace = null;
    }
    if (!this.pre()) return;
    this.runFrame();
    this.post();
  }
  /** The page's messages, as frame.html checks them. */
  receive(m: Record<string, unknown>): void {
    const seats = (v: unknown) => (Array.isArray(v) && v.includes(this.seat) ? (v as number[]).slice().sort((a, b) => a - b) : null);
    if (m.type === 'arcade-replay-begin') {
      const list = seats(m.seats);
      if (list) this.wantBegin = { nonce: m.nonce as string, seats: list };
    } else if (m.type === 'arcade-replay-snapshot') {
      const list = seats(m.seats);
      if (!list || (m.nonce === this.nonce && this.phase !== 'waiting')) return;
      this.wantBegin = null;
      this.snap = { frame: m.frame as number, state: m.state as Uint8Array, held: m.held as Array<[number, number, number]>, hash: m.hash as string };
      this.loadTries = 0;
      this.enter(m.nonce as string, list, m.frame as number);
      this.loadInPlace = m.state as Uint8Array;
      this.phase = 'loading';
    } else if (m.type === 'arcade-replay-inputs') {
      const k = m.seat as number;
      if (m.nonce !== this.nonce || k === this.seat || !this.active.includes(k)) return;
      const have = this.thru.get(k)!;
      if ((m.from as number) > have + 1) return;
      for (const row of m.inputs as Row[]) if (row[1] === k && row[0] > have && row[0] <= (m.through as number)) this.enqueue(k, row);
      if ((m.through as number) > have) this.thru.set(k, m.through as number);
    }
  }
}

// ── The room: pages, docs relayed late, a clock ─────────────────────────────

interface Page {
  id: string;
  seat: number;
  doc: Y.Doc;
  map: Y.Map<unknown>;
  frame: FakeFrame;
  ctl: LockstepController;
  visible: boolean;
  toFrame: Array<Record<string, unknown>>;
  toPage: EmulatorEvent[];
  hashes: Array<{ nonce: string; frame: number; hash: string }>;
  fresh: number;
  /** Epochs of more than one seat this page began. */
  begins: number;
}

class Room {
  now = 1_000_000;
  latencyMs = 30;
  pages: Page[] = [];
  /** Which page's write the doc keeps when two write one key at once goes
   *  by the docs' client ids: set here, so a run is the same every time
   *  (1: the later page's; -1: the earlier page's). */
  constructor(private readonly order: 1 | -1 = 1) {}
  /** Who holds each seat (arcadeDoc's leases, as every page sees them). */
  leases = new Map<number, string>();
  private wire: Array<{ at: number; from: Page; update: Uint8Array }> = [];
  private nextTick = 0;
  private added = 0;

  add(id: string, seat: number): Page {
    const doc = new Y.Doc();
    doc.clientID = 1_000 + this.order * (this.added += 1);
    const first = this.pages.find((p) => p.doc);
    if (first) Y.applyUpdate(doc, Y.encodeStateAsUpdate(first.doc), 'remote');
    const map = doc.getMap<unknown>('arcade');
    let tags = 0;
    const page: Page = {
      id, seat, doc, map, visible: true, toFrame: [], toPage: [], hashes: [], fresh: 0, begins: 0,
      frame: null as unknown as FakeFrame, ctl: null as unknown as LockstepController,
    };
    page.frame = new FakeFrame(seat, (ev) => page.toPage.push(ev), () => this.now);
    page.ctl = new LockstepController({
      itemId: CAB, seat, seats: 4, game: GAME, page: id,
      store: {
        get: (k) => map.get(k),
        set: (entries) => doc.transact(() => { for (const [k, v] of entries) if (v === undefined) map.delete(k); else map.set(k, v); }),
        delete: (keys) => doc.transact(() => { for (const k of keys) map.delete(k); }),
        keys: (prefix, max) => [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, max),
      },
      send: (m) => page.toFrame.push(m),
      seatPage: (n) => this.leases.get(n) ?? null,
      visible: () => page.visible,
      now: () => this.now,
      newTag: () => `${id}${++tags}`,
      onFreshGame: () => { page.fresh += 1; },
      // The page's streams finish in their own time; these at once, so a
      // run of the room is the same run every time.
      pack: async (b) => new Uint8Array(deflateRawSync(b)),
      unpack: async (b, raw) => new Uint8Array(inflateRawSync(b, { maxOutputLength: Math.max(1, raw) })),
    });
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') this.wire.push({ at: this.now + this.latencyMs, from: page, update });
    });
    map.observe(() => page.ctl.onDoc());
    this.leases.set(seat, id);
    this.pages.push(page);
    // The emulator comes up: frame.html says 'started' once its replay
    // role is set (held, waiting).
    page.toPage.push({ type: 'started' });
    return page;
  }

  /** The player stands up: the lease goes, the stage closes. */
  remove(page: Page): void {
    page.ctl.dispose();
    this.leases.delete(page.seat);
    this.pages = this.pages.filter((p) => p !== page);
  }

  private deliver(): void {
    const due = this.wire.filter((w) => w.at <= this.now);
    this.wire = this.wire.filter((w) => w.at > this.now);
    for (const w of due) for (const p of this.pages) if (p !== w.from) Y.applyUpdate(p.doc, w.update, 'remote');
  }

  private pump(p: Page): void {
    while (p.toPage.length > 0 || p.toFrame.length > 0) {
      for (const ev of p.toPage.splice(0)) {
        if (ev.type === 'replay-hash' && ev.nonce) p.hashes.push({ nonce: ev.nonce, frame: ev.hash.frame, hash: ev.hash.hash });
        p.ctl.onFrameEvent(ev);
      }
      for (const m of p.toFrame.splice(0)) {
        if (m.type === 'arcade-replay-begin' && Array.isArray(m.seats) && m.seats.length > 1) p.begins += 1;
        p.frame.receive(m);
      }
    }
  }

  /** Run the room for `ms`: a frame a sixtieth, the stage's tick every 50 ms. */
  async run(ms: number, each?: (t: number) => void): Promise<void> {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += 1000 / 60;
      this.deliver();
      for (const p of this.pages) {
        p.frame.iterate();
        this.pump(p);
      }
      if (this.now >= this.nextTick) {
        this.nextTick = this.now + 50;
        for (const p of this.pages) {
          p.ctl.tick();
          this.pump(p);
        }
      }
      each?.(this.now);
      // A state deflated or inflated (settled at once) is handled now.
      await new Promise((r) => setImmediate(r));
      for (const p of this.pages) this.pump(p);
    }
  }

  /** Every pair of seats' hashes at the same frame of the same epoch. */
  compare(): { compared: number; mismatched: number } {
    const at = new Map<string, Set<string>>();
    for (const p of this.pages) for (const h of p.hashes) {
      const k = `${h.nonce}@${h.frame}`;
      at.set(k, (at.get(k) ?? new Set()).add(h.hash));
    }
    let compared = 0;
    let mismatched = 0;
    for (const [k, set] of at) {
      const seen = this.pages.filter((p) => p.hashes.some((h) => `${h.nonce}@${h.frame}` === k)).length;
      if (seen < 2) continue;
      compared += 1;
      if (set.size > 1) mismatched += 1;
    }
    return { compared, mismatched };
  }
}

/** Presses on a page's pad, now and then, as a player would. */
function bot(page: Page, seed: number): (t: number) => void {
  let s = seed;
  let next = 0;
  const held = new Set<number>();
  return (t) => {
    if (t < next) return;
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const i = [0, 4, 5, 6, 7, 8][s % 6]!;
    if (held.has(i)) {
      held.delete(i);
      page.frame.press(i, 0);
    } else {
      held.add(i);
      page.frame.press(i, 1);
    }
    next = t + 40 + (s % 400);
  };
}

const allOf = (...fns: Array<(t: number) => void>) => (t: number) => { for (const f of fns) f(t); };
const view = (p: Page): LockstepView => p.ctl.view();

describe('records as a peer may have written them', () => {
  it('a lane speaks for its own seat\'s buttons, in its shape, or is nothing', () => {
    const rows = packInputBatch({ from: 100, through: 110, inputs: [{ frame: 104, player: 2, index: 8, value: 1 }] });
    const lane = { v: 1, page: 'pa', game: GAME, nonce: 'pa3', phase: 'lockstep', ran: 103, rows, hash: 'd5d7dc6e:13752', hashFrame: 60, bad: false, beat: 7 };
    expect(readLane(lane, 2)).toEqual({
      page: 'pa', game: GAME, nonce: 'pa3', phase: 'lockstep', ran: 103, from: 100, through: 110,
      inputs: [{ frame: 104, player: 2, index: 8, value: 1 }], hash: 'd5d7dc6e:13752', hashFrame: 60, bad: false, beat: 7,
    });
    expect(readLane(lane, 1)).toBeNull(); // another seat's buttons
    expect(readLane({ ...lane, rows: undefined }, 2)).toMatchObject({ from: 0, through: -1, inputs: [] });
    for (const bad of [
      { ...lane, v: 2 }, { ...lane, page: '' }, { ...lane, nonce: 'E3' }, { ...lane, phase: 'dancing' },
      { ...lane, ran: -1 }, { ...lane, hash: '<b>' }, { ...lane, rows: [1, 2] }, { ...lane, rows: new Uint8Array(3) },
      { ...lane, beat: 1.5 }, null, 'lane', [lane],
    ]) expect(readLane(bad, 2)).toBeNull();
  });

  it('an epoch names its seats, its leading seat among them, and a state in pieces that add up', () => {
    const e = { v: 1, nonce: 'pa4', game: GAME, anchor: 1, seats: [0, 1, 3], frame: 900, hash: 'abc:13752', held: [[1, 8, 1]], raw: 13_752, size: 4_000, chunks: 1, page: 'pb' };
    expect(readEpoch(e, 4)).toEqual({
      nonce: 'pa4', game: GAME, anchor: 1, seats: [0, 1, 3], frame: 900, hash: 'abc:13752', held: [[1, 8, 1]], raw: 13_752, size: 4_000, chunks: 1, page: 'pb',
    });
    const alone = { ...e, seats: [1], hash: '', held: [], raw: 0, size: 0, chunks: 0 };
    expect(readEpoch(alone, 4)?.seats).toEqual([1]);
    for (const bad of [
      { ...e, seats: [1, 0, 3] }, { ...e, seats: [0, 0, 1] }, { ...e, seats: [0, 1, 4] }, { ...e, anchor: 2 },
      { ...e, chunks: 0 }, { ...e, size: 70_000 }, { ...e, hash: 'abc:99' }, { ...e, held: [[4, 8, 1]] },
      { ...e, nonce: '' }, { ...alone, chunks: 1 }, { ...e, seats: [0, 1, 2, 3, 0] },
    ]) expect(readEpoch(bad, 4)).toBeNull();
    expect(readEpoch({ ...e, seats: [0, 1, 3] }, 2)).toBeNull(); // past a two-seat cabinet's seats
  });
});

describe('players at the double-wide cabinet, page against page', () => {
  it('the first plays alone at once; the second joins that game, and both run the same frames on the same buttons', async () => {
    const room = new Room();
    const a = room.add('pa', 0);
    await room.run(1_000);
    expect(view(a).phase).toBe('alone');
    expect(a.frame.phase).toBe('free');
    expect(a.fresh).toBe(1); // a game began here from scratch
    const b = room.add('pb', 2);
    await room.run(3_000, allOf(bot(a, 1)));
    expect(a.frame.nonce).toBe(b.frame.nonce);
    expect(view(a)).toMatchObject({ phase: 'playing', players: [0, 2], anchor: 0 });
    expect(view(b)).toMatchObject({ phase: 'playing', players: [0, 2], anchor: 0 });
    await room.run(20_000, allOf(bot(a, 1), bot(b, 2)));
    const c = room.compare();
    expect(c.mismatched).toBe(0);
    expect(c.compared).toBeGreaterThan(15);
    expect(Math.abs(a.frame.at() - b.frame.at())).toBeLessThanOrEqual(LOCKSTEP_DELAY + 1);
    expect(b.fresh).toBe(0);
  });

  it('a third and a fourth sit down: each is a new epoch the others load, and all four play on in step', async () => {
    const room = new Room();
    const pages = [room.add('pa', 0), room.add('pb', 1)];
    const bots = () => allOf(...pages.map((p, n) => bot(p, n + 11)));
    await room.run(4_000, bots());
    pages.push(room.add('pc', 2));
    await room.run(4_000, bots());
    pages.push(room.add('pd', 3));
    await room.run(15_000, bots());
    const nonce = pages[0]!.frame.nonce;
    for (const p of pages) {
      expect(p.frame.nonce).toBe(nonce);
      expect(view(p)).toMatchObject({ phase: 'playing', players: [0, 1, 2, 3] });
    }
    // Only the seat that leads began a game, once for each seat that sat
    // down; and with the room's updates 30 ms on the way, nobody's game
    // held for a single frame in the last ten seconds.
    expect(pages.map((p) => p.begins).sort()).toEqual([0, 0, 0, 3]);
    const at = pages.map((p) => [p.frame.at(), p.frame.stalls]);
    await room.run(10_000, bots());
    pages.forEach((p, i) => {
      expect(p.frame.at() - at[i]![0]!).toBeGreaterThanOrEqual(599);
      expect(p.frame.stalls - at[i]![1]!).toBe(0);
    });
    const c = room.compare();
    expect(c.mismatched).toBe(0);
    expect(c.compared).toBeGreaterThan(20);
  });

  for (const order of [1, -1] as const) {
    it(`a player who stands up leaves the others playing; the leading seat standing up hands the lead on (${order})`, async () => {
      const room = new Room(order);
      const [a, b, c] = [room.add('pa', 0), room.add('pb', 1), room.add('pc', 3)];
      await room.run(6_000, allOf(bot(a, 1), bot(b, 2), bot(c, 3)));
      expect(view(c).players).toEqual([0, 1, 3]);
      room.remove(b);
      await room.run(6_000, allOf(bot(a, 1), bot(c, 3)));
      const anchor = view(a).anchor;
      expect(anchor === 0 || anchor === 3).toBe(true);
      for (const p of [a, c]) expect(view(p)).toMatchObject({ phase: 'playing', players: [0, 3], anchor });
      // The seat whose state the game began from stands up.
      const [leaving, staying] = anchor === 0 ? [a, c] : [c, a];
      room.remove(leaving);
      await room.run(4_000, bot(staying, 3));
      expect(view(staying)).toMatchObject({ phase: 'alone', players: [staying.seat], anchor: staying.seat });
      expect(staying.map.get(lockstepLaneKey(CAB, leaving.seat))).toBeUndefined();
      expect(room.compare().mismatched).toBe(0);
    });
  }

  it('a page in the background steps out, and comes back in', async () => {
    const room = new Room();
    const [a, b, c] = [room.add('pa', 0), room.add('pb', 1), room.add('pc', 2)];
    await room.run(6_000);
    b.visible = false;
    b.frame.frozen = true;
    await room.run(4_000, allOf(bot(a, 1), bot(c, 3)));
    expect(view(a)).toMatchObject({ phase: 'playing', players: [0, 2] });
    const before = a.frame.at();
    await room.run(2_000);
    expect(a.frame.at()).toBeGreaterThan(before + 100); // the others play on without it
    b.visible = true;
    b.frame.frozen = false;
    await room.run(6_000, allOf(bot(a, 1), bot(b, 2), bot(c, 3)));
    for (const p of [a, b, c]) expect(view(p)).toMatchObject({ phase: 'playing', players: [0, 1, 2] });
    expect(room.compare().mismatched).toBe(0);
  });

  it('a seat whose frame never loads the game is left out for a while, and the others play on', async () => {
    const room = new Room();
    const a = room.add('pa', 0);
    await room.run(2_000);
    const b = room.add('pb', 1);
    b.frame.brokenLoads = true; // its loads never land
    await room.run(JOIN_MS + 4_000, bot(a, 1));
    expect(view(a)).toMatchObject({ phase: 'alone', players: [0] });
    const at = a.frame.at();
    await room.run(2_000, bot(a, 1));
    expect(a.frame.at()).toBeGreaterThan(at + 100);
    // Fixed, it is let back in once its time out is up.
    b.frame.brokenLoads = false;
    await room.run(EXCLUDE_MS + 6_000, bot(a, 1));
    expect(view(a)).toMatchObject({ phase: 'playing', players: [0, 1] });
    expect(view(b)).toMatchObject({ phase: 'playing', players: [0, 1] });
  });

  it('two seats that begin at once end in one game', async () => {
    const room = new Room();
    room.latencyMs = 400; // neither hears the other before it begins
    const a = room.add('pa', 0);
    const b = room.add('pb', 1);
    await room.run(8_000, allOf(bot(a, 1), bot(b, 2)));
    expect(a.frame.nonce).toBe(b.frame.nonce);
    expect(view(a).players).toEqual([0, 1]);
    await room.run(10_000, allOf(bot(a, 1), bot(b, 2)));
    expect(room.compare().mismatched).toBe(0);
  });

  it('two states that disagree begin the game again from the leading seat\'s', async () => {
    const room = new Room();
    const [a, b] = [room.add('pa', 0), room.add('pb', 1)];
    await room.run(5_000, allOf(bot(a, 1), bot(b, 2)));
    const nonce = a.frame.nonce;
    b.frame.state ^= 0x40; // a slip: b's game is not a's any more
    await room.run(8_000, allOf(bot(a, 1), bot(b, 2)));
    expect(a.frame.nonce).not.toBe(nonce);
    expect(b.frame.nonce).toBe(a.frame.nonce);
    const fresh = a.hashes.filter((h) => h.nonce === a.frame.nonce);
    expect(fresh.length).toBeGreaterThan(2);
    for (const h of fresh) {
      const theirs = b.hashes.find((x) => x.nonce === h.nonce && x.frame === h.frame);
      if (theirs) expect(theirs.hash).toBe(h.hash);
    }
  });

  it('a lane that goes quiet is a seat gone, though its lease holds', async () => {
    const room = new Room();
    const [a, b] = [room.add('pa', 0), room.add('pb', 1)];
    await room.run(5_000);
    // b's page hangs: no frames, no ticks, no writes (its lease is still held).
    room.pages = room.pages.filter((p) => p !== b);
    await room.run(LANE_LAPSE_MS + 3_000, bot(a, 1));
    expect(view(a)).toMatchObject({ phase: 'alone', players: [0] });
  });

  it('the epoch\'s state goes into the doc in pieces with the record, and an earlier epoch\'s pieces go', async () => {
    const room = new Room();
    const [a] = [room.add('pa', 0), room.add('pb', 1)];
    await room.run(4_000);
    const e = readEpoch(a.map.get(lockstepEpochKey(CAB)), 4)!;
    expect(e.seats).toEqual([0, 1]);
    expect(e.chunks).toBe(1);
    expect(a.map.get(lockstepChunkKey(CAB, e.nonce, 0))).toBeInstanceOf(Uint8Array);
    room.add('pc', 2);
    await room.run(4_000);
    const next = readEpoch(a.map.get(lockstepEpochKey(CAB)), 4)!;
    expect(next.nonce).not.toBe(e.nonce);
    expect(a.map.get(lockstepChunkKey(CAB, e.nonce, 0))).toBeUndefined();
    expect([...a.map.keys()].filter((k) => k.startsWith('lsc:'))).toEqual([lockstepChunkKey(CAB, next.nonce, 0)]);
  });
});
