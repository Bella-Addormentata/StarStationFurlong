/**
 * 🔌 NetworkProvider — the datagram lane has ONE writer.
 *
 * Movement ticks (sent from the render loop) and the RTT probe both write
 * datagrams. Each used to take its own writer per send, and the probe held its
 * lock across an `await` — so a tick landing in that window threw out of
 * animate() before the frame was drawn. These drive the real provider against
 * a fake WebTransport whose datagram sink can be held shut, which is exactly
 * that window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkProvider } from './NetworkProvider';
import type { RoomBootstrap } from './protocol';

// No roomKeyB64 ⇒ connect() skips the `cap` stream (and localStorage with it).
const BOOT: RoomBootstrap = { v: 2, roomId: 'room-test', wtUrl: 'https://127.0.0.1:4443', certHashesB64: ['AAAA'] };

const text = (chunk: Uint8Array) => new TextDecoder().decode(chunk);
const tick = (n: number) => new Uint8Array(13).fill(n);

/** A WebTransport stand-in. `hold()` shuts the datagram sink so every write
 *  stays pending until `release()`; `ready` settles when the test says so. */
class FakeTransport {
  written: Uint8Array[] = [];
  closed = false;
  getWriterCalls = 0;
  ready: Promise<void>;
  acceptHandshake!: () => void;
  failHandshake!: (err: Error) => void;
  #gate: Promise<void> = Promise.resolve();
  #open: () => void = () => {};
  datagrams: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
  incomingBidirectionalStreams = new ReadableStream({});

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.acceptHandshake = resolve;
      this.failHandshake = reject;
    });
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.#gate;
        this.written.push(chunk);
      },
    });
    const realGetWriter = writable.getWriter.bind(writable);
    writable.getWriter = () => {
      this.getWriterCalls++;
      return realGetWriter();
    };
    this.datagrams = { writable, readable: new ReadableStream<Uint8Array>({}) };
  }

  hold(): void {
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }
  release(): void {
    this.#open();
  }
  close(): void {
    this.closed = true;
  }
}

/** Each `new WebTransport(...)` the provider makes takes the next fake. */
function queueTransports(...fakes: FakeTransport[]): void {
  const queue = [...fakes];
  (globalThis as { WebTransport?: unknown }).WebTransport = function () {
    const next = queue.shift();
    if (!next) throw new Error('no fake transport queued');
    return next;
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { WebTransport?: unknown }).WebTransport;
});

describe('NetworkProvider datagram lane', () => {
  it('sends a tick while the RTT probe write is still pending — no throw, nothing lost, in order', async () => {
    const wt = new FakeTransport();
    wt.hold(); // the probe's first ping will sit in the sink, unfinished
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);

    // The window the old code threw in: the probe is mid-write.
    expect(() => provider.sendTick(tick(1))).not.toThrow();
    expect(() => provider.sendTick(tick(2))).not.toThrow();

    wt.release();
    await vi.waitFor(() => expect(wt.written).toHaveLength(3));
    expect(text(wt.written[0])).toBe('ping');
    expect(Array.from(wt.written[1])).toEqual(Array.from(tick(1)));
    expect(Array.from(wt.written[2])).toEqual(Array.from(tick(2)));

    await provider.disconnect();
  });

  it('takes the datagram writer once for the life of the transport', async () => {
    const wt = new FakeTransport();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);
    for (let i = 0; i < 25; i++) provider.sendTick(tick(i));
    await vi.waitFor(() => expect(wt.written.length).toBeGreaterThanOrEqual(26));
    expect(wt.getWriterCalls).toBe(1);
    await provider.disconnect();
  });

  it('is a silent no-op once disconnected — and does not warn about the writes it abandoned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wt = new FakeTransport();
    wt.hold();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);
    provider.sendTick(tick(1)); // in flight when the room is left

    await provider.disconnect();
    expect(wt.closed).toBe(true);
    const before = wt.written.length;
    expect(() => provider.sendTick(tick(2))).not.toThrow();
    wt.release();
    await new Promise((r) => setTimeout(r, 20));
    // tick(2) never reached the old transport…
    expect(wt.written.slice(before).some((c) => c.length === 13 && c[0] === 2)).toBe(false);
    // …and nothing was reported as a failed send.
    expect(warn).not.toHaveBeenCalled();
  });

  it('a dial abandoned by disconnect() cannot take a newer session offline when it finally rejects', async () => {
    const abandoned = new FakeTransport(); // handshake never completes
    const live = new FakeTransport();
    live.acceptHandshake();
    queueTransports(abandoned, live);
    const provider = new NetworkProvider();

    const firstDial = provider.connect(BOOT); // awaiting `abandoned.ready`
    await provider.disconnect(); // leave mid-dial (a room swap, a Retry)
    await provider.connect(BOOT); // the newer session is up on `live`
    expect(provider.mode()).toBe('direct-unreliable');

    abandoned.failHandshake(new Error('closed before ready'));
    await expect(firstDial).rejects.toThrow('closed before ready');

    // The late failure belongs to a dead dial: the live session is untouched.
    expect(provider.mode()).toBe('direct-unreliable');
    provider.sendTick(tick(7));
    await vi.waitFor(() => expect(live.written.some((c) => c.length === 13 && c[0] === 7)).toBe(true));
    await provider.disconnect();
  });

  it('still reports a failed dial it owns as offline', async () => {
    const wt = new FakeTransport();
    queueTransports(wt);
    const provider = new NetworkProvider();
    const dial = provider.connect(BOOT);
    wt.failHandshake(new Error('no route'));
    await expect(dial).rejects.toThrow('no route');
    expect(provider.mode()).toBe('offline');
    expect(() => provider.sendTick(tick(1))).not.toThrow();
  });
});
