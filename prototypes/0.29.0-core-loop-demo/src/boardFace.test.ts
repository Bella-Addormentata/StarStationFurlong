/**
 * 📌📷 A board's face with photo notes (#315 PR 5): the Polaroid shows the
 * shot once the viewer's page holds it, and says why it doesn't otherwise.
 */

import { describe, expect, it } from 'vitest';
import type { BoardFaceNote, BoardScreen } from './boardDoc';
import { PHOTO_LOOK_LINES, paintBoardFace } from './boardFace';

/** A 2D context that records what was drawn and written. */
function recorder() {
  const drawn: unknown[][] = [];
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === 'drawImage') return (...args: unknown[]) => drawn.push(args);
      if (key === 'fillText') return (t: string) => texts.push(t);
      if (key === 'measureText') return (t: string) => ({ width: t.length * 4 });
      if (key in target) return target[key as string];
      return () => undefined;
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, texts };
}

const HASH = 'a'.repeat(64);
const note = (over: Partial<BoardFaceNote>): BoardFaceNote => ({
  id: '0a', text: 'hello', authorName: 'Ann', colour: 'yellow', x: 0.5, y: 0.5, unseen: false, photo: false, ...over,
});
const photoNote = (over: Partial<BoardFaceNote> = {}) =>
  note({
    photo: true,
    text: '',
    attach: { kind: 'blob', hash: HASH, size: 50_000, provider: 'c'.repeat(64), mime: 'image/jpeg', takenAt: 1, caption: 'Our view' },
    ...over,
  });
const screen = (notes: BoardFaceNote[]): BoardScreen => ({ kind: 'open', notes, hiddenCount: 0 });

describe('📷 a Polaroid on the board’s face', () => {
  it('draws the shot, cropped to its frame, once the page holds it', () => {
    const { ctx, drawn, texts } = recorder();
    const img = { width: 512, height: 256 } as unknown as CanvasImageSource & { width: number; height: number };
    paintBoardFace(ctx, screen([photoNote({ photoLook: 'ready' })]), 'cork', (h) => (h === HASH ? { img } : null));
    expect(drawn).toHaveLength(1);
    const [src, sx, sy, sw, sh] = drawn[0] as [unknown, number, number, number, number];
    expect(src).toBe(img);
    // A wide shot is cropped at its sides, never squashed.
    expect(sy).toBe(0);
    expect(sh).toBe(256);
    expect(sx).toBeGreaterThan(0);
    expect(sw).toBeLessThan(512);
    expect(texts).toContain('Our view');
  });

  it('says why the shot isn’t there, in each case', () => {
    for (const look of ['loading', 'fetch', 'unreachable', 'no-node'] as const) {
      const { ctx, drawn, texts } = recorder();
      paintBoardFace(ctx, screen([photoNote({ photoLook: look })]), 'felt', () => null);
      expect(drawn).toHaveLength(0);
      expect(texts).toEqual(expect.arrayContaining([...PHOTO_LOOK_LINES[look]]));
    }
    // Ready, but the picture went from the page meanwhile: the bare frame.
    const { ctx, drawn } = recorder();
    paintBoardFace(ctx, screen([photoNote({ photoLook: 'ready' })]), 'cork', () => null);
    expect(drawn).toHaveLength(0);
  });

  it('captions with the note’s words, then who pinned it, when the shot has no caption', () => {
    const bare = photoNote().attach!;
    const { ctx, texts } = recorder();
    paintBoardFace(ctx, screen([
      photoNote({ id: '1a', attach: { ...bare, caption: undefined }, text: 'Look!' }),
      photoNote({ id: '2b', attach: { ...bare, caption: undefined }, text: '' }),
    ]), 'cork');
    expect(texts).toContain('Look!');
    expect(texts).toContain('— Ann');
  });
});
