/**
 * 🕹️ Arcade speaker tests: chunks queue back to back on the audio clock,
 * clear() (Backspace to the menu) silences what is already queued, a queue
 * that runs ahead (a follower catching up) drops what it had queued, and
 * the buffer holds a catch-up burst at any rate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArcadeSpeaker } from './arcadeSpeaker';

interface FakeSource {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

/** An AudioContext that records the chunks queued on it, and their sizes. */
function fakeAudio(sampleRate = 48000) {
  const sources: FakeSource[] = [];
  const buffers: number[] = [];
  class FakeContext {
    state = 'running';
    sampleRate = sampleRate;
    currentTime = 10;
    destination = {};
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined };
    }
    createBuffer(_channels: number, n: number) {
      buffers.push(n);
      return { copyToChannel: () => undefined };
    }
    createBufferSource() {
      const source: FakeSource = { start: vi.fn(), stop: vi.fn(), onended: null };
      sources.push(source);
      return Object.assign(source, { buffer: null, connect: () => undefined });
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal('window', { AudioContext: FakeContext });
  return { sources, buffers };
}

afterEach(() => vi.unstubAllGlobals());

function pushFrame(speaker: ArcadeSpeaker, n = 800) {
  for (let i = 0; i < n; i++) speaker.push(0.1, -0.1);
  speaker.flush();
}

describe('ArcadeSpeaker', () => {
  it('queues each frame right behind the last', () => {
    const { sources } = fakeAudio();
    const speaker = new ArcadeSpeaker();
    pushFrame(speaker);
    pushFrame(speaker);
    expect(sources[0].start).toHaveBeenCalledWith(10.06);
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(10.06 + 800 / 48000);
  });

  it('clear() stops queued chunks and the next game starts a fresh queue', () => {
    const { sources } = fakeAudio();
    const speaker = new ArcadeSpeaker();
    pushFrame(speaker);
    pushFrame(speaker);
    sources[0].onended?.(); // the first already played out
    speaker.clear();
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(sources[1].stop).toHaveBeenCalled();
    pushFrame(speaker);
    expect(sources[2].start).toHaveBeenCalledWith(10.06);
  });

  it('drops what it had queued once the game runs far ahead, so a follower catching up never plays two streams', () => {
    const { sources } = fakeAudio();
    const speaker = new ArcadeSpeaker();
    // Frames queued while the clock stands still: the queue runs ahead of it.
    for (let i = 0; i < 20; i++) pushFrame(speaker);
    // 10.06 + 15 × 800/48000 > 10 + 0.3: the sixteenth chunk restarts the
    // queue at the lead, and the fifteen queued before it are stopped.
    expect(sources[14].start.mock.calls[0][0]).toBeCloseTo(10.06 + (14 * 800) / 48000);
    expect(sources[15].start).toHaveBeenCalledWith(10.06);
    for (let i = 0; i < 15; i++) expect(sources[i].stop, `chunk ${i}`).toHaveBeenCalled();
    for (let i = 15; i < 20; i++) expect(sources[i].stop, `chunk ${i}`).not.toHaveBeenCalled();
    expect(sources[16].start.mock.calls[0][0]).toBeCloseTo(10.06 + 800 / 48000);
  });

  it('holds a catch-up burst of eight frames at a high sample rate', () => {
    const { buffers } = fakeAudio(96000);
    const speaker = new ArcadeSpeaker();
    expect(speaker.sampleRate).toBe(96000);
    for (let i = 0; i < 8 * 1600; i++) speaker.push(0.1, 0.1);
    speaker.flush();
    expect(buffers).toEqual([8 * 1600]);
  });

  it('runs silent with no audio device', () => {
    vi.stubGlobal('window', {});
    const speaker = new ArcadeSpeaker();
    expect(speaker.sampleRate).toBe(48000);
    expect(() => pushFrame(speaker)).not.toThrow();
    speaker.close();
  });
});
