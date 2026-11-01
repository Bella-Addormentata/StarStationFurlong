// chalkRender.ts: the stroke bytes, and what chalk and the eraser do to the
// board's picture (Dorkmo 2026-11-01: the eraser leaves a little whiteness
// behind, and a few passes get it close to clean).

import { describe, expect, it } from 'vitest';
import {
  CHALK_GRID_W,
  CHALK_MAX_X,
  CHALK_MAX_Y,
  ChalkSurface,
  INVISIBLE_BELOW,
  StrokeWriter,
  decodeStrokes,
  paintChalkPixels,
  planInvisible,
  tapHook,
  type ChalkPoint,
  type ChalkTool,
} from './chalkRender';

const strokeBytes = (strokes: ChalkPoint[][]): Uint8Array => {
  const w = new StrokeWriter();
  for (const s of strokes) {
    w.start(s[0]);
    for (const p of s.slice(1)) w.add(p);
    w.lift();
  }
  return w.bytes();
};

/** A horizontal line of points every `step` half cells. */
const hline = (x0: number, x1: number, y: number, step = 6): ChalkPoint[] => {
  const out: ChalkPoint[] = [];
  const dir = x1 >= x0 ? 1 : -1;
  for (let x = x0; dir * (x1 - x) >= 0; x += dir * step) out.push({ x, y });
  return out;
};

const paint = (s: ChalkSurface, tool: ChalkTool, strokes: ChalkPoint[][]): void => {
  const pts = decodeStrokes(strokeBytes(strokes));
  if (!pts) throw new Error('bad strokes');
  s.applyPoints(tool, pts);
};

/** Mean chalk over a cell rectangle. */
const meanChalk = (s: ChalkSurface, x0: number, y0: number, x1: number, y1: number): number => {
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    sum += s.d[y * CHALK_GRID_W + x];
    n++;
  }
  return sum / n;
};

/** A block of writing: chalk lines 3 cells apart over cells x 100–200, y 100–130. */
const writeBlock = (s: ChalkSurface): void => {
  const lines: ChalkPoint[][] = [];
  for (let y = 200; y <= 260; y += 6) lines.push(hline(200, 400, y));
  paint(s, 'chalk', lines);
};

/** One eraser pass across that block, along the eraser's length. */
const wipeBlock = (s: ChalkSurface): void => {
  paint(s, 'eraser', [hline(150, 450, 216, 10), hline(450, 150, 244, 10)]);
};

describe('stroke bytes', () => {
  it('round-trip strokes, splitting long moves into steps', () => {
    const strokes = [
      [{ x: 10, y: 20 }, { x: 15, y: 18 }, { x: 600, y: 700 }],
      [{ x: CHALK_MAX_X, y: CHALK_MAX_Y }, { x: 0, y: 0 }],
    ];
    const pts = decodeStrokes(strokeBytes(strokes));
    expect(pts).not.toBeNull();
    const starts = pts!.filter((p) => p.start).map((p) => [p.x, p.y]);
    expect(starts).toEqual([[10, 20], [CHALK_MAX_X, CHALK_MAX_Y]]);
    // Every stroke's last point is where it was sent, exactly.
    const ends = pts!.filter((p, i) => !p.start && (i === pts!.length - 1 || pts![i + 1].start)).map((p) => [p.x, p.y]);
    expect(ends).toEqual([[600, 700], [0, 0]]);
    // No step is longer than an int8 holds.
    for (let i = 1; i < pts!.length; i++) {
      if (pts![i].start) continue;
      expect(Math.abs(pts![i].x - pts![i - 1].x)).toBeLessThanOrEqual(127);
      expect(Math.abs(pts![i].y - pts![i - 1].y)).toBeLessThanOrEqual(127);
    }
  });

  it('clamps points into the grid and skips moves that go nowhere', () => {
    const w = new StrokeWriter();
    w.start({ x: -40, y: 99999 });
    expect(w.add({ x: -3, y: 100000 })).toBe(false);
    expect(w.add({ x: 5, y: 3 })).toBe(true);
    const pts = decodeStrokes(w.bytes())!;
    expect(pts[0]).toMatchObject({ x: 0, y: CHALK_MAX_Y, start: true });
    expect(pts[pts.length - 1]).toMatchObject({ x: 5, y: 3 });
  });

  it('refuses bytes that are not an entry', () => {
    expect(decodeStrokes(new Uint8Array([1, 2]))).toBeNull(); // no stroke start
    expect(decodeStrokes(new Uint8Array([0x80, 1, 0, 1]))).toBeNull(); // cut short
    expect(decodeStrokes(new Uint8Array([0x80, 0xff, 0x7f, 0, 0]))).toBeNull(); // off the grid
    expect(decodeStrokes(new Uint8Array([0x80, 0, 0, 0, 0, 0xff, 0]))).toBeNull(); // steps off the left edge
    expect(decodeStrokes(new Uint8Array([0x80, 0, 0, 0, 0, 5]))).toBeNull(); // half a step
  });

  it('only ever appends while a stroke is drawn', () => {
    const w = new StrokeWriter(4);
    w.start({ x: 100, y: 100 });
    const a = w.bytes();
    w.add({ x: 120, y: 90 });
    w.add({ x: 400, y: 90 });
    const b = w.bytes();
    expect([...b.slice(0, a.length)]).toEqual([...a]);
  });
});

describe('chalk', () => {
  it('lays a powdery line of about its width along the stroke', () => {
    const s = new ChalkSurface();
    paint(s, 'chalk', [hline(100, 300, 200)]);
    // Along the line (cell y = 100): mostly white, but not flat.
    const row = Array.from({ length: 80 }, (_, i) => s.d[100 * CHALK_GRID_W + 60 + i]);
    const mean = row.reduce((a, b) => a + b, 0) / row.length;
    expect(mean).toBeGreaterThan(0.6);
    expect(Math.min(...row)).toBeLessThan(Math.max(...row) - 0.1);
    // Nothing a few cells off it.
    expect(meanChalk(s, 60, 104, 140, 110)).toBe(0);
  });

  it('paints the same whether a stroke arrives whole or in two halves', () => {
    const whole = new ChalkSurface();
    const halves = new ChalkSurface();
    const w = new StrokeWriter();
    w.start({ x: 50, y: 50 });
    for (let i = 1; i < 40; i++) w.add({ x: 50 + i * 9, y: 50 + Math.round(20 * Math.sin(i / 4)) });
    const half = w.bytes();
    for (let i = 40; i < 80; i++) w.add({ x: 50 + i * 9, y: 50 + Math.round(20 * Math.sin(i / 4)) });
    const all = w.bytes();
    whole.applyPoints('chalk', decodeStrokes(all)!);
    halves.applyPoints('chalk', decodeStrokes(half)!);
    halves.applyPoints('chalk', decodeStrokes(all)!, half.length);
    expect(Array.from(halves.d)).toEqual(Array.from(whole.d));
  });

  it('leaves a dot for a tap', () => {
    const s = new ChalkSurface();
    const p = { x: 400, y: 400 };
    paint(s, 'chalk', [[p, ...tapHook(p)]]);
    expect(s.d[200 * CHALK_GRID_W + 200]).toBeGreaterThan(0.3);
  });
});

describe('the eraser', () => {
  it('leaves a little whiteness behind, and each pass takes most of what is left', () => {
    const s = new ChalkSurface();
    writeBlock(s);
    const written = meanChalk(s, 100, 100, 200, 130);
    expect(written).toBeGreaterThan(0.4);
    const after: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      wipeBlock(s);
      after.push(meanChalk(s, 100, 100, 200, 130));
    }
    // One pass: a faint cloud, not clean.
    expect(after[0]).toBeGreaterThan(0.02);
    expect(after[0]).toBeLessThan(0.2 * written);
    // Every pass after gets closer to clean, and three get it nearly there.
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeLessThan(after[i - 1]);
    expect(after[2]).toBeLessThan(0.01);
  });

  it('smears some dust over the wiped cells instead of leaving a sharp ghost', () => {
    const s = new ChalkSurface();
    paint(s, 'chalk', [hline(200, 400, 230)]); // one line, cell row ~115
    const near = () => meanChalk(s, 110, 121, 190, 126); // 6–11 cells below it
    expect(near()).toBe(0);
    paint(s, 'eraser', [hline(150, 450, 230, 10)]);
    // A faint haze where there was clean slate, under the felt.
    expect(near()).toBeGreaterThan(0);
    expect(near()).toBeLessThan(0.02);
    // Away from any chalk, a wipe leaves the slate clean.
    const clean = new ChalkSurface();
    paint(clean, 'eraser', [hline(100, 900, 600, 10)]);
    expect(clean.d.every((v) => v === 0)).toBe(true);
  });

  it('only wipes under the felt', () => {
    const s = new ChalkSurface();
    paint(s, 'chalk', [hline(100, 1100, 100), hline(100, 1100, 600)]);
    const far = meanChalk(s, 50, 300, 550, 300);
    paint(s, 'eraser', [hline(100, 1100, 100, 12)]);
    expect(meanChalk(s, 50, 300, 550, 300)).toBe(far);
  });
});

describe('planInvisible', () => {
  it('lets go of chalk wiped to nothing, and wipes with nothing left under them', () => {
    const entries = [
      { tool: 'chalk' as const, strokes: [hline(200, 400, 230)] }, // 0: wiped hard below
      { tool: 'chalk' as const, strokes: [hline(800, 1000, 600)] }, // 1: never wiped
      { tool: 'eraser' as const, strokes: [hline(150, 450, 230, 8)] }, // 2: wipes 0
      { tool: 'eraser' as const, strokes: [hline(450, 150, 230, 8)] }, // 3
      { tool: 'eraser' as const, strokes: [hline(150, 450, 230, 8)] }, // 4
      { tool: 'eraser' as const, strokes: [hline(1100, 1200, 100, 8)] }, // 5: wipes empty slate
      { tool: 'chalk' as const, strokes: [hline(200, 400, 230)] }, // 6: written after the wipes
    ].map((e) => ({ tool: e.tool, points: decodeStrokes(strokeBytes(e.strokes))! }));
    const gone = planInvisible(entries);
    expect([...gone].sort()).toEqual([0, 2, 3, 4, 5]);
  });

  it('keeps chalk a wipe only dimmed', () => {
    const entries = [
      { tool: 'chalk' as const, strokes: [hline(200, 400, 230)] },
      { tool: 'eraser' as const, strokes: [hline(150, 450, 230, 8)] },
    ].map((e) => ({ tool: e.tool, points: decodeStrokes(strokeBytes(e.strokes))! }));
    // One pass leaves ~15 %, well over INVISIBLE_BELOW: both stay.
    expect(INVISIBLE_BELOW).toBeLessThan(0.15);
    expect(planInvisible(entries).size).toBe(0);
  });
});

describe('pixels', () => {
  it('paints slate where the board is clean and near white where chalk is solid', () => {
    const s = new ChalkSurface();
    s.d[0] = 1;
    const px = new Uint8ClampedArray(CHALK_GRID_W * 2 * 4);
    paintChalkPixels(s, px, { x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(px[0]).toBeGreaterThan(220);
    expect(px[4]).toBeLessThan(60);
    expect(px[5]).toBeGreaterThan(px[4]); // slate is green
    expect(px[7]).toBe(255);
  });
});
