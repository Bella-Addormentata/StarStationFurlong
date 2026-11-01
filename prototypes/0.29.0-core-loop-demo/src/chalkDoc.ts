/**
 * 🖍 The chalkboard (Dorkmo 2026-11-01): a wall board anyone in the room can
 * write on with a stick of chalk and wipe with a felt eraser, and everyone in
 * the room sees the same marks. No menus: the tools lie on the board's tray
 * (chalkSession.ts).
 *
 * ─── The record ──────────────────────────────────────────────────────────────
 *
 * One room-doc map, `chalkMarks`, keyed `<itemId>|<entryId>` (the room
 * boards' per-item pattern, boardDoc.ts: never a top-level type per board).
 * Each value is one ENTRY, a short run of one tool's strokes:
 *
 *   { v: 1, k: 'c' | 'e', at, p }      k chalk or eraser, p the strokes
 *
 * `p` is chalkRender.ts's stroke bytes. A writer keeps one entry open while
 * it draws, rewriting it with the longer bytes every ENTRY_FLUSH_MS (so
 * others watch the line grow), and closes it after ENTRY_MAX_MS, at
 * MAX_ENTRY_BYTES, when the tool changes or goes back on the tray, or after
 * ENTRY_IDLE_MS with the pen up. A rewrite only ever appends.
 *
 * Every reader paints the entries in one order, `at` then the entry id.
 * `at` is a Lamport stamp: a writer stamps a new entry later than every
 * entry it has seen on the board, so marks made after seeing others' marks
 * always paint over them, whatever the machines' clocks say.
 *
 * ─── No signatures, no author ────────────────────────────────────────────────
 *
 * Anyone in the room may draw (Dorkmo: "Anyone can access"), and a mark says
 * nothing about who made it, so there is nothing to forge: unlike a board's
 * notes, an entry is not signed. Getting into the room is the gate. As with
 * every room record today, a modified client can still wipe or scribble
 * (roomOwner.ts); node-enforced write rules close that for every feature.
 *
 * ─── Caps and trims ──────────────────────────────────────────────────────────
 *
 * A room holds at most MAX_CHALKBOARDS_PER_ROOM boards. Readers paint at
 * most a board's newest MAX_SHOWN_ENTRIES valid entries, and visit at most
 * MAX_KEYS_VISITED keys. Once a board's entries pass TRIM_AT_ENTRIES or
 * TRIM_AT_BYTES, the next writer to put a tool down (and whose copy holds the
 * host's state: the corkboard's routeRoomReady rule) trims it, by
 * chalkRender.planInvisible: chalk the eraser has wiped to nothing, and
 * wipes with nothing left under them, go first, which changes nothing anyone
 * can see; only if that isn't enough do the oldest marks go. Junk (bad
 * records, stamps far ahead) goes too. A removed board takes its marks with
 * it (forgetChalkboard).
 *
 * ─── The picture ─────────────────────────────────────────────────────────────
 *
 * Each board's picture is built here from the entries (a ChalkSurface),
 * painted entry by entry as they arrive. A base copy holds the settled
 * entries, so an entry that lands out of order (two people drawing at once)
 * repaints only the recent ones on top of it, not the whole board. The local
 * player's own strokes paint the moment they're drawn, ahead of the doc.
 */

import * as Y from 'yjs';
import {
  ChalkSurface,
  StrokeWriter,
  decodeStrokes,
  planInvisible,
  planInvisibleSteps,
  tapHook,
  type ChalkPoint,
  type ChalkTool,
  type DecodedPoint,
} from './chalkRender';

// ── Shapes and limits ────────────────────────────────────────────────────────

export const CHALK_MARKS_MAP = 'chalkMarks';
/** The furniture kind. */
export const CHALKBOARD_KIND = 'chalkboard';
/** Chalkboards a room may hold (the dev menu's placement refuses a third). */
export const MAX_CHALKBOARDS_PER_ROOM = 2;
/** An entry's stroke bytes, at most (a few seconds of drawing). */
export const MAX_ENTRY_BYTES = 1536;
/** How often an open entry is rewritten while it grows. */
export const ENTRY_FLUSH_MS = 250;
/** An entry is closed this long after it opened (a stroke goes on in a new one). */
export const ENTRY_MAX_MS = 4000;
/** …or after the pen has been up this long. */
export const ENTRY_IDLE_MS = 1200;
/** Entries a board paints: its newest valid ones. */
export const MAX_SHOWN_ENTRIES = 480;
/** Keys a reader visits in the map (both boards' entries, and junk). */
export const MAX_KEYS_VISITED = 2048;
/** A stamp further ahead of the reader's clock than this is junk. */
export const MAX_FUTURE_MS = 24 * 3600 * 1000;
/** A board is trimmed past either of these… */
export const TRIM_AT_ENTRIES = 360;
export const TRIM_AT_BYTES = 64_000;
/** …down to these, if wiping out what can't be seen isn't enough. */
export const TRIM_TO_ENTRIES = 270;
export const TRIM_TO_BYTES = 48_000;
/** What a trim never takes: entries this young may still be growing. */
export const TRIM_SPARES_MS = 30_000;
/** One trim per board per this long, at most. */
const TRIM_EVERY_MS = 15_000;
/** Rough doc bytes an entry costs past its strokes (key, fields, struct). */
export const ENTRY_OVERHEAD_BYTES = 56;
const ID_RE = /^[a-z0-9]{6,16}$/;

export function isChalkboardKind(kind: string | undefined): boolean {
  return kind === CHALKBOARD_KIND;
}

/** How many chalkboards a set of furniture holds (for MAX_CHALKBOARDS_PER_ROOM). */
export function countChalkboards(items: readonly { kind: string }[]): number {
  return items.filter((i) => isChalkboardKind(i.kind)).length;
}

/** A valid entry, as a reader takes it. */
export interface ChalkEntry {
  key: string;
  id: string;
  tool: ChalkTool;
  at: number;
  p: Uint8Array;
}

export function entryKey(itemId: string, id: string): string {
  return `${itemId}|${id}`;
}

/** The one paint order: `at`, then the entry id. */
export function compareEntries(a: Pick<ChalkEntry, 'at' | 'id'>, b: Pick<ChalkEntry, 'at' | 'id'>): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const decoded = new WeakMap<Uint8Array, DecodedPoint[] | null>();

/** An entry's points, decoded once per stored byte array. */
export function pointsOf(p: Uint8Array): DecodedPoint[] | null {
  if (decoded.has(p)) return decoded.get(p) ?? null;
  const pts = decodeStrokes(p);
  decoded.set(p, pts);
  return pts;
}

/** The stored value, checked (null when a reader must ignore it). */
export function entryFromWire(raw: unknown, now: number): { tool: ChalkTool; at: number; p: Uint8Array } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  const tool: ChalkTool | null = r.k === 'c' ? 'chalk' : r.k === 'e' ? 'eraser' : null;
  if (!tool) return null;
  const at = r.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + MAX_FUTURE_MS) return null;
  const p = r.p;
  if (!(p instanceof Uint8Array) || p.length === 0 || p.length > MAX_ENTRY_BYTES) return null;
  if (!pointsOf(p)) return null;
  return { tool, at, p };
}

export function entryToWire(tool: ChalkTool, at: number, p: Uint8Array): Record<string, unknown> {
  return { v: 1, k: tool === 'chalk' ? 'c' : 'e', at, p };
}

export interface ChalkRead {
  /** What a board paints, oldest first. */
  shown: ChalkEntry[];
  /** Keys under the board a trim may take now: bad records, and valid ones
   *  past the shown cap that are older than TRIM_SPARES_MS (a younger one
   *  may still be its writer's open entry). */
  junk: string[];
}

/** A board's entries from the map's entries (pure: chalkDoc.test.ts). */
export function readChalkEntries(entries: Iterable<[string, unknown]>, itemId: string, now: number): ChalkRead {
  const prefix = `${itemId}|`;
  const valid: ChalkEntry[] = [];
  const junk: string[] = [];
  let visited = 0;
  for (const [key, raw] of entries) {
    if (++visited > MAX_KEYS_VISITED) break;
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const e = ID_RE.test(id) ? entryFromWire(raw, now) : null;
    if (!e) {
      junk.push(key);
      continue;
    }
    valid.push({ key, id, ...e });
  }
  valid.sort(compareEntries);
  const cut = Math.max(0, valid.length - MAX_SHOWN_ENTRIES);
  for (let i = 0; i < cut; i++) if (now - valid[i].at >= TRIM_SPARES_MS) junk.push(valid[i].key);
  return { shown: valid.slice(cut), junk };
}

/** Past a TRIM_AT mark: a trim has something to do. */
export function overBudget(shown: readonly ChalkEntry[]): boolean {
  return shown.length > TRIM_AT_ENTRIES || entriesBytes(shown) > TRIM_AT_BYTES;
}

const planEntries = (shown: readonly ChalkEntry[]) => shown.map((e) => ({ tool: e.tool, points: pointsOf(e.p) ?? [] }));

/** The doc bytes a board's entries cost, roughly. */
export function entriesBytes(shown: readonly ChalkEntry[]): number {
  let n = 0;
  for (const e of shown) n += e.p.length + ENTRY_OVERHEAD_BYTES;
  return n;
}

/**
 * The keys a trim deletes (pure): nothing while the board is under both
 * TRIM_AT marks; else the entries planInvisible says no one can see, then,
 * if the board is still past a TRIM_TO mark, the oldest, until it isn't.
 * Entries younger than TRIM_SPARES_MS are never taken (they may still grow).
 */
export function planChalkTrim(shown: readonly ChalkEntry[], now: number, invisibleSet?: ReadonlySet<number>): string[] {
  if (!overBudget(shown)) return [];
  const settled = (e: ChalkEntry) => now - e.at >= TRIM_SPARES_MS;
  const invisible = invisibleSet ?? planInvisible(planEntries(shown));
  const out: string[] = [];
  const gone = new Set<number>();
  for (const i of invisible) {
    if (!settled(shown[i])) continue;
    gone.add(i);
    out.push(shown[i].key);
  }
  let count = shown.length - gone.size;
  let bytes = entriesBytes(shown.filter((_, i) => !gone.has(i)));
  for (let i = 0; i < shown.length && (count > TRIM_TO_ENTRIES || bytes > TRIM_TO_BYTES); i++) {
    if (gone.has(i) || !settled(shown[i])) continue;
    out.push(shown[i].key);
    count--;
    bytes -= shown[i].p.length + ENTRY_OVERHEAD_BYTES;
  }
  return out;
}

export function newEntryId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return s + Date.now().toString(36).slice(-4);
}

// ── The bound store ──────────────────────────────────────────────────────────

export interface ChalkDeps {
  /** The host's own state has arrived (routeKeeper.routeRoomReady): a trim
   *  may run. */
  canTrim: () => boolean;
}

let deps: ChalkDeps | null = null;
let boundDoc: Y.Doc | null = null;
let marksMap: Y.Map<unknown> | null = null;
/** Bumps per board on every change under its prefix. */
const versions = new Map<string, number>();
let anyVersion = 0;

export function setChalkDeps(d: ChalkDeps | null): void {
  deps = d;
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && marksMap !== null;
}

const itemOfKey = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf('|')));

function bump(itemId: string): void {
  versions.set(itemId, (versions.get(itemId) ?? 0) + 1);
  anyVersion++;
}

/** Bind the room doc: main.ts's room-join seam, beside bindBoardDoc. */
export function bindChalkDoc(doc: Y.Doc): void {
  // The previous room's pens and pictures belong to its doc.
  boards.clear();
  boundDoc = doc;
  marksMap = doc.getMap(CHALK_MARKS_MAP);
  marksMap.observe((e) => {
    for (const key of e.keysChanged) bump(itemOfKey(key));
  });
  versions.clear();
  anyVersion++;
}

/** A board's change counter (any write under its prefix bumps it). */
export function chalkVersion(itemId: string): number {
  return versions.get(itemId) ?? 0;
}

/** A board's entries as the bound doc holds them. */
export function readChalkBoard(itemId: string, now = Date.now()): ChalkRead {
  if (!docAlive()) return { shown: [], junk: [] };
  return readChalkEntries(marksMap!.entries(), itemId, now);
}

/** A board was taken off the wall (edit mode's REMOVE, already owner-gated,
 *  or a template that drops it): its marks go with it. */
export function forgetChalkboard(itemId: string): number {
  boards.delete(itemId);
  if (!docAlive()) return 0;
  const prefix = `${itemId}|`;
  const keys = [...marksMap!.keys()].filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return 0;
  boundDoc!.transact(() => {
    for (const k of keys) marksMap!.delete(k);
  });
  return keys.length;
}

/** A board's picture and pen leave this copy (World drops the board's
 *  furniture, however it went). The marks in the doc are untouched: the
 *  room's layout says whether the board is gone (forgetChalkboard). */
export function disposeChalkboard(itemId: string): void {
  boards.delete(itemId);
}

/** Trim a board now, in one go, if it's past its marks and this copy may
 *  (see the header). The game trims in steps instead (scheduleTrim). */
export function trimChalkboard(itemId: string, now = Date.now()): number {
  if (!deps || !docAlive() || !deps.canTrim()) return 0;
  const { shown, junk } = readChalkBoard(itemId, now);
  return deleteKeys([...junk, ...planChalkTrim(shown, now)]);
}

function deleteKeys(keys: readonly string[]): number {
  if (keys.length === 0 || !docAlive()) return 0;
  boundDoc!.transact(() => {
    for (const k of keys) marksMap!.delete(k);
  });
  return keys.length;
}

/** A chalkboard is on the wall in the bound doc's layout (or the layout is
 *  unseeded, as offline). A pen closing after its board was taken down (the
 *  forced step-back when someone else removes it) writes nothing. */
function boardPlaced(itemId: string): boolean {
  const layout = boundDoc!.getMap('furniture');
  if (layout.size === 0) return true;
  const rec = layout.get(itemId) as { kind?: unknown } | undefined;
  return typeof rec?.kind === 'string' && isChalkboardKind(rec.kind);
}

function writeEntry(key: string, tool: ChalkTool, at: number, p: Uint8Array): void {
  if (!docAlive() || !boardPlaced(itemOfKey(key))) return;
  marksMap!.set(key, entryToWire(tool, at, p));
}

// ── Each board's picture, and the local pen ─────────────────────────────────

/** A stretch of one entry painted onto the live picture, in paint order. */
interface Run {
  key: string;
  /** Bytes (from, to] of the entry's strokes this run painted. */
  from: number;
  to: number;
  /** The bytes it painted from (to check a rewrite only appended). */
  p: Uint8Array;
}

/** An entry as the picture paints it. */
interface Paintable {
  key: string;
  tool: ChalkTool;
  at: number;
  p: Uint8Array;
}

/** The local player's open entry. */
interface Pen {
  key: string;
  id: string;
  tool: ChalkTool;
  at: number;
  writer: StrokeWriter;
  /** The writer's bytes as last painted. */
  bytes: Uint8Array;
  flushed: number;
  openedAt: number;
  lastFlushAt: number;
  lastPointAt: number;
  down: boolean;
  /** A step was added since the pen last went down (else it was a tap). */
  moved: boolean;
  last: ChalkPoint | null;
}

interface Board {
  live: ChalkSurface;
  /** The settled entries' picture, and which entries (and lengths) it holds. */
  base: ChalkSurface;
  baseKeys: Array<{ key: string; len: number; p: Uint8Array }>;
  runs: Run[];
  /** When each entry's bytes last changed, on this machine's clock. */
  changedAt: Map<string, number>;
  seenVersion: number;
  lastSyncAt: number;
  pen: Pen | null;
  /** A repaint too big for one frame, in steps (paintJob). */
  job: Generator<void, void, void> | null;
  /** A trim plan in steps (trimJob). */
  trim: Generator<void, void, void> | null;
  /** A big settled entry being folded into a copy of the base, in steps. */
  fold: Fold | null;
  /** The base's last copy, kept to fold into next time. */
  spare: ChalkSurface | null;
  lastTrimAt: number;
  /** The newest stamp seen on the board (the Lamport floor for a new entry). */
  maxAt: number;
}

/** A fold in flight: `surface` is `from` (the base, when it began) plus the
 *  entry so far. It lands only if the base and the first run still match. */
interface Fold {
  entry: ChalkEntry;
  from: ChalkSurface;
  baseLen: number;
  surface: ChalkSurface;
  job: Generator<void, void, void>;
}

const boards = new Map<string, Board>();

/** An entry stops being repainted once its bytes have held this long. */
const SETTLE_MS = 6000;
/** A first paint puts entries this old by their stamp straight into the base. */
const SETTLED_STAMP_MS = 30_000;
/** Runs left out of the base, at least (the newest marks stay cheap to repaint). */
const KEEP_RUNS = 8;
/** The picture re-reads the doc at most this often. */
const SYNC_EVERY_MS = 60;
/** Painting more segments than this waits for a job, a few ms a frame. */
const SYNC_SEGMENTS = 400;
/** A job paints this many segments between looks at the clock. */
const JOB_SLICE = 48;
/** What a job may spend in one frame. */
const JOB_BUDGET_MS = 6;
/** What folding settled runs into the base may spend in one frame. */
const FOLD_BUDGET_MS = 2;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function boardOf(itemId: string): Board {
  let b = boards.get(itemId);
  if (!b) {
    b = {
      live: new ChalkSurface(),
      base: new ChalkSurface(),
      baseKeys: [],
      runs: [],
      changedAt: new Map(),
      seenVersion: -1,
      lastSyncAt: -Infinity,
      pen: null,
      job: null,
      trim: null,
      fold: null,
      spare: null,
      lastTrimAt: -Infinity,
      maxAt: 0,
    };
    b.live.markAll();
    boards.set(itemId, b);
  }
  return b;
}

/** What the board should show, in order: the doc's entries, with the open
 *  pen's bytes in place of (or beside) its doc copy, which lags. */
function expectedOf(itemId: string, b: Board, now: number): Paintable[] {
  const { shown } = readChalkBoard(itemId, now);
  const out: Paintable[] = shown.map((e) => ({ key: e.key, tool: e.tool, at: e.at, p: e.p }));
  const pen = b.pen;
  if (pen) {
    const mine = out.find((e) => e.key === pen.key);
    if (mine) mine.p = pen.bytes;
    else if (pen.bytes.length > 0) {
      out.push({ key: pen.key, tool: pen.tool, at: pen.at, p: pen.bytes });
      out.sort((x, y) => compareEntries({ at: x.at, id: x.key }, { at: y.at, id: y.key }));
    }
  }
  for (const e of out) if (e.at > b.maxAt) b.maxAt = e.at;
  return out;
}

const samePrefix = (a: Uint8Array, b: Uint8Array, len: number): boolean => {
  if (a === b) return true;
  if (a.length < len || b.length < len) return false;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Segments an entry paints from byte `from` on (a repaint's cost). */
function segmentsFrom(p: Uint8Array, from: number): number {
  const pts = pointsOf(p);
  if (!pts) return 0;
  let n = 0;
  for (let i = 1; i < pts.length; i++) if (!pts[i].start && pts[i].end > from) n++;
  return n;
}

/** Note a stretch painted onto the live picture. */
function noteRun(runs: Run[], key: string, from: number, p: Uint8Array): void {
  const last = runs[runs.length - 1];
  if (last && last.key === key && last.to === from) {
    last.to = p.length;
    last.p = p;
  } else {
    runs.push({ key, from, to: p.length, p });
  }
}

function paintRun(b: Board, tool: ChalkTool, key: string, p: Uint8Array, from: number): void {
  const pts = pointsOf(p);
  if (pts) b.live.applyPoints(tool, pts, from, p.length);
  noteRun(b.runs, key, from, p);
}

/** Paint one whole entry onto a surface, yielding every JOB_SLICE segments. */
function* paintSteps(surface: ChalkSurface, e: Paintable): Generator<void, void, void> {
  const pts = pointsOf(e.p);
  if (!pts) return;
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].start) continue;
    surface.segment(e.tool, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    if (++n % JOB_SLICE === 0) yield;
  }
}

/**
 * Repaint in steps. `full`: the base is rebuilt too, from the entries old
 * enough by their stamps (a first paint, or the base no longer holds). Else
 * the live picture is the base plus everything after it. The result is
 * swapped in whole when done; until then the old picture stays up.
 */
function* paintJob(b: Board, expected: readonly Paintable[], full: boolean, now: number): Generator<void, void, void> {
  let base = b.base;
  let baseKeys = b.baseKeys;
  let rest = expected.slice(baseKeys.length);
  if (full) {
    base = new ChalkSurface();
    baseKeys = [];
    let k = 0;
    while (
      k < expected.length - KEEP_RUNS &&
      expected[k].key !== b.pen?.key &&
      now - expected[k].at >= SETTLED_STAMP_MS
    ) {
      yield* paintSteps(base, expected[k]);
      baseKeys.push({ key: expected[k].key, len: expected[k].p.length, p: expected[k].p });
      k++;
    }
    rest = expected.slice(k);
  }
  const live = new ChalkSurface();
  live.copyFrom(base);
  const runs: Run[] = [];
  for (const e of rest) {
    yield* paintSteps(live, e);
    noteRun(runs, e.key, 0, e.p);
  }
  b.base = base;
  b.baseKeys = baseKeys;
  b.live = live;
  b.runs = runs;
  live.markAll();
}

/** Bring a board's picture up to the doc (and the pen). */
function syncBoard(itemId: string, b: Board, now: number): void {
  if (b.job) return; // the job re-syncs when it lands
  const expected = expectedOf(itemId, b, now);
  // The base must still be the first entries, unchanged; else start over.
  let baseOk = b.baseKeys.length <= expected.length;
  for (let i = 0; baseOk && i < b.baseKeys.length; i++) {
    const k = b.baseKeys[i];
    const e = expected[i];
    baseOk = e.key === k.key && e.p.length === k.len && samePrefix(e.p, k.p, k.len);
  }
  const after = baseOk ? expected.slice(b.baseKeys.length) : expected;
  // Note which entries changed, for settling.
  const lens = new Map<string, number>();
  for (const r of b.runs) lens.set(r.key, Math.max(lens.get(r.key) ?? 0, r.to));
  for (const e of after) {
    if (lens.get(e.key) !== e.p.length || !b.changedAt.has(e.key)) b.changedAt.set(e.key, now);
  }
  // The runs must be whole entries in order, from byte 0, only the last one
  // short of its entry's length; else repaint from the base.
  let consistent = baseOk && b.runs.length <= after.length;
  for (let i = 0; consistent && i < b.runs.length; i++) {
    const r = b.runs[i];
    const e = after[i];
    consistent =
      r.key === e.key && r.from === 0 && r.to <= e.p.length && samePrefix(e.p, r.p, r.to) && (r.to === e.p.length || i === b.runs.length - 1);
  }
  const done = consistent ? b.runs.length : 0;
  let work = 0;
  if (done > 0) work += segmentsFrom(after[done - 1].p, b.runs[done - 1].to);
  for (let i = done; i < after.length; i++) work += segmentsFrom(after[i].p, 0);
  if (work > SYNC_SEGMENTS || !baseOk) {
    b.job = paintJob(b, expected, !baseOk || b.baseKeys.length === 0, now);
    return;
  }
  if (!consistent) {
    b.live.copyFrom(b.base);
    b.runs = [];
  }
  if (done > 0) {
    const last = b.runs[done - 1];
    const e = after[done - 1];
    if (last.to < e.p.length) paintRun(b, e.tool, e.key, e.p, last.to);
  }
  for (let i = done; i < after.length; i++) paintRun(b, after[i].tool, after[i].key, after[i].p, 0);
  // Forget change times of entries that are gone or folded.
  if (b.changedAt.size > b.runs.length + 32) {
    const keep = new Set(b.runs.map((r) => r.key));
    for (const k of b.changedAt.keys()) if (!keep.has(k)) b.changedAt.delete(k);
  }
}

/** The first run is still `e`, whole, from byte 0. */
const firstRunIs = (b: Board, e: ChalkEntry): boolean => {
  const r = b.runs[0];
  return !!r && r.from === 0 && r.key === e.key && r.to === e.p.length && samePrefix(e.p, r.p, r.to);
};

/** `e` is now in the base: its run and change time go. */
function settle(b: Board, e: ChalkEntry): void {
  b.baseKeys.push({ key: e.key, len: e.p.length, p: e.p });
  b.runs.shift();
  b.changedAt.delete(e.key);
}

/**
 * Move settled runs into the base, a little at a time (never while a job
 * runs: it paints from the base). A small entry folds in at once; a big one
 * paints onto a copy of the base over as many frames as it takes, and lands
 * only if nothing moved under it meanwhile.
 */
function foldSettled(itemId: string, b: Board, now: number): void {
  if (b.job) {
    b.fold = null;
    return;
  }
  const t0 = clock();
  let shown: ChalkEntry[] | null = null;
  while (clock() - t0 < FOLD_BUDGET_MS) {
    const f = b.fold;
    if (f) {
      if (!runSteps(f.job, FOLD_BUDGET_MS - (clock() - t0))) return;
      b.fold = null;
      if (f.from !== b.base || f.baseLen !== b.baseKeys.length || !firstRunIs(b, f.entry)) {
        b.spare = f.surface;
        continue;
      }
      b.spare = b.base;
      b.base = f.surface;
      settle(b, f.entry);
      continue;
    }
    if (b.runs.length <= KEEP_RUNS) return;
    const r = b.runs[0];
    if (r.from !== 0 || r.key === b.pen?.key || now - (b.changedAt.get(r.key) ?? now) < SETTLE_MS) return;
    // The run must be its entry, whole, as the doc holds it now.
    shown ??= readChalkBoard(itemId, now).shown;
    const e = shown[b.baseKeys.length];
    if (!e || !firstRunIs(b, e)) return;
    if (segmentsFrom(e.p, 0) <= JOB_SLICE) {
      const pts = pointsOf(e.p);
      if (pts) b.base.applyPoints(e.tool, pts);
      settle(b, e);
      continue;
    }
    const surface = b.spare ?? new ChalkSurface();
    b.spare = null;
    surface.copyFrom(b.base);
    b.fold = { entry: e, from: b.base, baseLen: b.baseKeys.length, surface, job: paintSteps(surface, e) };
  }
}

/** Run a job's steps for up to `budget` ms; true when it has finished. */
function runSteps(job: Generator<void, void, void>, budget: number): boolean {
  const t0 = clock();
  for (;;) {
    if (job.next().done) return true;
    if (clock() - t0 >= budget) return false;
  }
}

/**
 * A board's picture for this frame: runs the open pen's timers (rewrite,
 * close), any repaint or trim in steps, and re-reads the doc when it
 * changed. The furniture's face calls this every frame and paints what
 * `takeDirty` says changed.
 */
export function chalkBoardFrame(itemId: string, now = Date.now()): ChalkSurface {
  const b = boardOf(itemId);
  const pen = b.pen;
  if (pen) {
    if (!pen.down && now - pen.lastPointAt >= ENTRY_IDLE_MS) closePen(itemId, b, now);
    else if (pen.bytes.length > pen.flushed && now - pen.lastFlushAt >= ENTRY_FLUSH_MS) flushPen(pen, now);
  }
  if (b.job && runSteps(b.job, JOB_BUDGET_MS)) {
    b.job = null;
    b.seenVersion = -1; // what changed while it ran
    b.lastSyncAt = -Infinity;
  }
  const v = chalkVersion(itemId);
  if (!b.job && v !== b.seenVersion && now - b.lastSyncAt >= SYNC_EVERY_MS) {
    b.seenVersion = v;
    b.lastSyncAt = now;
    syncBoard(itemId, b, now);
  }
  foldSettled(itemId, b, now);
  if (b.trim && runSteps(b.trim, JOB_BUDGET_MS)) b.trim = null;
  return b.live;
}

/** Run a board's repaint to the end now (tests, and a first paint that
 *  should not wait). */
export function finishChalkJobs(itemId: string, now = Date.now()): ChalkSurface {
  const b = boardOf(itemId);
  for (let guard = 0; guard < 8; guard++) {
    b.seenVersion = -1;
    b.lastSyncAt = -Infinity;
    syncBoard(itemId, b, now);
    if (!b.job) break;
    runSteps(b.job, Infinity);
    b.job = null;
  }
  if (b.trim) {
    runSteps(b.trim, Infinity);
    b.trim = null;
  }
  return b.live;
}

function flushPen(pen: Pen, now: number): void {
  writeEntry(pen.key, pen.tool, pen.at, pen.bytes);
  pen.flushed = pen.bytes.length;
  pen.lastFlushAt = now;
}

function closePen(itemId: string, b: Board, now: number): void {
  const pen = b.pen;
  if (!pen) return;
  if (pen.bytes.length > pen.flushed) flushPen(pen, now);
  b.pen = null;
  scheduleTrim(itemId, b, now);
}

/** The writer who just put a tool down trims the board when it's past its
 *  marks: junk at once, the rest in steps (trimJob). */
function scheduleTrim(itemId: string, b: Board, now: number): void {
  if (b.trim || now - b.lastTrimAt < TRIM_EVERY_MS) return;
  if (!deps || !docAlive() || !deps.canTrim()) return;
  b.lastTrimAt = now;
  const { shown, junk } = readChalkBoard(itemId, now);
  deleteKeys(junk);
  if (overBudget(shown)) b.trim = trimJob(itemId, shown, now);
}

function* trimJob(itemId: string, shown: readonly ChalkEntry[], now: number): Generator<void, void, void> {
  const invisible = yield* planInvisibleSteps(planEntries(shown));
  const keys = planChalkTrim(shown, now, invisible);
  if (keys.length === 0 || !deps || !docAlive() || !deps.canTrim()) return;
  // The plan holds only if nothing landed under what it takes while it ran:
  // an entry new or changed since, ordered before the newest it takes (an
  // old entry arriving late), could be chalk a planned wipe still covers.
  const was = new Map(shown.map((e) => [e.key, e] as const));
  let newest: ChalkEntry | null = null;
  for (const k of keys) {
    const e = was.get(k);
    if (e && (!newest || compareEntries(e, newest) > 0)) newest = e;
  }
  for (const e of readChalkBoard(itemId, now).shown) {
    const before = was.get(e.key);
    if (before && before.p === e.p) continue;
    if (newest && compareEntries(e, newest) < 0) return; // the next trim plans again
  }
  // Take only what is still as the plan saw it.
  const still = keys.filter((k) => {
    const raw = marksMap!.get(k) as { p?: unknown } | undefined;
    return raw !== undefined && raw.p === was.get(k)?.p;
  });
  deleteKeys(still);
}

function openPen(itemId: string, b: Board, tool: ChalkTool, now: number): Pen {
  // Stamp after everything this copy has seen on the board.
  expectedOf(itemId, b, now);
  const id = newEntryId();
  const pen: Pen = {
    key: entryKey(itemId, id),
    id,
    tool,
    at: Math.max(now, b.maxAt + 1),
    writer: new StrokeWriter(),
    bytes: new Uint8Array(0),
    flushed: 0,
    openedAt: now,
    lastFlushAt: now,
    lastPointAt: now,
    down: false,
    moved: false,
    last: null,
  };
  b.maxAt = pen.at;
  b.pen = pen;
  return pen;
}

/** Paint what the pen added since it last painted, ahead of the doc. */
function paintPen(b: Board, pen: Pen): void {
  const from = pen.bytes.length;
  pen.bytes = pen.writer.bytes();
  if (pen.bytes.length === from) return;
  // Straight onto the picture, so the line keeps up with the hand. When
  // someone else's entry was painted after this one's start, that paints
  // out of order; the sync after the next rewrite repaints in order.
  paintRun(b, pen.tool, pen.key, pen.bytes, from);
}

/** The pen touches the board at `p` (half cells) with `tool`. */
export function chalkPenDown(itemId: string, tool: ChalkTool, p: ChalkPoint, now = Date.now()): void {
  const b = boardOf(itemId);
  let pen = b.pen;
  if (pen && (pen.tool !== tool || now - pen.openedAt >= ENTRY_MAX_MS || pen.writer.length >= MAX_ENTRY_BYTES - 64)) {
    closePen(itemId, b, now);
    pen = null;
  }
  pen ??= openPen(itemId, b, tool, now);
  pen.writer.lift();
  pen.writer.start(p);
  pen.down = true;
  pen.moved = false;
  pen.last = p;
  pen.lastPointAt = now;
  paintPen(b, pen);
}

/** The pen, still down, moves to `p`. */
export function chalkPenMove(itemId: string, p: ChalkPoint, now = Date.now()): void {
  const b = boards.get(itemId);
  let pen = b?.pen;
  if (!b || !pen || !pen.down) return;
  if (now - pen.openedAt >= ENTRY_MAX_MS || pen.writer.length >= MAX_ENTRY_BYTES - 64) {
    // Carry the stroke on in a fresh entry, from where it got to.
    const from = pen.last;
    const tool = pen.tool;
    closePen(itemId, b, now);
    pen = openPen(itemId, b, tool, now);
    pen.down = true;
    pen.moved = true;
    if (from) pen.writer.start(from);
  }
  if (pen.writer.add(p)) {
    pen.moved = true;
    pen.last = p;
  }
  pen.lastPointAt = now;
  paintPen(b, pen);
}

/** The pen lifts. A tap that never moved leaves a dot. */
export function chalkPenUp(itemId: string, now = Date.now()): void {
  const b = boards.get(itemId);
  const pen = b?.pen;
  if (!b || !pen || !pen.down) return;
  if (!pen.moved && pen.last) {
    for (const q of tapHook(pen.last)) pen.writer.add(q);
  }
  pen.writer.lift();
  pen.down = false;
  pen.lastPointAt = now;
  paintPen(b, pen);
}

/** The tool goes back on the tray (or the player steps away): close the
 *  open entry now. */
export function chalkPenClose(itemId: string, now = Date.now()): void {
  const b = boards.get(itemId);
  if (!b?.pen) return;
  if (b.pen.down) chalkPenUp(itemId, now);
  closePen(itemId, b, now);
}

/** Test seam: drop every board's picture and pen. */
export function resetChalkForTest(): void {
  boards.clear();
  versions.clear();
  deps = null;
  boundDoc = null;
  marksMap = null;
}
