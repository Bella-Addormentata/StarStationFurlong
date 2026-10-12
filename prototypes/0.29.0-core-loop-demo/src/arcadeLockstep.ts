/**
 * 🕹🕹🕹🕹 arcadeLockstep — the double-wide cabinet's players, each running
 * the game in their own page, in step (#242).
 *
 * Every seated player's page runs the same core on the same game in an
 * emulator frame of role 'peer' (public/arcade/frame.html): its own
 * player's buttons land LOCKSTEP_DELAY frames late, and it runs a frame
 * only once every other seat's buttons for that frame are in hand, so
 * every seat applies the same buttons at the same frames and shows the
 * same game. This module is the page's side, DOM-free so it can be tested:
 * it carries each seat's buttons to the others through the room, and it
 * decides which seat begins a game in step, with whom, and when.
 *
 * THE LANE IS THE ROOM DOC, beside the seats (arcadeDoc's raw keys):
 *   ls:<itemId>:<n>         → seat n's LANE, its page's alone: the game it
 *                             runs, the epoch it is in, its buttons from the
 *                             oldest frame another seat may still need, how
 *                             far it has run, its latest state hash
 *   ls:<itemId>             → the EPOCH, written by the seat that began it:
 *                             its tag, its seats, the frame it began at, and
 *                             the size and hash of the state it began from
 *   lsc:<itemId>:<tag>:<i>  → that state, deflated, in pieces
 * The doc reaches every page in the room (sibling tabs on one node, and the
 * nodes the room meshes with), signed, but not always in order: the node
 * relays each update on a stream of its own, so a key can read missing for
 * a moment (LockstepDeps.seatPage). A lane and an epoch name their game by
 * a short tag of the stage's mount key (lockstepGameTag): the key holds a
 * link of up to 2 KB, and a lane is written every 40 ms. A lane carries a
 * WINDOW of buttons rather than the newest few, because a key holds only
 * its latest value and a page may hear two writes as one: a page hands its
 * frame only what it has not, and the window starts no earlier than the
 * oldest frame a seat in the epoch has yet to run.
 *
 * AN EPOCH is a game in step: a save state, the seats that start from it,
 * and a tag every message of it carries. One seat begins it (its frame
 * saves its state), the others load that state and join. Alone, a seat's
 * game is an epoch of one, played at once with no delay. Whenever the
 * seats that should play are not the epoch's (a player sat down, stood up,
 * or went quiet), or the game has held too long, or two seats' states
 * disagree, a new epoch begins from where the game stands and the others
 * load it again: a pause of about a second.
 *
 * WHO BEGINS is computed by every page from the doc alone, so they agree:
 * the epoch's own seat while it plays on; else the lowest seat still in
 * the epoch; else the lowest seat with a game running (alone); else the
 * lowest seat ready. Two pages that begin at once both write the epoch;
 * the doc keeps one, and the other's seat loads it.
 *
 * A SEAT IS IN while its page holds the seat (arcadeDoc's lease), its lane
 * has changed within LANE_LAPSE_MS as THIS page saw it (a lane beats every
 * LANE_BEAT_MS), it runs the same game, and its page is on screen: a tab
 * in the background runs no frames, so it steps out until it is back. A
 * seat that cannot keep up (its join never lands, or the game keeps
 * holding for it) is left out for EXCLUDE_MS by the seat that leads.
 *
 * ENFORCEMENT POSTURE: a peer running edited code can send its own seat's
 * buttons and a state of its own making, as any player can press buttons.
 * Every read is shape-checked; a lane speaks for its own seat only (the
 * frame checks the rows' player again), and a state that does not hash as
 * its epoch says is not loaded.
 */

import { isEpochTag } from './arcadeEmulator';
import type { EmulatorEvent, ReplayStatus } from './arcadeEmulator';
import { pipe } from './arcadeNet';
import {
  isReplayInput, isReplayStateHash, packInputBatch, replayStateHash, unpackInputBatch,
  REPLAY_MAX_BATCH_INPUTS, REPLAY_MAX_STATE_BYTES,
} from './arcadeReplay';
import type { ReplayInput, ReplaySnapshot } from './arcadeReplay';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** A player's buttons land this many frames late in step (133 ms). */
export const LOCKSTEP_DELAY = 8;
/** The frame posts its player's buttons at least every this many frames. */
export const LOCKSTEP_BATCH_FRAMES = 3;
/** A lane is written at most this often: each write is a signed update to
 *  every page in the room. Under the frame's batches (every 50 ms, or every
 *  frame while buttons change), so a batch goes out as it comes. */
export const LANE_WRITE_MS = 40;
/** …and at least this often, so the room knows the seat is still there. */
export const LANE_BEAT_MS = 2_000;
/** A lane not changed for this long, as this page saw it, is gone. */
export const LANE_LAPSE_MS = 6_000;
/** A seat not in an epoch this long after it began is left out… */
export const JOIN_MS = 10_000;
/** …of the epochs begun for this long. */
export const EXCLUDE_MS = 20_000;
/** The game held this long: the seat that leads begins again. */
export const STALL_MS = 5_000;
/** Between two begins by one page, at least this long; a begin waits this
 *  long at most for its frame's save state. */
export const BEGIN_MIN_MS = 1_500;
export const BEGIN_WAIT_MS = 5_000;
/** A save state goes into the doc in pieces this size, this many at most
 *  (4 MB deflated: NES and SNES states are tens of kilobytes). */
export const STATE_CHUNK_BYTES = 64 * 1024;
export const STATE_MAX_CHUNKS = 64;
/** The most frames of buttons a lane carries back (20 s): a seat further
 *  behind than that loads the game again. */
export const WINDOW_MAX_FRAMES = 1_200;
/** This seat's own hashes kept to compare with the others' (a minute's). */
const OWN_HASHES = 64;

// ── Keys ─────────────────────────────────────────────────────────────────────

export const lockstepEpochKey = (itemId: string): string => `ls:${itemId}`;
export const lockstepLaneKey = (itemId: string, seat: number): string => `ls:${itemId}:${seat}`;
export const lockstepChunkPrefix = (itemId: string): string => `lsc:${itemId}:`;
export const lockstepChunkKey = (itemId: string, nonce: string, i: number): string => `lsc:${itemId}:${nonce}:${i}`;

/** What a lane and an epoch call the game every seat must run: a tag of the
 *  stage's mount key (the game and the emulator files), short whatever the
 *  key's length (a link of up to ARCADE_MAX_URL, 2 KB). */
export function lockstepGameTag(key: string): string {
  return replayStateHash(new TextEncoder().encode(key));
}
const GAME_TAG_MAX = 64;

// ── Records, as a peer may have written them ─────────────────────────────────

/** Where a seat stands: booted with no game yet, playing alone, loading an
 *  epoch, in step, or away (its tab hidden, or its core cannot play in
 *  step). */
export type LanePhase = 'ready' | 'free' | 'loading' | 'lockstep' | 'away';
const LANE_PHASES: ReadonlySet<string> = new Set<LanePhase>(['ready', 'free', 'loading', 'lockstep', 'away']);

export interface Lane {
  page: string;
  game: string;
  /** The epoch it is in or joining ('' before its first). */
  nonce: string;
  phase: LanePhase;
  /** The frame its game has run to in that epoch: it needs nobody's
   *  buttons from before it. */
  ran: number;
  /** Its buttons: every one at or before `through` is known, and those
   *  from `from` on are here (`through` < `from`: none yet). */
  from: number;
  through: number;
  inputs: ReplayInput[];
  /** Its latest state hash in the epoch ('' none yet), and the frame of it. */
  hash: string;
  hashFrame: number;
  /** It saw another seat's state differ from its own in the epoch. */
  bad: boolean;
  /** Counts its writes: a lane that stops changing has gone. */
  beat: number;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const shortString = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Seat `seat`'s lane, or null for anything out of shape. */
export function readLane(raw: unknown, seat: number): Lane | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const page = shortString(r.page, 32);
  const game = shortString(r.game, GAME_TAG_MAX);
  if (r.v !== 1 || !page || game === null || !isEpochTag(r.nonce)) return null;
  if (typeof r.phase !== 'string' || !LANE_PHASES.has(r.phase)) return null;
  if (!isInt(r.ran, 0, 0xffff_ffff) || !isInt(r.hashFrame, -1, 0xffff_ffff) || !isInt(r.beat, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (r.hash !== '' && !isReplayStateHash(r.hash)) return null;
  let from = 0;
  let through = -1;
  let inputs: ReplayInput[] = [];
  if (r.rows !== undefined) {
    if (!(r.rows instanceof Uint8Array)) return null;
    const batch = unpackInputBatch(r.rows);
    // A lane speaks for its own seat's buttons, and no other's.
    if (!batch || batch.inputs.some((i) => i.player !== seat)) return null;
    ({ from, through, inputs } = batch);
  }
  return {
    page, game, nonce: r.nonce, phase: r.phase as LanePhase, ran: r.ran, from, through, inputs,
    hash: r.hash as string, hashFrame: r.hashFrame, bad: r.bad === true, beat: r.beat,
  };
}

export interface Epoch {
  nonce: string;
  game: string;
  /** The seat that began it, from its own state. */
  anchor: number;
  /** Its seats, ascending, the anchor among them. */
  seats: number[];
  /** The frame it began at, and the state it began from: its hash, the
   *  buttons held then ([player, index, value]), its length, and the
   *  deflated length and pieces in the doc (none for an epoch of one). */
  frame: number;
  hash: string;
  held: Array<[number, number, number]>;
  raw: number;
  size: number;
  chunks: number;
  page: string;
}

/** The cabinet's epoch, or null for anything out of shape (`seats`: the
 *  cabinet's). */
export function readEpoch(raw: unknown, seats: number): Epoch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const game = shortString(r.game, GAME_TAG_MAX);
  const page = shortString(r.page, 32);
  if (r.v !== 1 || !isEpochTag(r.nonce) || r.nonce === '' || game === null || !page) return null;
  if (!Array.isArray(r.seats) || r.seats.length < 1 || r.seats.length > seats) return null;
  const list: number[] = [];
  for (const n of r.seats) {
    if (!isInt(n, 0, seats - 1) || (list.length > 0 && n <= list[list.length - 1]!)) return null;
    list.push(n);
  }
  if (!isInt(r.anchor, 0, seats - 1) || !list.includes(r.anchor)) return null;
  if (!isInt(r.frame, 0, 0xffff_ffff) || !isInt(r.chunks, 0, STATE_MAX_CHUNKS)) return null;
  if (!isInt(r.size, 0, STATE_MAX_CHUNKS * STATE_CHUNK_BYTES) || !isInt(r.raw, 0, REPLAY_MAX_STATE_BYTES)) return null;
  const alone = list.length === 1;
  if (alone) {
    if (r.chunks !== 0 || r.size !== 0 || r.raw !== 0 || r.hash !== '') return null;
  } else {
    if (r.chunks < 1 || r.size <= (r.chunks - 1) * STATE_CHUNK_BYTES || r.size > r.chunks * STATE_CHUNK_BYTES) return null;
    if (r.raw < 1 || !isReplayStateHash(r.hash) || !r.hash.endsWith(`:${r.raw}`)) return null;
  }
  if (!Array.isArray(r.held) || r.held.length > seats * 24) return null;
  const held: Array<[number, number, number]> = [];
  for (const row of r.held) {
    if (!Array.isArray(row) || row.length !== 3) return null;
    if (!isReplayInput({ frame: 0, player: row[0], index: row[1], value: row[2] }) || row[0] >= seats) return null;
    held.push([row[0], row[1], row[2]]);
  }
  return {
    nonce: r.nonce, game, anchor: r.anchor, seats: list, frame: r.frame, hash: r.hash as string, held,
    raw: r.raw, size: r.size, chunks: r.chunks, page,
  };
}

/** An epoch's pieces as one buffer, or null when they are not what its
 *  record says: pieces of at most STATE_CHUNK_BYTES, as the seat that began
 *  it cut them, adding up to `size`. Checked before anything is allocated,
 *  since a peer may write anything under a piece's key. */
export function joinStatePieces(pieces: readonly Uint8Array[], size: number): Uint8Array | null {
  let total = 0;
  for (const p of pieces) {
    if (p.length > STATE_CHUNK_BYTES) return null;
    total += p.length;
  }
  if (total !== size) return null;
  const packed = new Uint8Array(size);
  let at = 0;
  for (const p of pieces) {
    packed.set(p, at);
    at += p.length;
  }
  return packed;
}

// ── The page's side ──────────────────────────────────────────────────────────

/** The room doc as the controller uses it (arcadeDoc's raw keys). */
export interface LockstepStore {
  get(key: string): unknown;
  /** Several keys in one write (one update to the room); a value of
   *  undefined deletes its key. The doc reports a write as a change at once,
   *  this page's own too. */
  set(entries: ReadonlyArray<readonly [string, unknown]>): void;
  delete(keys: readonly string[]): void;
  keys(prefix: string, max: number): string[];
}

export interface LockstepDeps {
  itemId: string;
  /** This page's seat, and how many the cabinet has. */
  seat: number;
  seats: number;
  /** What every seat must be running to play together: the game and the
   *  emulator files (arcadeStage's mount key; the doc gets its tag). */
  game: string;
  page: string;
  store: LockstepStore;
  /** To this page's frame (EmulatorHandle.send). */
  send(message: Record<string, unknown>, transfer?: Transferable[]): void;
  /** The page holding seat n now (its lease, not lapsed), or null; or
   *  undefined while its record reads missing. The room's updates can reach
   *  a page out of order (the node relays each on a stream of its own), and
   *  an update that replaces a key, there before an earlier update of the
   *  same writer, empties that key until the earlier one is in: the doc
   *  takes the replacing update's deletes at once and holds its writes. So
   *  the controller takes a record that reads missing as unchanged, and the
   *  lanes and the epoch the same way. */
  seatPage(n: number): string | null | undefined;
  /** Whether this page is on screen. */
  visible(): boolean;
  now(): number;
  /** A fresh epoch tag (tests pass their own). */
  newTag?(): string;
  /** A game began here from scratch: the tally counts it. */
  onFreshGame?(): void;
  /** The frame's delay (LOCKSTEP_DELAY). */
  delay?: number;
  /** Deflate and inflate a state (tests pass their own, which settle at
   *  once; the page's are streams). */
  pack?(bytes: Uint8Array): Promise<Uint8Array>;
  unpack?(bytes: Uint8Array, raw: number): Promise<Uint8Array>;
}

/** What the stage says about the game. */
export interface LockstepView {
  phase: 'starting' | 'alone' | 'joining' | 'playing' | 'holding' | 'out' | 'unsupported' | 'toobig';
  /** The seats in the game this page plays, its own among them, ascending. */
  players: number[];
  /** The seats the game holds for now. */
  waitingOn: number[];
  /** The seat whose state the game began from. */
  anchor: number | null;
}

const randomTag = (): string => Math.random().toString(36).slice(2, 10) || 'e';
const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw'));
}
async function inflate(bytes: Uint8Array, raw: number): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate-raw'), raw);
}

interface Joining {
  epoch: Epoch;
  /** Fetching and checking the state; then the state, once it checked out. */
  busy: boolean;
  state: Uint8Array | null;
  /** Times handed to the frame; and whether it can never load (a state that
   *  does not hash as its epoch says). */
  sent: number;
  failed: boolean;
}

export class LockstepController {
  private readonly d: LockstepDeps;
  private readonly delay: number;
  /** The game, as the lanes and the epoch name it (lockstepGameTag). */
  private readonly game: string;
  private disposed = false;
  /** The frame's emulator is up; its core cannot play in step; its state is
   *  too big to share. */
  private started = false;
  private unsupported = false;
  private tooBig = false;
  /** The frame's own word on where it stands (its status). */
  private frameNonce = '';
  private framePhase: ReplayStatus['phase'] = 'waiting';
  private frameAt = 0;
  /** The epoch this page plays or is joining: its tag, seats, first frame
   *  (-1 until the leading seat's frame has saved it) and leading seat. */
  private nonce = '';
  private members: number[] = [];
  private start = -1;
  private anchor: number | null = null;
  /** This seat's buttons in it: all known through `through`, from `rows`. */
  private through = -1;
  private rows: ReplayInput[] = [];
  private ran = 0;
  private lastProgressAt = 0;
  private hashes = new Map<number, string>();
  private lastHash = { frame: -1, hash: '' };
  private bad = false;
  /** Each other seat's buttons handed to the frame, through this frame. */
  private fwd = new Map<number, number>();
  /** When this page saw each lane last change, by its own clock. */
  private seen = new Map<number, { beat: number; page: string; at: number }>();
  private laneCache = new Map<number, { raw: unknown; lane: Lane | null }>();
  private epochCache: { raw: unknown; epoch: Epoch | null } = { raw: undefined, epoch: null };
  /** The page last known to hold each seat (LockstepDeps.seatPage). */
  private pages = new Map<number, string | null>();
  private epochSeen = new Map<string, number>();
  private excluded = new Map<number, number>();
  private strikes = new Map<number, number>();
  private begun: { nonce: string; seats: number[]; at: number; fresh: boolean } | null = null;
  private lastBegin = -Infinity;
  /** The epoch every seat of which has joined, as this page (leading) saw. */
  private everyoneIn = '';
  private joining: Joining | null = null;
  private lastWrite = -Infinity;
  private lastSig = '';
  private beat = 0;
  /** Inside a step: a change the doc reports meanwhile (this page's own
   *  writes among them) is looked at once the step is done. */
  private busy = false;
  private again = false;

  constructor(deps: LockstepDeps) {
    this.d = deps;
    this.delay = deps.delay ?? LOCKSTEP_DELAY;
    this.game = lockstepGameTag(deps.game);
  }

  /** The frame's events (the stage hands over every one). */
  onFrameEvent(ev: EmulatorEvent): void {
    if (this.disposed) return;
    switch (ev.type) {
      case 'started':
        this.started = true;
        break;
      case 'replay-status':
        this.onStatus(ev.status);
        break;
      case 'replay-inputs':
        if (ev.nonce !== undefined) this.onOwnBatch(ev.batch.from, ev.batch.through, ev.batch.inputs, ev.nonce);
        break;
      case 'replay-hash':
        if (ev.nonce !== undefined) this.onOwnHash(ev.hash.frame, ev.hash.hash, ev.nonce);
        break;
      case 'replay-snapshot':
        if (ev.nonce !== undefined) void this.onSnapshot(ev.snapshot, ev.nonce);
        return;
      default:
        return;
    }
    this.run();
  }

  /** A lane or the epoch changed in the doc. */
  onDoc(): void {
    if (this.disposed) return;
    if (this.busy) this.again = true;
    else this.run();
  }

  /** The stage's clock: beats, holds, and writes put off. */
  tick(): void {
    this.run();
  }

  /** The page stops playing here (stood up, or the stage closed): its lane
   *  goes, and an epoch of its own that nobody else plays goes with it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { store, itemId, seat } = this.d;
    // This page's own only: the seat may be another page's by now, its lane
    // written, and a newer epoch's pieces may be in before its record.
    const gone: string[] = [];
    if (readLane(store.get(lockstepLaneKey(itemId, seat)), seat)?.page === this.d.page) gone.push(lockstepLaneKey(itemId, seat));
    const e = readEpoch(store.get(lockstepEpochKey(itemId)), this.d.seats);
    if (e && e.anchor === seat && e.page === this.d.page) {
      const now = this.d.now();
      const others = [...this.readLanes(now).keys()].filter((n) => n !== seat && e.seats.includes(n));
      if (others.length === 0) gone.push(lockstepEpochKey(itemId), ...store.keys(`${lockstepChunkPrefix(itemId)}${e.nonce}:`, 4096));
    }
    if (gone.length > 0) store.delete(gone);
  }

  view(): LockstepView {
    const players = this.nonce ? this.members.slice() : [];
    const base = { players, waitingOn: [] as number[], anchor: this.anchor };
    if (this.unsupported) return { ...base, phase: 'unsupported' };
    if (this.tooBig) return { ...base, phase: 'toobig' };
    if (!this.started || !this.nonce) return { ...base, phase: 'starting' };
    if (this.joining && this.joining.epoch.nonce === this.nonce) return { ...base, phase: 'joining' };
    if (this.framePhase === 'free' && this.frameNonce === this.nonce) return { ...base, phase: 'alone' };
    const e = this.epoch();
    if (e && e.nonce !== this.nonce && !e.seats.includes(this.d.seat)) return { ...base, phase: 'out' };
    if (this.d.now() - this.lastProgressAt > 1_000) {
      const waitingOn = this.members.filter((n) => n !== this.d.seat && (this.fwd.get(n) ?? -1) < this.frameAt);
      return { ...base, waitingOn, phase: 'holding' };
    }
    return { ...base, phase: 'playing' };
  }

  // ── The frame's side ──

  private onStatus(st: ReplayStatus): void {
    if (st.phase === 'unsupported') {
      this.unsupported = true;
      return;
    }
    if (st.nonce !== undefined) this.frameNonce = st.nonce;
    this.framePhase = st.phase;
    if (st.frame !== undefined) this.frameAt = st.frame;
    const j = this.joining;
    if (st.loaded !== undefined && j && st.nonce === j.epoch.nonce) {
      if (st.matches === true) {
        this.joining = null;
        this.lastProgressAt = this.d.now();
      } else if (j.state && j.sent < 3) {
        // A load that did not land: hand the state over again (the frame
        // holds, and takes it from where it stopped).
        this.sendState(j);
      }
    }
  }

  private onOwnBatch(from: number, through: number, inputs: ReplayInput[], nonce: string): void {
    if (nonce !== this.nonce || through <= this.through) return;
    if (this.start < 0) {
      // The leading seat's first batch can beat its state here: it starts
      // where the epoch does.
      this.start = from;
      this.through = from - 1;
    }
    for (const i of inputs) if (i.frame > this.through) this.rows.push(i);
    this.through = through;
    const ran = Math.max(this.start, through - this.delay + 1);
    if (ran > this.ran) {
      this.ran = ran;
      this.lastProgressAt = this.d.now();
    }
  }

  private onOwnHash(frame: number, hash: string, nonce: string): void {
    if (nonce !== this.nonce) return;
    this.hashes.set(frame, hash);
    if (this.hashes.size > OWN_HASHES) this.hashes.delete(Math.min(...this.hashes.keys()));
    this.lastHash = { frame, hash };
  }

  /** The leading seat's frame saved the state its epoch begins from. */
  private async onSnapshot(s: ReplaySnapshot, nonce: string): Promise<void> {
    const b = this.begun;
    if (!b || b.nonce !== nonce || this.disposed) return;
    let packed: Uint8Array;
    try {
      packed = await (this.d.pack ?? deflate)(s.state);
    } catch {
      this.begun = null;
      return;
    }
    if (this.disposed || this.begun !== b) return;
    this.run(() => this.snapshotReady(b, s, nonce, packed));
  }

  private snapshotReady(b: NonNullable<LockstepController['begun']>, s: ReplaySnapshot, nonce: string, packed: Uint8Array): void {
    this.begun = null;
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < packed.length; at += STATE_CHUNK_BYTES) pieces.push(packed.slice(at, at + STATE_CHUNK_BYTES));
    if (pieces.length > STATE_MAX_CHUNKS) {
      // Too big to share through the room: this seat plays alone and stays
      // out of the others' games (its lane says away).
      this.tooBig = true;
      this.beginAlone(this.d.now());
      return;
    }
    // Another seat may have begun meanwhile, an epoch with this seat in it
    // that its own seat plays: then this one is dropped, and this seat
    // joins that one instead (follow).
    const now = this.d.now();
    const other = this.epoch();
    const lead = other ? this.readLanes(now).get(other.anchor) : undefined;
    if (other && other.nonce !== nonce && other.anchor !== this.d.seat && other.seats.includes(this.d.seat) && lead?.nonce === other.nonce && lead.phase === 'lockstep') return;
    if (this.start < 0 || this.start === s.frame) {
      this.start = s.frame;
      this.through = Math.max(this.through, s.frame - 1);
      this.ran = Math.max(this.ran, s.frame);
      for (const n of this.members) if (n !== this.d.seat) this.fwd.set(n, s.frame - 1);
    }
    this.publish({ nonce, seats: b.seats, frame: s.frame, hash: s.hash, held: s.held, raw: s.state.length }, pieces);
    if (b.fresh) this.d.onFreshGame?.();
  }

  // ── Deciding ──

  /** One step: `fn` (the frame's word, or an async task's end), then a
   *  look at where things stand, again while the doc changed under it. */
  private run(fn?: () => void): void {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      fn?.();
      for (let round = 0; round < 3 && !this.disposed; round++) {
        this.again = false;
        const now = this.d.now();
        if (this.started && !this.unsupported) this.decide(now);
        this.maybeWrite(now);
        if (!this.again) break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** The epoch as the doc has it. One that reads missing is taken as
   *  unchanged (LockstepDeps.seatPage says why): one that is gone for good
   *  is replaced by the next seat to begin. */
  private epoch(): Epoch | null {
    const raw = this.d.store.get(lockstepEpochKey(this.d.itemId));
    if (raw !== undefined && raw !== this.epochCache.raw) this.epochCache = { raw, epoch: readEpoch(raw, this.d.seats) };
    const e = this.epochCache.epoch;
    return e && e.game === this.game ? e : null;
  }

  /** Seat n's lane as the doc has it (read again only once it changes).
   *  Another seat's that reads missing is taken as unchanged: one that is
   *  gone for good stops beating, and lapses (its seat's lease has gone by
   *  then, as a rule). */
  private lane(n: number): Lane | null {
    const raw = this.d.store.get(lockstepLaneKey(this.d.itemId, n));
    const hit = this.laneCache.get(n);
    if (hit && (hit.raw === raw || (raw === undefined && n !== this.d.seat))) return hit.lane;
    const lane = readLane(raw, n);
    this.laneCache.set(n, { raw, lane });
    return lane;
  }

  /** The page holding seat n, the last one known while its record reads
   *  missing. */
  private seatPage(n: number): string | null {
    const page = this.d.seatPage(n);
    if (page === undefined) return this.pages.get(n) ?? null;
    this.pages.set(n, page);
    return page;
  }

  /** The lanes of the seats in now, as this page sees them. This page's
   *  own is the one it last wrote, as the others have it, so that every
   *  page elects from the same lanes: while it begins an epoch, its lane
   *  still says the epoch before. */
  private readLanes(now: number): Map<number, Lane> {
    const out = new Map<number, Lane>();
    for (let n = 0; n < this.d.seats; n++) {
      const lane = this.lane(n);
      if (n === this.d.seat) {
        if (lane && lane.page === this.d.page && lane.game === this.game && this.started && !this.unsupported) out.set(n, lane);
        continue;
      }
      if (!lane) {
        this.seen.delete(n);
        continue;
      }
      let s = this.seen.get(n);
      if (!s || s.beat !== lane.beat || s.page !== lane.page) {
        s = { beat: lane.beat, page: lane.page, at: now };
        this.seen.set(n, s);
      }
      if (now - s.at >= LANE_LAPSE_MS || lane.game !== this.game || this.seatPage(n) !== lane.page) continue;
      out.set(n, lane);
    }
    return out;
  }

  /** The seats that should play now: in, on screen, not left out. */
  private liveSeats(lanes: Map<number, Lane>, now: number): number[] {
    return [...lanes.entries()]
      .filter(([n, l]) => l.phase !== 'away' && !((this.excluded.get(n) ?? 0) > now))
      .map(([n]) => n)
      .sort((a, b) => a - b);
  }

  /** Which seat begins the next epoch: every page works it out alike. */
  private elect(e: Epoch | null, lanes: Map<number, Lane>, now: number): number | null {
    const live = this.liveSeats(lanes, now);
    const running = (n: number) => {
      const l = lanes.get(n);
      return !!l && (l.phase === 'free' || l.phase === 'lockstep');
    };
    const inEpoch = (n: number) => !!e && lanes.get(n)?.nonce === e.nonce && running(n);
    if (e && live.includes(e.anchor) && inEpoch(e.anchor)) return e.anchor;
    const stayed = live.filter((n) => e?.seats.includes(n) && inEpoch(n));
    if (stayed.length > 0) return stayed[0]!;
    const playing = live.filter(running);
    if (playing.length > 0) return playing[0]!;
    return live[0] ?? null;
  }

  private decide(now: number): void {
    const e = this.epoch();
    if (e && !this.epochSeen.has(e.nonce)) {
      this.epochSeen.set(e.nonce, now);
      if (this.epochSeen.size > 16) this.epochSeen.delete(this.epochSeen.keys().next().value!);
    }
    const lanes = this.readLanes(now);
    this.forward();
    this.compare(lanes);
    if (this.elect(e, lanes, now) === this.d.seat) this.lead(e, lanes, now);
    else this.follow(e, lanes);
  }

  /** The leading seat: begins an epoch whenever the one running is not the
   *  game the seats in should be playing. */
  private lead(e: Epoch | null, lanes: Map<number, Lane>, now: number): void {
    if (this.tooBig) return;
    if (this.begun) {
      if (now - this.begun.at < BEGIN_WAIT_MS) return; // its state is on the way
      this.begun = null;
    }
    const me = this.d.seat;
    const live = this.liveSeats(lanes, now);
    if (!live.includes(me)) return;
    const mine = e && e.anchor === me && e.page === this.d.page && e.nonce === this.nonce && this.frameNonce === e.nonce ? e : null;
    if (!mine || !sameList(mine.seats, live)) {
      if (now - this.lastBegin >= BEGIN_MIN_MS) this.begin(live, now);
      return;
    }
    if (mine.seats.length < 2) return;
    // A seat that never joined: left out for a while.
    const age = now - (this.epochSeen.get(mine.nonce) ?? now);
    const late = mine.seats.filter((n) => n !== me && !(lanes.get(n)?.nonce === mine.nonce && lanes.get(n)?.phase === 'lockstep'));
    if (late.length > 0) {
      if (age >= JOIN_MS) {
        for (const n of late) this.excluded.set(n, now + EXCLUDE_MS);
        this.begin(this.liveSeats(lanes, now), now);
      }
      return;
    }
    if (this.everyoneIn !== mine.nonce) {
      // The game is held from the moment it began until the last seat is in.
      this.everyoneIn = mine.nonce;
      this.lastProgressAt = Math.max(this.lastProgressAt, now);
    }
    // The game held too long: everyone loads it again, and a seat it held
    // for twice running is left out for a while.
    if (now - this.lastProgressAt >= STALL_MS && now - this.lastBegin >= STALL_MS) {
      for (const n of mine.seats) {
        if (n === me || (this.fwd.get(n) ?? -1) >= this.frameAt) continue;
        const strikes = (this.strikes.get(n) ?? 0) + 1;
        this.strikes.set(n, strikes);
        if (strikes >= 2) this.excluded.set(n, now + EXCLUDE_MS);
      }
      this.begin(this.liveSeats(lanes, now), now);
      return;
    }
    if (now - this.lastProgressAt < 1_000 && now - this.lastBegin >= 30_000) this.strikes.clear();
    // Two seats' states differ: everyone loads this one's again.
    const differs = this.bad || [...lanes.entries()].some(([n, l]) => n !== me && l.nonce === mine.nonce && l.bad);
    if (differs && now - this.lastBegin >= 2 * BEGIN_MIN_MS) this.begin(live, now);
  }

  /** Any other seat: joins the epoch it is in, once its leading seat plays it. */
  private follow(e: Epoch | null, lanes: Map<number, Lane>): void {
    this.begun = null;
    const me = this.d.seat;
    if (!e || !e.seats.includes(me) || e.seats.length < 2 || e.anchor === me || this.nonce === e.nonce) return;
    const lead = lanes.get(e.anchor);
    if (!lead || lead.nonce !== e.nonce || lead.phase !== 'lockstep') return;
    if (this.joining && this.joining.epoch.nonce === e.nonce && (this.joining.busy || this.joining.failed)) return;
    void this.join(e);
  }

  private begin(seats: number[], now: number): void {
    const me = this.d.seat;
    if (!seats.includes(me)) return;
    if (seats.length === 1) {
      this.beginAlone(now);
      return;
    }
    const nonce = this.d.newTag?.() ?? randomTag();
    const fresh = !this.nonce && this.framePhase === 'waiting';
    this.lastBegin = now;
    this.enter(nonce, seats, -1, me, now);
    this.begun = { nonce, seats: seats.slice(), at: now, fresh };
    this.d.send({ type: 'arcade-replay-begin', nonce, seats });
  }

  private beginAlone(now: number): void {
    const me = this.d.seat;
    const nonce = this.d.newTag?.() ?? randomTag();
    const fresh = !this.nonce && this.framePhase === 'waiting';
    this.lastBegin = now;
    this.enter(nonce, [me], 0, me, now);
    this.d.send({ type: 'arcade-replay-begin', nonce, seats: [me] });
    if (!this.tooBig) this.publish({ nonce, seats: [me], frame: 0, hash: '', held: [], raw: 0 }, []);
    if (fresh) this.d.onFreshGame?.();
  }

  /** Into an epoch: nothing of the last one carries over. */
  private enter(nonce: string, seats: number[], start: number, anchor: number, now: number): void {
    this.nonce = nonce;
    this.members = seats.slice();
    this.start = start;
    this.anchor = anchor;
    this.through = start - 1;
    this.rows = [];
    this.ran = Math.max(0, start);
    this.lastProgressAt = now;
    this.hashes.clear();
    this.lastHash = { frame: -1, hash: '' };
    this.bad = false;
    this.fwd.clear();
    for (const n of seats) if (n !== this.d.seat) this.fwd.set(n, start - 1);
  }

  /** The epoch's record, written with or after its pieces (the doc is in
   *  order per writer, so a page that hears the record has every piece; a
   *  piece is an update of its own), the pieces of every earlier epoch of
   *  the cabinet deleted in the same write. */
  private publish(e: { nonce: string; seats: number[]; frame: number; hash: string; held: Array<[number, number, number]>; raw: number }, pieces: Uint8Array[]): void {
    const { store, itemId } = this.d;
    const prefix = lockstepChunkPrefix(itemId);
    const stale = store.keys(prefix, 4096).filter((k) => !k.startsWith(`${prefix}${e.nonce}:`));
    const record = {
      v: 1, nonce: e.nonce, game: this.game, anchor: this.d.seat, seats: e.seats, frame: e.frame, hash: e.hash,
      held: e.held, raw: e.raw, size: pieces.reduce((n, p) => n + p.length, 0), chunks: pieces.length, page: this.d.page,
    };
    // The frame is in it already: its state for others to load is what
    // began it. This seat's lane says so in the same write as the record,
    // so no page sees the one without the other (and elects another seat
    // to begin in between).
    this.frameNonce = e.nonce;
    this.framePhase = e.seats.length === 1 ? 'free' : 'lockstep';
    const lane: readonly [string, unknown] = [lockstepLaneKey(itemId, this.d.seat), this.laneRecord(this.d.now())];
    const entries: Array<readonly [string, unknown]> = pieces.map((p, i) => [lockstepChunkKey(itemId, e.nonce, i), p] as const);
    for (const entry of entries.slice(0, -1)) store.set([entry]);
    store.set([...stale.map((k) => [k, undefined] as const), ...entries.slice(-1), [lockstepEpochKey(itemId), record], lane]);
  }

  /** Fetch the epoch's state from the doc, check it, and hand it to the frame. */
  private async join(e: Epoch): Promise<void> {
    const j: Joining = { epoch: e, busy: true, state: null, sent: 0, failed: false };
    this.joining = j;
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < e.chunks; i++) {
      const p = this.d.store.get(lockstepChunkKey(this.d.itemId, e.nonce, i));
      if (!(p instanceof Uint8Array)) {
        j.busy = false; // not all here yet: tried again on the next change
        return;
      }
      pieces.push(p);
    }
    const packed = joinStatePieces(pieces, e.size);
    let state: Uint8Array | null = null;
    if (packed) {
      try {
        state = await (this.d.unpack ?? inflate)(packed, e.raw);
      } catch {
        state = null;
      }
    }
    if (this.disposed || this.joining !== j) return;
    j.busy = false;
    if (!state || state.length !== e.raw || replayStateHash(state) !== e.hash) {
      // Not the state its epoch names: never loaded. The seat that leads
      // leaves this one out, and the next epoch is another state.
      j.failed = true;
      return;
    }
    const loaded = state;
    this.run(() => {
      j.state = loaded;
      this.enter(e.nonce, e.seats, e.frame, e.anchor, this.d.now());
      this.sendState(j);
    });
  }

  private sendState(j: Joining): void {
    if (!j.state) return;
    const state = j.state.slice(); // the frame takes the buffer
    j.sent += 1;
    const e = j.epoch;
    this.d.send({ type: 'arcade-replay-snapshot', nonce: e.nonce, seats: e.seats, frame: e.frame, state, held: e.held, hash: e.hash }, [state.buffer]);
  }

  /** Hand the frame every other seat's buttons it does not have yet. A
   *  lane whose window starts past them leaves a gap: the game holds for
   *  that seat, and the leading seat begins again (STALL_MS). */
  private forward(): void {
    if (!this.nonce || this.start < 0) return;
    for (const n of this.members) {
      if (n === this.d.seat) continue;
      const lane = this.lane(n);
      if (!lane || lane.nonce !== this.nonce || this.seatPage(n) !== lane.page) continue;
      const have = this.fwd.get(n) ?? this.start - 1;
      if (lane.through <= have || lane.from > have + 1) continue;
      const inputs = lane.inputs.filter((i) => i.frame > have).map((i) => [i.frame, i.player, i.index, i.value]);
      this.d.send({ type: 'arcade-replay-inputs', nonce: this.nonce, seat: n, from: have + 1, through: lane.through, inputs });
      this.fwd.set(n, lane.through);
    }
  }

  /** Another seat's latest hash against this seat's own at that frame. */
  private compare(lanes: Map<number, Lane>): void {
    for (const [n, lane] of lanes) {
      if (n === this.d.seat || lane.nonce !== this.nonce || !lane.hash) continue;
      const mine = this.hashes.get(lane.hashFrame);
      if (mine !== undefined && mine !== lane.hash) this.bad = true;
    }
  }

  // ── The lane ──

  private lanePhase(): LanePhase {
    if (!this.d.visible() || this.tooBig || this.unsupported) return 'away';
    if (!this.nonce) return 'ready';
    if (this.frameNonce === this.nonce) {
      if (this.framePhase === 'free') return 'free';
      if (this.framePhase === 'lockstep' || this.framePhase === 'stalled') return 'lockstep';
    }
    return 'loading';
  }

  /** The first frame this seat's lane still carries buttons from: the
   *  oldest any other seat in the epoch has yet to run. */
  private windowFrom(): number {
    let from = this.ran;
    for (const n of this.members) {
      if (n === this.d.seat) continue;
      const lane = this.lane(n);
      const ran = lane && lane.nonce === this.nonce ? lane.ran : this.start;
      from = Math.min(from, ran);
    }
    return Math.max(this.start, from, this.through - WINDOW_MAX_FRAMES + 1);
  }

  private ownLane(): Lane {
    let from = Math.max(0, this.start);
    let inputs: ReplayInput[] = [];
    if (this.nonce && this.start >= 0 && this.through >= this.start) {
      from = this.windowFrom();
      this.rows = this.rows.filter((i) => i.frame >= from);
      if (this.rows.length > REPLAY_MAX_BATCH_INPUTS) {
        this.rows = this.rows.slice(-REPLAY_MAX_BATCH_INPUTS);
        from = Math.max(from, this.rows[0]!.frame);
      }
      inputs = this.rows;
    }
    return {
      page: this.d.page, game: this.game, nonce: this.nonce, phase: this.lanePhase(), ran: this.ran,
      from, through: this.through, inputs, hash: this.lastHash.hash, hashFrame: this.lastHash.frame, bad: this.bad, beat: this.beat,
    };
  }

  private laneSig(lane: Lane): string {
    return `${lane.nonce}|${lane.phase}|${lane.ran}|${lane.from}|${lane.through}|${lane.inputs.length}|${lane.hashFrame}|${lane.bad}`;
  }

  /** The lane as it goes into the doc now (a write: the beat moves on). */
  private laneRecord(now: number): Record<string, unknown> {
    const lane = this.ownLane();
    this.lastSig = this.laneSig(lane);
    this.lastWrite = now;
    this.beat += 1;
    const record: Record<string, unknown> = {
      v: 1, page: lane.page, game: lane.game, nonce: lane.nonce, phase: lane.phase, ran: lane.ran,
      hash: lane.hash, hashFrame: lane.hashFrame, bad: lane.bad, beat: this.beat,
    };
    if (lane.through >= lane.from) record.rows = packInputBatch({ from: lane.from, through: lane.through, inputs: lane.inputs });
    return record;
  }

  private maybeWrite(now: number): void {
    // While this seat's frame saves the state of an epoch it begins, its
    // lane stays as it was: the epoch's record and the lane's new word go
    // into the doc together (publish).
    if (!this.started || this.disposed || this.begun) return;
    const changed = this.laneSig(this.ownLane()) !== this.lastSig;
    if (changed ? now - this.lastWrite < LANE_WRITE_MS : now - this.lastWrite < LANE_BEAT_MS) return;
    this.d.store.set([[lockstepLaneKey(this.d.itemId, this.d.seat), this.laneRecord(now)]]);
  }
}
