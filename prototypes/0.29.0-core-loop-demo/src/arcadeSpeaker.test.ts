/**
 * 🕹️ Arcade speaker tests: chunks queue back to back on the audio clock, and
 * clear() (Backspace to the menu) silences what is already queued.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArcadeSpeaker } from './arcadeSpeaker';

interface FakeSource {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

/** An AudioContext that records the chunks queued on it. */
function fakeAudio() {
  const sources: FakeSource[] = [];
  class FakeContext {
    state = 'running';
    sampleRate = 48000;
    currentTime = 10;
    destination = {};
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined };
    }
    createBuffer() {
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
  return sources;
}

afterEach(() => vi.unstubAllGlobals());

function pushFrame(speaker: ArcadeSpeaker, n = 800) {
  for (let i = 0; i < n; i++) speaker.push(0.1, -0.1);
  speaker.flush();
}

describe('ArcadeSpeaker', () => {
  it('queues each frame right behind the last', () => {
    const sources = fakeAudio();
    const speaker = new ArcadeSpeaker();
    pushFrame(speaker);
    pushFrame(speaker);
    expect(sources[0].start).toHaveBeenCalledWith(10.06);
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(10.06 + 800 / 48000);
  });

  it('clear() stops queued chunks and the next game starts a fresh queue', () => {
    const sources = fakeAudio();
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

  it('runs silent with no audio device', () => {
    vi.stubGlobal('window', {});
    const speaker = new ArcadeSpeaker();
    expect(speaker.sampleRate).toBe(48000);
    expect(() => pushFrame(speaker)).not.toThrow();
    speaker.close();
  });
});
