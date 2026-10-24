/**
 * 🔍 First-person zoom: the wheel and the pinch move the field of view, and
 * never past the limits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOV_MAX, FOV_MIN, FovZoom, clampFov, fovAfterPinch, fovAfterWheel, wheelPixels, wheelTargetZooms,
} from './firstPersonZoom';

describe('wheel', () => {
  it('scrolling up zooms in and down zooms out, by the same step', () => {
    const inward = fovAfterWheel(65, -100);
    const outward = fovAfterWheel(65, 100);
    expect(inward).toBeLessThan(65);
    expect(outward).toBeGreaterThan(65);
    expect(fovAfterWheel(inward, 100)).toBeCloseTo(65, 6);
  });

  it('reads lines and pages as pixels', () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(100);
    expect(wheelPixels({ deltaY: -1, deltaMode: 2 })).toBeLessThan(-100);
    expect(wheelPixels({ deltaY: 42, deltaMode: 0 })).toBe(42);
  });

  it('stops at the limits however far it turns', () => {
    expect(fovAfterWheel(65, -1e6)).toBe(FOV_MIN);
    expect(fovAfterWheel(65, 1e6)).toBe(FOV_MAX);
    expect(fovAfterWheel(65, Number.NaN)).toBe(65);
    expect(clampFov(Number.POSITIVE_INFINITY)).toBe(FOV_MAX);
  });
});

describe('pinch', () => {
  it('fingers apart zooms in, together zooms out', () => {
    expect(fovAfterPinch(50, 100, 200)).toBeLessThan(50);
    expect(fovAfterPinch(50, 200, 100)).toBeGreaterThan(50);
    expect(fovAfterPinch(50, 100, 100)).toBeCloseTo(50, 6);
  });

  it('doubles what is under the fingers when they spread twice as far', () => {
    const half = (deg: number) => Math.tan((deg * Math.PI) / 360);
    expect(half(50) / half(fovAfterPinch(50, 100, 200))).toBeCloseTo(2, 6);
  });

  it('stays inside the limits and ignores a zero spread', () => {
    expect(fovAfterPinch(50, 10, 10000)).toBe(FOV_MIN);
    expect(fovAfterPinch(50, 10000, 10)).toBe(FOV_MAX);
    expect(fovAfterPinch(50, 0, 100)).toBe(50);
  });
});

describe('FovZoom', () => {
  it('eases toward the asked-for view and settles there', () => {
    const z = new FovZoom(65);
    z.wheel(-300);
    const target = z.targetFov();
    const first = z.step(1 / 60);
    expect(first).toBeLessThan(65);
    expect(first).toBeGreaterThan(target);
    for (let i = 0; i < 120; i++) z.step(1 / 60);
    expect(z.step(1 / 60)).toBe(target);
  });

  it('a pinch works from where the zoom stood when it began', () => {
    const z = new FovZoom(50);
    z.wheel(-200);
    const before = z.targetFov();
    z.pinchStart(100);
    z.pinchMove(100);
    expect(z.targetFov()).toBeCloseTo(before, 6);
    z.pinchMove(50);
    expect(z.targetFov()).toBeGreaterThan(before);
    z.pinchEnd();
    z.pinchMove(400);
    expect(z.targetFov()).toBeGreaterThan(before); // ended: no effect
  });

  it('reset goes straight back to the camera’s own view', () => {
    const z = new FovZoom(65);
    z.wheel(500);
    z.step(1 / 60);
    z.reset();
    expect(z.targetFov()).toBe(65);
    expect(z.step(0)).toBe(65);
  });
});

describe('wheelTargetZooms', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Fake = { tagName: string; parentElement: Fake | null; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number; overflow?: string };
  const el = (parent: Fake | null, extra: Partial<Fake> = {}): Fake =>
    ({ tagName: 'DIV', parentElement: parent, scrollHeight: 10, clientHeight: 10, scrollWidth: 10, clientWidth: 10, ...extra });
  const hostOf = (host: Fake) => ({ contains: (n: Fake) => { for (let e: Fake | null = n; e; e = e.parentElement) if (e === host) return true; return false; } });

  it('the canvas and a play layer zoom; text boxes, scrolling panels and the rest do not', () => {
    vi.stubGlobal('getComputedStyle', (e: Fake) => ({ overflowX: 'visible', overflowY: e.overflow ?? 'visible' }));
    const canvas = el(null, { tagName: 'CANVAS' });
    const host = el(null);
    const h = Object.assign(host, hostOf(host));
    const capture = el(host);
    const list = el(host, { scrollHeight: 400, clientHeight: 100, overflow: 'auto' });
    const row = el(list);
    const input = el(host, { tagName: 'INPUT' });
    const elsewhere = el(null);
    const zooms = (t: Fake) => wheelTargetZooms(t as unknown as Element, canvas as unknown as Element, h as unknown as Element);
    expect(zooms(canvas)).toBe(true);
    expect(zooms(capture)).toBe(true);
    expect(zooms(row)).toBe(false);
    expect(zooms(input)).toBe(false);
    expect(zooms(elsewhere)).toBe(false);
  });
});
