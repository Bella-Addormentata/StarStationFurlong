// chalkDoc.ts: the chalkboard's room-doc record, the paint order, trims, and
// each board's picture (painted as entries arrive, the local pen ahead of the
// doc), which must always end up as a fresh paint of the doc would make it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CHALK_MARKS_MAP,
  ENTRY_FLUSH_MS,
  ENTRY_IDLE_MS,
  ENTRY_MAX_MS,
  MAX_ENTRY_BYTES,
  MAX_SHOWN_ENTRIES,
  TRIM_AT_ENTRIES,
  TRIM_SPARES_MS,
  TRIM_TO_ENTRIES,
  bindChalkDoc,
  chalkBoardFrame,
  chalkPenClose,
  chalkPenDown,
  chalkPenMove,
  chalkPenUp,
  compareEntries,
  countChalkboards,
  entryFromWire,
  entryKey,
  entryToWire,
  finishChalkJobs,
  disposeChalkboard,
  forgetChalkboard,
  planChalkTrim,
  pointsOf,
  readChalkBoard,
  readChalkEntries,
  resetChalkForTest,
  setChalkDeps,
  trimChalkboard,
  type ChalkEntry,
} from './chalkDoc';
import { ChalkSurface, INVISIBLE_BELOW, StrokeWriter, type ChalkPoint, type ChalkTool } from './chalkRender';

const BOARD = 'chalkboard-1-test';
const T0 = 1_800_000_000_000;

const bytesOf = (strokes: ChalkPoint[][]): Uint8Array => {
  const w = new StrokeWriter();
  for (const s of strokes) {
    w.start(s[0]);
    for (const p of s.slice(1)) w.add(p);
    w.lift();
  }
  return w.bytes();
};

const line = (x0: number, y0: number, x1: number, y1: number, n = 20): ChalkPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: Math.round(x0 + ((x1 - x0) * i) / n), y: Math.round(y0 + ((y1 - y0) * i) / n) }));

/** What a reader joining now would paint: every shown entry, in order. */
const freshPaint = (itemId = BOARD, now = T0 + 60_000): ChalkSurface => {
  const s = new ChalkSurface();
  for (const e of readChalkBoard(itemId, now).shown) s.applyPoints(e.tool, pointsOf(e.p)!);
  return s;
};

const same = (a: ChalkSurface, b: ChalkSurface): boolean => {
  for (let i = 0; i < a.d.length; i++) if (Math.abs(a.d[i] - b.d[i]) > 1e-6) return false;
  return true;
};

let doc: Y.Doc;
let marks: Y.Map<unknown>;

/** Another player's entry, as their client would write it. */
const remote = (id: string, tool: ChalkTool, at: number, strokes: ChalkPoint[][]): void => {
  marks.set(entryKey(BOARD, id), entryToWire(tool, at, bytesOf(strokes)));
};

beforeEach(() => {
  resetChalkForTest();
  doc = new Y.Doc();
  bindChalkDoc(doc);
  marks = doc.getMap(CHALK_MARKS_MAP);
  setChalkDeps({ canTrim: () => true });
});

afterEach(() => resetChalkForTest());

describe('the record', () => {
  it('reads back what a writer stores, and refuses anything else', () => {
    const p = bytesOf([line(10, 10, 300, 40)]);
    expect(entryFromWire(entryToWire('chalk', T0, p), T0)).toEqual({ tool: 'chalk', at: T0, p });
    expect(entryFromWire(entryToWire('eraser', T0, p), T0)?.tool).toBe('eraser');
    const bad: unknown[] = [
      null,
      'x',
      { v: 2, k: 'c', at: T0, p },
      { v: 1, k: 'x', at: T0, p },
      { v: 1, k: 'c', at: 1.5, p },
      { v: 1, k: 'c', at: T0 + 2 * 24 * 3600 * 1000, p }, // far ahead
      { v: 1, k: 'c', at: T0, p: [1, 2, 3] },
      { v: 1, k: 'c', at: T0, p: new Uint8Array(0) },
      { v: 1, k: 'c', at: T0, p: new Uint8Array(MAX_ENTRY_BYTES + 1).fill(0x80) },
      { v: 1, k: 'c', at: T0, p: new Uint8Array([1, 2, 3]) }, // not strokes
    ];
    for (const raw of bad) expect(entryFromWire(raw, T0)).toBeNull();
  });

  it('orders by stamp, then id, and keeps only the board’s own valid keys', () => {
    const p = bytesOf([line(10, 10, 300, 40)]);
    const entries: Array<[string, unknown]> = [
      [entryKey(BOARD, 'bbbbbbbb'), entryToWire('chalk', T0 + 5, p)],
      [entryKey(BOARD, 'aaaaaaaa'), entryToWire('eraser', T0 + 5, p)],
      [entryKey(BOARD, 'cccccccc'), entryToWire('chalk', T0 + 1, p)],
      [entryKey('other-board', 'dddddddd'), entryToWire('chalk', T0, p)],
      [entryKey(BOARD, 'BAD ID!'), entryToWire('chalk', T0, p)],
      [entryKey(BOARD, 'eeeeeeee'), { v: 1, k: 'c', at: T0 }],
    ];
    const { shown, junk } = readChalkEntries(entries, BOARD, T0);
    expect(shown.map((e) => e.id)).toEqual(['cccccccc', 'aaaaaaaa', 'bbbbbbbb']);
    expect(junk.sort()).toEqual([entryKey(BOARD, 'BAD ID!'), entryKey(BOARD, 'eeeeeeee')].sort());
    expect(compareEntries({ at: 1, id: 'b' }, { at: 1, id: 'a' })).toBeGreaterThan(0);
  });

  it('paints only a board’s newest entries, and counts the rest as junk', () => {
    const p = bytesOf([line(10, 10, 30, 40, 2)]);
    const entries: Array<[string, unknown]> = [];
    for (let i = 0; i < MAX_SHOWN_ENTRIES + 5; i++) {
      entries.push([entryKey(BOARD, `e${String(i).padStart(7, '0')}`), entryToWire('chalk', T0 + i, p)]);
    }
    const { shown, junk } = readChalkEntries(entries, BOARD, T0 + TRIM_SPARES_MS + 2);
    expect(shown).toHaveLength(MAX_SHOWN_ENTRIES);
    expect(shown[0].at).toBe(T0 + 5);
    // Past the cap and older than TRIM_SPARES_MS: junk. A younger one may be
    // its writer's open entry, so it waits, unshown.
    expect(junk).toEqual(entries.slice(0, 3).map(([k]) => k));
    expect(readChalkEntries(entries, BOARD, T0 + 10_000).junk).toEqual([]);
  });

  it('counts chalkboards among furniture', () => {
    expect(countChalkboards([{ kind: 'chalkboard' }, { kind: 'corkboard' }, { kind: 'chalkboard' }])).toBe(2);
  });
});

describe('the pen', () => {
  it('paints at once, rewrites its entry as it grows, and closes it when idle', () => {
    let now = T0;
    chalkPenDown(BOARD, 'chalk', { x: 100, y: 100 }, now);
    for (let i = 1; i <= 10; i++) chalkPenMove(BOARD, { x: 100 + i * 12, y: 100 }, (now += 16));
    // Painted on this screen already, not yet in the doc.
    const live = chalkBoardFrame(BOARD, now);
    expect(live.d.some((v) => v > 0.5)).toBe(true);
    expect(readChalkBoard(BOARD, now).shown).toHaveLength(0);
    // The rewrite lands after ENTRY_FLUSH_MS.
    now += ENTRY_FLUSH_MS;
    chalkBoardFrame(BOARD, now);
    const first = readChalkBoard(BOARD, now).shown;
    expect(first).toHaveLength(1);
    chalkPenMove(BOARD, { x: 300, y: 140 }, (now += 16));
    chalkPenUp(BOARD, (now += 16));
    now += ENTRY_FLUSH_MS;
    chalkBoardFrame(BOARD, now);
    const second = readChalkBoard(BOARD, now).shown;
    expect(second).toHaveLength(1); // the same entry, longer
    expect(second[0].key).toBe(first[0].key);
    expect(second[0].p.length).toBeGreaterThan(first[0].p.length);
    // Pen up long enough: the next stroke starts a new entry.
    now += ENTRY_IDLE_MS;
    chalkBoardFrame(BOARD, now);
    chalkPenDown(BOARD, 'chalk', { x: 500, y: 500 }, (now += 16));
    chalkPenMove(BOARD, { x: 560, y: 520 }, (now += 16));
    chalkPenClose(BOARD, (now += 16));
    expect(readChalkBoard(BOARD, now).shown).toHaveLength(2);
    expect(same(finishChalkJobs(BOARD, now), freshPaint(BOARD, now))).toBe(true);
  });

  it('starts a new entry for the other tool, after ENTRY_MAX_MS, and stamps it after what it has seen', () => {
    let now = T0;
    remote('zzzzzzzz', 'chalk', T0 + 60_000, [line(0, 0, 200, 200)]); // a peer whose clock runs a minute ahead
    chalkBoardFrame(BOARD, now);
    chalkPenDown(BOARD, 'chalk', { x: 10, y: 10 }, now);
    for (let t = 0; t < ENTRY_MAX_MS + 500; t += 50) chalkPenMove(BOARD, { x: 10 + (t % 400), y: 10 + ((t / 50) % 2) * 30 }, (now = T0 + t));
    chalkPenUp(BOARD, now);
    chalkPenDown(BOARD, 'eraser', { x: 50, y: 50 }, (now += 16));
    chalkPenMove(BOARD, { x: 250, y: 60 }, (now += 16));
    chalkPenClose(BOARD, (now += 16));
    const shown = readChalkBoard(BOARD, now).shown;
    const mine = shown.filter((e) => e.id !== 'zzzzzzzz');
    expect(mine.length).toBeGreaterThanOrEqual(3); // chalk rolled over once, then the eraser
    expect(mine[mine.length - 1].tool).toBe('eraser');
    // Every one of mine paints after the peer's, whatever the clocks say.
    for (const e of mine) expect(e.at).toBeGreaterThan(T0 + 60_000);
    expect(same(finishChalkJobs(BOARD, now), freshPaint(BOARD, now))).toBe(true);
  });

  it('leaves a dot for a tap', () => {
    chalkPenDown(BOARD, 'chalk', { x: 400, y: 400 }, T0);
    chalkPenUp(BOARD, T0 + 50);
    chalkPenClose(BOARD, T0 + 60);
    const [e] = readChalkBoard(BOARD, T0 + 100).shown;
    expect(pointsOf(e.p)!.length).toBeGreaterThan(1);
    expect(freshPaint(BOARD, T0 + 100).d.some((v) => v > 0.3)).toBe(true);
  });
});

describe('the picture', () => {
  it('matches a fresh paint when two people draw over each other at once', () => {
    let now = T0;
    // A peer erases across where we write, interleaved with our flushes.
    chalkPenDown(BOARD, 'chalk', { x: 100, y: 200 }, now);
    for (let i = 1; i <= 60; i++) {
      now += 20;
      chalkPenMove(BOARD, { x: 100 + i * 10, y: 200 + (i % 2) * 8 }, now);
      if (i % 15 === 0) remote(`peer${i}aaaa`, 'eraser', now - 30, [line(120 + i * 6, 150, 160 + i * 6, 260, 6)]);
      chalkBoardFrame(BOARD, now);
    }
    chalkPenClose(BOARD, (now += 20));
    for (let k = 0; k < 20; k++) chalkBoardFrame(BOARD, (now += 100));
    expect(same(finishChalkJobs(BOARD, now), freshPaint(BOARD, now))).toBe(true);
  });

  it('repaints when an entry lands before what it has painted, and when one goes', () => {
    let now = T0 + 100_000;
    for (let i = 0; i < 30; i++) remote(`m${String(i).padStart(7, '0')}`, i % 4 === 3 ? 'eraser' : 'chalk', T0 + i * 1000, [line(40 * i, 20, 40 * i + 300, 600, 12)]);
    for (let k = 0; k < 200; k++) chalkBoardFrame(BOARD, (now += 50)); // settles and folds into the base
    expect(same(chalkBoardFrame(BOARD, now), freshPaint(BOARD, now))).toBe(true);
    // A late entry from long ago (a peer that was offline): before the base.
    remote('late0000', 'eraser', T0 + 500, [line(0, 300, 1279, 320, 30)]);
    for (let k = 0; k < 200; k++) chalkBoardFrame(BOARD, (now += 50));
    expect(same(chalkBoardFrame(BOARD, now), freshPaint(BOARD, now))).toBe(true);
    // One goes (a trim elsewhere).
    marks.delete(entryKey(BOARD, 'm0000005'));
    for (let k = 0; k < 200; k++) chalkBoardFrame(BOARD, (now += 50));
    expect(same(chalkBoardFrame(BOARD, now), freshPaint(BOARD, now))).toBe(true);
  });

  it('folds big settled entries into its base over frames, and still matches', () => {
    let now = T0;
    for (let i = 0; i < 16; i++) {
      const pts: ChalkPoint[] = [];
      for (let j = 0; j < 200; j++) pts.push({ x: 100 + ((j * 37 + i * 13) % 1000), y: 50 + ((j * 53 + i * 11) % 680) });
      remote(`f${String(i).padStart(7, '0')}`, i % 3 === 2 ? 'eraser' : 'chalk', now, [pts]);
      for (let k = 0; k < 4; k++) chalkBoardFrame(BOARD, (now += 16));
    }
    for (let k = 0; k < 600; k++) chalkBoardFrame(BOARD, (now += 50)); // settles; folds land
    expect(same(chalkBoardFrame(BOARD, now), freshPaint(BOARD, now))).toBe(true);
    // An entry folded into the base is gone (a trim elsewhere): a repaint.
    marks.delete(entryKey(BOARD, 'f0000001'));
    for (let k = 0; k < 600; k++) chalkBoardFrame(BOARD, (now += 50));
    expect(same(chalkBoardFrame(BOARD, now), freshPaint(BOARD, now))).toBe(true);
  });

  it('paints a heavy board over several frames rather than in one', () => {
    for (let i = 0; i < 40; i++) {
      const pts: ChalkPoint[] = [];
      for (let j = 0; j < 200; j++) pts.push({ x: 100 + ((j * 37) % 1000), y: 50 + ((j * 53 + i * 11) % 680) });
      remote(`h${String(i).padStart(7, '0')}`, i % 2 ? 'eraser' : 'chalk', T0 + i, [pts]);
    }
    const first = chalkBoardFrame(BOARD, T0 + 100_000);
    expect(first.d.every((v) => v === 0)).toBe(true); // still the old (blank) picture
    let now = T0 + 100_000;
    let s = first;
    for (let k = 0; k < 2000 && s === first; k++) s = chalkBoardFrame(BOARD, (now += 16));
    expect(s).not.toBe(first);
    expect(same(s, freshPaint(BOARD, now))).toBe(true);
  });
});

describe('trims', () => {
  const fill = (n: number, at0: number): void => {
    for (let i = 0; i < n; i++) remote(`t${String(i).padStart(7, '0')}`, 'chalk', at0 + i, [line(10 + (i % 60) * 20, 10 + Math.floor(i / 60) * 60, 20 + (i % 60) * 20, 40 + Math.floor(i / 60) * 60, 3)]);
  };

  it('do nothing on a board under its marks', () => {
    fill(TRIM_AT_ENTRIES, T0);
    expect(planChalkTrim(readChalkBoard(BOARD, T0 + 10 * TRIM_SPARES_MS).shown, T0 + 10 * TRIM_SPARES_MS)).toEqual([]);
  });

  it('take what was wiped to nothing first, and spare everything young', () => {
    fill(TRIM_AT_ENTRIES - 2, T0);
    // Wipe the first two rows clean, hard, several times.
    for (let k = 0; k < 6; k++) {
      remote(`w${k}aaaaaa`, 'eraser', T0 + 10_000 + k, [line(0, 22, 1279, 22, 60), line(1279, 18, 0, 18, 60), line(0, 85, 1279, 85, 60)]);
    }
    // And one young entry, which no trim may take.
    remote('young000', 'chalk', T0 + 10 * TRIM_SPARES_MS - 1000, [line(10, 700, 300, 700)]);
    const now = T0 + 10 * TRIM_SPARES_MS;
    const before = freshPaint(BOARD, now);
    const n = trimChalkboard(BOARD, now);
    expect(n).toBe(2 * 60 + 6); // the first two rows' chalk, and the wipes
    const keys = readChalkBoard(BOARD, now).shown.map((e) => e.id);
    expect(keys).toContain('young000');
    expect(keys.some((k) => k.startsWith('w'))).toBe(false);
    // Nothing anyone could see changed: no cell moved by INVISIBLE_BELOW.
    const after = freshPaint(BOARD, now);
    let worst = 0;
    for (let i = 0; i < after.d.length; i++) worst = Math.max(worst, Math.abs(before.d[i] - after.d[i]));
    expect(worst).toBeLessThan(INVISIBLE_BELOW);
  });

  it('give up a stepped plan when an older entry lands under it meanwhile', () => {
    fill(TRIM_AT_ENTRIES - 2, T0);
    for (let k = 0; k < 6; k++) {
      remote(`w${k}aaaaaa`, 'eraser', T0 + 10_000 + k, [line(0, 22, 1279, 22, 60), line(1279, 18, 0, 18, 60), line(0, 85, 1279, 85, 60)]);
    }
    let now = T0 + 10 * TRIM_SPARES_MS;
    chalkPenDown(BOARD, 'chalk', { x: 10, y: 760 }, now);
    chalkPenMove(BOARD, { x: 200, y: 760 }, (now += 16));
    chalkPenClose(BOARD, (now += 16)); // the trim starts, in steps
    chalkBoardFrame(BOARD, (now += 16));
    // A late copy brings chalk from before the wipes, under them.
    remote('late0000', 'chalk', T0 + 5_000, [line(10, 20, 1200, 20)]);
    for (let k = 0; k < 400; k++) chalkBoardFrame(BOARD, (now += 16));
    const ids = readChalkBoard(BOARD, now).shown.map((e) => e.id);
    expect(ids.filter((k) => k.startsWith('w'))).toHaveLength(6); // the wipes still cover it
    expect(ids).toContain('late0000');
  });

  it('take the oldest when nothing is invisible, down to the TRIM_TO marks', () => {
    fill(TRIM_AT_ENTRIES + 40, T0);
    const now = T0 + 10 * TRIM_SPARES_MS;
    trimChalkboard(BOARD, now);
    const shown = readChalkBoard(BOARD, now).shown;
    expect(shown.length).toBe(TRIM_TO_ENTRIES);
    expect(shown[0].id).toBe(`t${String(TRIM_AT_ENTRIES + 40 - TRIM_TO_ENTRIES).padStart(7, '0')}`);
  });

  it('wait for the host’s state', () => {
    fill(TRIM_AT_ENTRIES + 40, T0);
    setChalkDeps({ canTrim: () => false });
    expect(trimChalkboard(BOARD, T0 + 10 * TRIM_SPARES_MS)).toBe(0);
  });

  it('run in steps when a writer puts a tool down on a full board', () => {
    fill(TRIM_AT_ENTRIES + 40, T0);
    let now = T0 + 10 * TRIM_SPARES_MS;
    chalkPenDown(BOARD, 'chalk', { x: 10, y: 760 }, now);
    chalkPenMove(BOARD, { x: 200, y: 760 }, (now += 16));
    chalkPenClose(BOARD, (now += 16));
    const mine = readChalkBoard(BOARD, now).shown.at(-1)!.key;
    for (let k = 0; k < 500 && readChalkBoard(BOARD, now).shown.length > TRIM_TO_ENTRIES; k++) chalkBoardFrame(BOARD, (now += 16));
    const shown = readChalkBoard(BOARD, now).shown;
    expect(shown.length).toBe(TRIM_TO_ENTRIES); // the oldest went…
    expect(shown.at(-1)!.key).toBe(mine); // …and the new line stays
  });
});

describe('a removed board', () => {
  it('gets no marks from a pen that closes after it is gone', () => {
    const layout = doc.getMap('furniture');
    layout.set('sofa-1', { kind: 'sofa', x: 0, z: 0, rot: 0, movable: true });
    layout.set(BOARD, { kind: 'chalkboard', x: 0, z: -5, rot: 0, movable: true });
    let now = T0;
    chalkPenDown(BOARD, 'chalk', { x: 10, y: 10 }, now);
    chalkPenMove(BOARD, { x: 300, y: 40 }, (now += 16));
    chalkBoardFrame(BOARD, (now += ENTRY_FLUSH_MS));
    expect(marks.size).toBe(1); // on the wall: written
    chalkPenMove(BOARD, { x: 500, y: 90 }, (now += 16));
    const was = marks.get([...marks.keys()][0]);
    layout.delete(BOARD); // someone took it down
    chalkPenClose(BOARD, (now += 16)); // the forced step-back closes the pen
    expect(marks.get([...marks.keys()][0])).toBe(was);
  });

  it('lets go of its picture here without touching the doc', () => {
    remote('aaaaaaaa', 'chalk', T0, [line(0, 0, 100, 100)]);
    const first = chalkBoardFrame(BOARD, T0 + 100);
    disposeChalkboard(BOARD);
    expect(marks.size).toBe(1);
    expect(chalkBoardFrame(BOARD, T0 + 200)).not.toBe(first); // a fresh picture
  });

  it('takes its marks with it, and only its own', () => {
    remote('aaaaaaaa', 'chalk', T0, [line(0, 0, 100, 100)]);
    marks.set(entryKey('other-board', 'bbbbbbbb'), entryToWire('chalk', T0, bytesOf([line(0, 0, 100, 100)])));
    expect(forgetChalkboard(BOARD)).toBe(1);
    expect([...marks.keys()]).toEqual([entryKey('other-board', 'bbbbbbbb')]);
  });
});

// Keep the ChalkEntry type in use for readers of this file.
export type { ChalkEntry };
