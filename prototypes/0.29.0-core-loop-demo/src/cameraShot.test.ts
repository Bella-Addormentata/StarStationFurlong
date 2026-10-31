/**
 * 📷 The CAMERA app's shutter (#319): a shot is the next frame drawn,
 * scaled to fit 512 px and saved as a JPEG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitWithin, requestShot, resetShotsForTest, servePendingShot, SHOT_MAX_PX, shotPending, type ShotCanvas } from './cameraShot';

function fakeCanvas(blob: Blob | null = new Blob([new Uint8Array([0xff, 0xd8, 1, 2])], { type: 'image/jpeg' })) {
  const made: Array<{ w: number; h: number; drawn: number[]; type?: string; quality?: number }> = [];
  const make = (w: number, h: number): ShotCanvas => {
    const rec = { w, h, drawn: [] as number[], type: undefined as string | undefined, quality: undefined as number | undefined };
    made.push(rec);
    return {
      getContext: () => ({ drawImage: (_img, dx, dy, dw, dh) => { rec.drawn = [dx, dy, dw, dh]; } }),
      toBlob: (cb, type, quality) => {
        rec.type = type;
        rec.quality = quality;
        cb(blob);
      },
    };
  };
  return { made, make };
}

afterEach(() => {
  resetShotsForTest();
  vi.useRealTimers();
});

describe('📷 a shot', () => {
  it('fits 512 px on its longest side, never scaled up', () => {
    expect(fitWithin(1920, 1080, SHOT_MAX_PX)).toEqual({ width: 512, height: 288 });
    expect(fitWithin(1080, 1920, SHOT_MAX_PX)).toEqual({ width: 288, height: 512 });
    expect(fitWithin(300, 200, SHOT_MAX_PX)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(0, 200, SHOT_MAX_PX)).toEqual({ width: 0, height: 0 });
  });

  it('is read from the next frame drawn, as a JPEG, for every shot waiting', async () => {
    const { made, make } = fakeCanvas();
    servePendingShot({ width: 1920, height: 1080 }, make);
    expect(made).toHaveLength(0); // nothing waiting: the frame isn't read
    const a = requestShot();
    const b = requestShot();
    expect(shotPending()).toBe(true);
    servePendingShot({ width: 1920, height: 1080 }, make);
    expect(shotPending()).toBe(false);
    const [sa, sb] = await Promise.all([a, b]);
    expect(sa).toMatchObject({ width: 512, height: 288 });
    expect(sb).toBe(sa);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ w: 512, h: 288, drawn: [0, 0, 512, 288], type: 'image/jpeg' });
  });

  it('comes back empty when the frame can’t be read, or none is drawn in time', async () => {
    const { make } = fakeCanvas(null);
    const unread = requestShot();
    servePendingShot({ width: 800, height: 600 }, make);
    expect(await unread).toBeNull();
    const broken = requestShot();
    servePendingShot({ width: 800, height: 600 }, () => { throw new Error('tainted'); });
    expect(await broken).toBeNull();
    vi.useFakeTimers();
    const late = requestShot(1000);
    vi.advanceTimersByTime(1001);
    expect(await late).toBeNull();
    expect(shotPending()).toBe(false);
  });

  it('waits out a slow encoding once the frame is read', async () => {
    vi.useFakeTimers();
    let finish: ((b: Blob | null) => void) | null = null;
    const slow = (): ShotCanvas => ({
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb) => { finish = cb; },
    });
    const shot = requestShot(1000);
    servePendingShot({ width: 640, height: 480 }, slow);
    vi.advanceTimersByTime(5000); // the encoder is slower than the wait for a frame
    finish!(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
    expect(await shot).toMatchObject({ width: 512, height: 384 });
  });
});
