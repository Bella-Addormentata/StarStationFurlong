/**
 * 🖍 Chalkboard marks, the pure part: how a stroke is stored, and how chalk
 * and the eraser change the board's picture.
 *
 * ─── The picture ─────────────────────────────────────────────────────────────
 *
 * The writing area is a grid of CHALK_GRID_W × CHALK_GRID_H cells (about
 * 2.6 mm each), and each cell holds how much chalk is on it, 0 (clean slate)
 * to 1 (solid white). Every client builds that grid itself from the room
 * doc's marks, in the marks' one order (chalkDoc.ts), so everyone sees the
 * same board. Nothing about the picture is stored.
 *
 * A stroke is a polyline. Both tools act per SEGMENT, by how far the tool
 * travels over each cell (its "dwell"): the length of the segment along which
 * the tool's footprint covers the cell's centre. That makes the result
 * exact however the stroke was sampled or split: a stroke written in two
 * halves (two flushes to the doc) paints the same as one written whole.
 *
 *  - CHALK: a round tip of radius CHALK_R. A cell takes
 *      d ← d + (1 − d)·(1 − exp(−CHALK_K · dwell · grain))
 *    where `grain` is the board's own tooth (a fixed noise per cell), so a
 *    line is a little broken and powdery, never a flat vector line.
 *
 *  - ERASER: a felt block, an axis-aligned rectangle ERASER_HW × ERASER_HH
 *    (half sizes, cells). It is not perfect (Dorkmo 2026-11-01): a cell keeps
 *      d ← d · exp(−ERASER_K · dwell · streak)
 *    so one sweep along the block's length leaves about 15 % of the chalk,
 *    a sweep up or down about a third, and every pass after takes the same
 *    share again: a few passes and the board is nearly clean. `streak` is
 *    the felt's unevenness (a fixed noise, mostly across rows). Some of what
 *    a segment lifts (ERASER_SMEAR) settles back as a faint haze over the
 *    cells it just wiped, in proportion to how hard it wiped each, so an
 *    erased word leaves a soft cloud of dust rather than a sharp ghost.
 *
 * ─── The stored stroke ───────────────────────────────────────────────────────
 *
 * Points are integers in half cells (x 0…CHALK_MAX_X, y 0…CHALK_MAX_Y, y
 * down). An entry's bytes hold one or more strokes:
 *
 *   0x80, x lo, x hi, y lo, y hi        a stroke starts at (x, y)
 *   dx, dy                               the next point, each int8 −127…127
 *
 * dx is never −128 (0x80), so the marker can't be mistaken for a step. A
 * longer move is written as several steps on the straight line. Bytes only
 * ever grow at the end while a stroke is drawn (StrokeWriter), so a reader
 * that has painted a prefix paints only the rest.
 */

// ── Grid and tools ───────────────────────────────────────────────────────────

/** Cells across the writing area (the board's face is 1.68 m wide). */
export const CHALK_GRID_W = 640;
/** Cells down the writing area (1.029 m: the same cell size). */
export const CHALK_GRID_H = 392;
/** Stored points are in half cells. */
export const CHALK_SUB = 2;
export const CHALK_MAX_X = CHALK_GRID_W * CHALK_SUB - 1;
export const CHALK_MAX_Y = CHALK_GRID_H * CHALK_SUB - 1;

/** The chalk tip's radius, in cells (an oversized stick: a line ~1.2 cm wide). */
export const CHALK_R = 2.3;
/** Chalk laid per cell of travel: a stroke straight through a cell's centre
 *  (dwell 2·CHALK_R) lays ~92 % on the board's highest grain. */
export const CHALK_K = Math.log(12) / (2 * CHALK_R);
/** The eraser's half width and half height, in cells (a 12 × 7 cm felt). */
export const ERASER_HW = 23;
export const ERASER_HH = 13;
/** Chalk lifted per cell of travel: one sweep along the block's length
 *  (dwell 2·ERASER_HW) leaves 15 %. */
export const ERASER_K = Math.log(1 / 0.15) / (2 * ERASER_HW);
/** The share of what a segment lifts that settles back as haze. */
export const ERASER_SMEAR = 0.1;

export type ChalkTool = 'chalk' | 'eraser';

/** A stored point: integer half cells. */
export interface ChalkPoint {
  x: number;
  y: number;
}

// ── The board's fixed noise ──────────────────────────────────────────────────

/** A 32-bit integer hash (lowbias32), deterministic everywhere. */
function hash32(n: number): number {
  let x = n >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const unit = (n: number): number => hash32(n) / 4294967296;

/** Value noise on a lattice `step` cells apart, bilinear between corners. */
function valueNoise(x: number, y: number, step: number, salt: number): number {
  const gx = x / step;
  const gy = y / step;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (i: number, j: number) => unit((i * 73856093) ^ (j * 19349663) ^ salt);
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

let grainField: Float32Array | null = null;
let streakField: Float32Array | null = null;

/** The board's tooth: how readily each cell takes chalk, 0.4…1. */
export function chalkGrain(): Float32Array {
  if (grainField) return grainField;
  const g = new Float32Array(CHALK_GRID_W * CHALK_GRID_H);
  for (let y = 0; y < CHALK_GRID_H; y++) {
    for (let x = 0; x < CHALK_GRID_W; x++) {
      const fine = unit((x * 2654435761) ^ (y * 40503) ^ 0x9e37);
      const coarse = valueNoise(x, y, 5, 0x51ed);
      g[y * CHALK_GRID_W + x] = 0.4 + 0.6 * Math.min(1, 0.55 * fine + 0.45 * coarse + 0.12);
    }
  }
  grainField = g;
  return g;
}

/** The felt's unevenness: how hard the eraser wipes each cell, 0.8…1.2.
 *  Stretched along rows, so a wipe leaves faint horizontal streaks. */
export function eraserStreak(): Float32Array {
  if (streakField) return streakField;
  const s = new Float32Array(CHALK_GRID_W * CHALK_GRID_H);
  for (let y = 0; y < CHALK_GRID_H; y++) {
    for (let x = 0; x < CHALK_GRID_W; x++) {
      const n = valueNoise(x / 6, y, 2, 0x2c1b);
      s[y * CHALK_GRID_W + x] = 0.8 + 0.4 * n;
    }
  }
  streakField = s;
  return s;
}

// ── The stored stroke ────────────────────────────────────────────────────────

const START = 0x80;
const MAX_STEP = 127;

/** A point as decoded: where, whether it starts a stroke, and the byte
 *  offset just past it (a segment ends at a point that doesn't start one). */
export interface DecodedPoint {
  x: number;
  y: number;
  start: boolean;
  end: number;
}

/** Clamp a point into the grid, in whole half cells. */
export function clampPoint(p: ChalkPoint): ChalkPoint {
  return {
    x: Math.min(CHALK_MAX_X, Math.max(0, Math.round(p.x))),
    y: Math.min(CHALK_MAX_Y, Math.max(0, Math.round(p.y))),
  };
}

/**
 * Bytes for one entry, built as the pen moves: `start` begins a stroke,
 * `add` steps to a point (long moves become several steps). Only ever
 * appends, which is what lets readers paint just what is new.
 */
export class StrokeWriter {
  private buf: Uint8Array;
  private len = 0;
  private last: ChalkPoint | null = null;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  /** True while a stroke is open (a point since the last `start`). */
  get open(): boolean {
    return this.last !== null;
  }

  private push(b: number): void {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b & 0xff;
  }

  start(p: ChalkPoint): void {
    const q = clampPoint(p);
    this.push(START);
    this.push(q.x & 0xff);
    this.push(q.x >> 8);
    this.push(q.y & 0xff);
    this.push(q.y >> 8);
    this.last = q;
  }

  /** Step to `p`. Returns false (and writes nothing) when it hasn't moved. */
  add(p: ChalkPoint): boolean {
    if (!this.last) {
      this.start(p);
      return false;
    }
    const q = clampPoint(p);
    const dx = q.x - this.last.x;
    const dy = q.y - this.last.y;
    if (dx === 0 && dy === 0) return false;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP));
    let px = this.last.x;
    let py = this.last.y;
    for (let i = 1; i <= steps; i++) {
      const nx = this.last.x + Math.round((dx * i) / steps);
      const ny = this.last.y + Math.round((dy * i) / steps);
      this.push(nx - px);
      this.push(ny - py);
      px = nx;
      py = ny;
    }
    this.last = q;
    return true;
  }

  /** End the open stroke; the next point starts a new one. */
  lift(): void {
    this.last = null;
  }

  /** The bytes so far (a copy). */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Every point of an entry, or null when the bytes are not a valid entry
 *  (no leading stroke start, cut short, or a step off the grid). */
export function decodeStrokes(bytes: Uint8Array): DecodedPoint[] | null {
  const out: DecodedPoint[] = [];
  let i = 0;
  let x = -1;
  let y = -1;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === START) {
      if (i + 5 > bytes.length) return null;
      x = bytes[i + 1] | (bytes[i + 2] << 8);
      y = bytes[i + 3] | (bytes[i + 4] << 8);
      i += 5;
      if (x > CHALK_MAX_X || y > CHALK_MAX_Y) return null;
      out.push({ x, y, start: true, end: i });
      continue;
    }
    if (x < 0 || i + 2 > bytes.length) return null;
    const dx = (b << 24) >> 24;
    const dy = (bytes[i + 1] << 24) >> 24;
    i += 2;
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x > CHALK_MAX_X || y > CHALK_MAX_Y) return null;
    out.push({ x, y, start: false, end: i });
  }
  return out;
}

/** A tap (pen down and up without moving) as a small hook, so it leaves a
 *  dot: segments are what paint, and a lone point has none. */
export function tapHook(p: ChalkPoint): ChalkPoint[] {
  return [
    { x: p.x + 2, y: p.y },
    { x: p.x + 1, y: p.y + 2 },
    { x: p.x - 1, y: p.y },
  ];
}

// ── The surface ──────────────────────────────────────────────────────────────

/** A cell rectangle, inclusive. */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Half cells → cell space (a point names the centre of its half cell). */
const toCell = (v: number): number => (v + 0.5) / CHALK_SUB;

const union = (a: CellRect | null, b: CellRect): CellRect =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };

/** The cells a tool's footprint can touch along a segment, or null if none. */
export function segmentRect(tool: ChalkTool, ax: number, ay: number, bx: number, by: number): CellRect | null {
  const rx = tool === 'chalk' ? CHALK_R : ERASER_HW;
  const ry = tool === 'chalk' ? CHALK_R : ERASER_HH;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - rx));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - ry));
  const x1 = Math.min(CHALK_GRID_W - 1, Math.ceil(Math.max(ax, bx) + rx));
  const y1 = Math.min(CHALK_GRID_H - 1, Math.ceil(Math.max(ay, by) + ry));
  return x0 > x1 || y0 > y1 ? null : { x0, y0, x1, y1 };
}

// ── Which cells a segment covers ─────────────────────────────────────────────

/** exp(−z) for z ≥ 0 from a table (linear between 1/512 steps, error under
 *  1e-6): the per-cell exponentials are most of a repaint's cost. */
const EXP_STEPS = 512;
const EXP_MAX = 16;
const EXP_TABLE = (() => {
  const t = new Float64Array(EXP_MAX * EXP_STEPS + 2);
  for (let i = 0; i < t.length; i++) t[i] = Math.exp(-i / EXP_STEPS);
  return t;
})();

export function expNeg(z: number): number {
  if (z <= 0) return 1;
  if (z >= EXP_MAX) return 0;
  const f = z * EXP_STEPS;
  const i = f | 0;
  return EXP_TABLE[i] + (EXP_TABLE[i + 1] - EXP_TABLE[i]) * (f - i);
}

/** The cells one segment covers and, for each, how far the tool travelled
 *  over it times the tool's rate (the exponent, before the board's noise). */
export class Cover {
  idx = new Int32Array(1024);
  z = new Float32Array(1024);
  n = 0;
  rect: CellRect | null = null;

  reserve(cells: number): void {
    if (this.idx.length >= cells) return;
    const size = Math.max(cells, this.idx.length * 2);
    this.idx = new Int32Array(size);
    this.z = new Float32Array(size);
  }
}

/** Chalk: a disc of radius CHALK_R along a→b (cell space). For each cell,
 *  the length of the segment within CHALK_R of its centre. */
export function chalkCover(ax: number, ay: number, bx: number, by: number, out: Cover): void {
  out.n = 0;
  out.rect = null;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const rect = segmentRect('chalk', ax, ay, bx, by);
  if (!rect) return;
  out.reserve((rect.x1 - rect.x0 + 1) * (rect.y1 - rect.y0 + 1));
  const ux = dx / len;
  const uy = dy / len;
  const r2 = CHALK_R * CHALK_R;
  let n = 0;
  for (let y = rect.y0; y <= rect.y1; y++) {
    const py = y + 0.5 - ay;
    for (let x = rect.x0; x <= rect.x1; x++) {
      const px = x + 0.5 - ax;
      const t = px * ux + py * uy;
      const h2 = px * px + py * py - t * t;
      if (h2 >= r2) continue;
      const half = Math.sqrt(r2 - h2);
      const lo = t - half > 0 ? t - half : 0;
      const hi = t + half < len ? t + half : len;
      if (hi <= lo) continue;
      out.idx[n] = y * CHALK_GRID_W + x;
      out.z[n] = CHALK_K * (hi - lo);
      n++;
    }
  }
  out.n = n;
  out.rect = rect;
}

/** The eraser: an axis-aligned ERASER_HW × ERASER_HH block along a→b. For
 *  each cell, the length of the segment over which the block covers it. */
export function eraserCover(ax: number, ay: number, bx: number, by: number, out: Cover): void {
  out.n = 0;
  out.rect = null;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const rect = segmentRect('eraser', ax, ay, bx, by);
  if (!rect) return;
  out.reserve((rect.x1 - rect.x0 + 1) * (rect.y1 - rect.y0 + 1));
  const k = ERASER_K * len;
  let n = 0;
  for (let y = rect.y0; y <= rect.y1; y++) {
    // The stretch of the segment (as 0…1) over which the block covers this row…
    let ty0: number, ty1: number;
    const cy = y + 0.5;
    if (dy === 0) {
      if (Math.abs(ay - cy) > ERASER_HH) continue;
      ty0 = 0;
      ty1 = 1;
    } else {
      ty0 = (cy - ERASER_HH - ay) / dy;
      ty1 = (cy + ERASER_HH - ay) / dy;
      if (ty0 > ty1) { const t = ty0; ty0 = ty1; ty1 = t; }
      if (ty0 < 0) ty0 = 0;
      if (ty1 > 1) ty1 = 1;
      if (ty1 <= ty0) continue;
    }
    for (let x = rect.x0; x <= rect.x1; x++) {
      // …and this column: the cell is under it where both hold.
      let t0 = ty0;
      let t1 = ty1;
      const cx = x + 0.5;
      if (dx === 0) {
        if (Math.abs(ax - cx) > ERASER_HW) continue;
      } else {
        let a = (cx - ERASER_HW - ax) / dx;
        let b = (cx + ERASER_HW - ax) / dx;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
      if (t1 <= t0) continue;
      out.idx[n] = y * CHALK_GRID_W + x;
      out.z[n] = k * (t1 - t0);
      n++;
    }
  }
  out.n = n;
  out.rect = rect;
}

/**
 * The board's chalk, cell by cell. `apply*` paint marks onto it in order;
 * `dirty` collects the cells changed since the last `takeDirty`.
 */
export class ChalkSurface {
  readonly d: Float32Array;
  private dirtyRect: CellRect | null = null;
  private readonly cover = new Cover();
  /** One eraser segment's wipe weights, beside its cover. */
  private weights = new Float32Array(1024);

  constructor() {
    this.d = new Float32Array(CHALK_GRID_W * CHALK_GRID_H);
  }

  /** Become a copy of another surface (the whole picture is dirty). */
  copyFrom(other: ChalkSurface): void {
    this.d.set(other.d);
    this.markAll();
  }

  clear(): void {
    this.d.fill(0);
    this.markAll();
  }

  markAll(): void {
    this.dirtyRect = { x0: 0, y0: 0, x1: CHALK_GRID_W - 1, y1: CHALK_GRID_H - 1 };
  }

  /** The cells changed since the last call, and forget them. */
  takeDirty(): CellRect | null {
    const r = this.dirtyRect;
    this.dirtyRect = null;
    return r;
  }

  /** Paint the segments of `points` that end inside bytes (from, to]: the
   *  part of an entry not yet painted. */
  applyPoints(tool: ChalkTool, points: readonly DecodedPoint[], from = 0, to = Infinity): void {
    for (let i = 1; i < points.length; i++) {
      const b = points[i];
      if (b.start || b.end <= from || b.end > to) continue;
      const a = points[i - 1];
      this.segment(tool, a.x, a.y, b.x, b.y);
    }
  }

  /** One segment between two stored points (half cells). */
  segment(tool: ChalkTool, ax2: number, ay2: number, bx2: number, by2: number): void {
    const ax = toCell(ax2);
    const ay = toCell(ay2);
    const bx = toCell(bx2);
    const by = toCell(by2);
    if (ax === bx && ay === by) return;
    if (tool === 'chalk') this.chalkSegment(ax, ay, bx, by);
    else this.eraserSegment(ax, ay, bx, by);
  }

  private chalkSegment(ax: number, ay: number, bx: number, by: number): void {
    const c = this.cover;
    chalkCover(ax, ay, bx, by, c);
    if (!c.rect) return;
    const grain = chalkGrain();
    const d = this.d;
    for (let j = 0; j < c.n; j++) {
      const i = c.idx[j];
      d[i] += (1 - d[i]) * (1 - expNeg(c.z[j] * grain[i]));
    }
    this.dirtyRect = union(this.dirtyRect, c.rect);
  }

  private eraserSegment(ax: number, ay: number, bx: number, by: number): void {
    const c = this.cover;
    eraserCover(ax, ay, bx, by, c);
    if (!c.rect) return;
    if (this.weights.length < c.n) this.weights = new Float32Array(c.idx.length);
    const weights = this.weights;
    const grain = chalkGrain();
    const streak = eraserStreak();
    const d = this.d;
    let lifted = 0;
    let weightSum = 0;
    for (let j = 0; j < c.n; j++) {
      const i = c.idx[j];
      const wipe = 1 - expNeg(c.z[j] * streak[i]);
      const off = d[i] * wipe;
      d[i] -= off;
      lifted += off;
      const wt = wipe * grain[i];
      weights[j] = wt;
      weightSum += wt;
    }
    // Some of the dust lifted settles back over the wiped cells (none worth
    // painting when the felt passed over clean slate).
    if (lifted > 1e-3 && weightSum > 0) {
      const per = (ERASER_SMEAR * lifted) / weightSum;
      for (let j = 0; j < c.n; j++) {
        const i = c.idx[j];
        const v = d[i] + per * weights[j];
        d[i] = v > 1 ? 1 : v;
      }
    }
    this.dirtyRect = union(this.dirtyRect, c.rect);
  }
}

// ── What a trim may take ─────────────────────────────────────────────────────

/** An entry as the trim plan reads it, oldest first. */
export interface PlanEntry {
  tool: ChalkTool;
  points: readonly DecodedPoint[];
}

/** The cells an entry's segments can touch, or null when it paints nothing. */
export function entryRect(e: PlanEntry): CellRect | null {
  let r: CellRect | null = null;
  const pts = e.points;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].start) continue;
    const s = segmentRect(e.tool, toCell(pts[i - 1].x), toCell(pts[i - 1].y), toCell(pts[i].x), toCell(pts[i].y));
    if (s) r = union(r, s);
  }
  return r;
}

const overlaps = (a: CellRect, b: CellRect): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** A chalk entry no reader could see (every cell it laid now shows less
 *  than this, after the erasing since) may go. */
export const INVISIBLE_BELOW = 0.04;

/**
 * Which entries can be deleted without changing the picture, by index into
 * `entries` (oldest first):
 *  - chalk entries every later wipe has taken below INVISIBLE_BELOW (a
 *    backward pass multiplies each cell by the wipes after it, and an
 *    entry's whole lay is judged at once, not segment by segment), and then
 *  - eraser entries with no kept chalk under them that is older than they
 *    are (they would wipe nothing; younger chalk was never under them).
 * The settled haze those wipes left goes with them: a trim may leave a
 * cleaner board, never a dirtier one.
 */
export function planInvisible(entries: readonly PlanEntry[]): Set<number> {
  const steps = planInvisibleSteps(entries);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** planInvisible in steps, for a caller that spreads it over frames: it
 *  yields after every entry, and returns the set. */
export function* planInvisibleSteps(entries: readonly PlanEntry[]): Generator<void, Set<number>, void> {
  const n = CHALK_GRID_W * CHALK_GRID_H;
  const keep = new Float32Array(n).fill(1);
  const dwell = new Float32Array(n);
  const grain = chalkGrain();
  const streak = eraserStreak();
  const cover = new Cover();
  const gone = new Set<number>();
  const touched: number[] = [];
  for (let e = entries.length - 1; e >= 0; e--) {
    const { tool, points } = entries[e];
    if (tool === 'eraser') {
      for (let i = 1; i < points.length; i++) {
        const b = points[i];
        if (b.start) continue;
        const a = points[i - 1];
        eraserCover(toCell(a.x), toCell(a.y), toCell(b.x), toCell(b.y), cover);
        for (let j = 0; j < cover.n; j++) {
          const c = cover.idx[j];
          keep[c] *= expNeg(cover.z[j] * streak[c]);
        }
      }
      yield;
      continue;
    }
    // Chalk: gather the entry's whole lay, then its best remaining cell.
    touched.length = 0;
    for (let i = 1; i < points.length; i++) {
      const b = points[i];
      if (b.start) continue;
      const a = points[i - 1];
      chalkCover(toCell(a.x), toCell(a.y), toCell(b.x), toCell(b.y), cover);
      for (let j = 0; j < cover.n; j++) {
        const c = cover.idx[j];
        if (dwell[c] === 0) touched.push(c);
        dwell[c] += cover.z[j];
      }
    }
    let best = 0;
    for (const c of touched) {
      const shown = keep[c] * (1 - expNeg(dwell[c] * grain[c]));
      if (shown > best) best = shown;
      dwell[c] = 0;
    }
    if (best < INVISIBLE_BELOW) gone.add(e);
    yield;
  }
  // Wipes with no kept, older chalk under them wipe nothing.
  const rects = entries.map(entryRect);
  for (let e = 0; e < entries.length; e++) {
    if (entries[e].tool !== 'eraser') continue;
    const r = rects[e];
    if (!r) {
      gone.add(e);
      continue;
    }
    let under = false;
    for (let c = 0; c < e && !under; c++) {
      const rc = rects[c];
      if (entries[c].tool === 'chalk' && !gone.has(c) && rc && overlaps(rc, r)) under = true;
    }
    if (!under) gone.add(e);
  }
  return gone;
}

// ── Colour ───────────────────────────────────────────────────────────────────

/** The slate's colour and the chalk's, as 0–255 RGB. */
const SLATE: readonly [number, number, number] = [36, 64, 50];
const CHALK: readonly [number, number, number] = [238, 240, 232];

let slateRgb: Uint8ClampedArray | null = null;

/** The clean board, per cell (a faint mottle so it reads as slate). */
function slateColours(): Uint8ClampedArray {
  if (slateRgb) return slateRgb;
  const out = new Uint8ClampedArray(CHALK_GRID_W * CHALK_GRID_H * 3);
  for (let y = 0; y < CHALK_GRID_H; y++) {
    for (let x = 0; x < CHALK_GRID_W; x++) {
      const i = y * CHALK_GRID_W + x;
      const m = 0.94 + 0.08 * valueNoise(x, y, 24, 0x77a1) + 0.03 * unit((x * 31) ^ (y * 7919) ^ 0x3d);
      out[i * 3] = SLATE[0] * m;
      out[i * 3 + 1] = SLATE[1] * m;
      out[i * 3 + 2] = SLATE[2] * m;
    }
  }
  slateRgb = out;
  return out;
}

/** Write the cells of `rect` into RGBA pixels laid out like the grid. */
export function paintChalkPixels(surface: ChalkSurface, pixels: Uint8ClampedArray, rect: CellRect): void {
  const slate = slateColours();
  const d = surface.d;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const i = y * CHALK_GRID_W + x;
      // A touch of gamma: thin dust shows, solid chalk doesn't blow out.
      const v = d[i] <= 0 ? 0 : Math.pow(d[i], 0.8);
      const s = i * 3;
      const p = i * 4;
      pixels[p] = slate[s] + (CHALK[0] - slate[s]) * v;
      pixels[p + 1] = slate[s + 1] + (CHALK[1] - slate[s + 1]) * v;
      pixels[p + 2] = slate[s + 2] + (CHALK[2] - slate[s + 2]) * v;
      pixels[p + 3] = 255;
    }
  }
}
