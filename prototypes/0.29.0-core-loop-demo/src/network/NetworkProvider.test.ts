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
const isTick = (n: number) => (c: Uint8Array) => c.length === 13 && c[0] === n;
const settle = () => new Promise((r) => setTimeout(r, 20));

type WriteOutcome = { chunk: Uint8Array; outcome: 'written' | 'rejected' };

/** The browser lane's framing: `[u32-LE len][JSON envelope]`. */
const frame = (env: object): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(env));
  const packet = new Uint8Array(4 + json.length);
  new DataView(packet.buffer).setUint32(0, json.length, true);
  packet.set(json, 4);
  return packet;
};
/** Every whole frame in what the provider wrote, decoded. */
const unframe = (chunks: Uint8Array[]): Array<Record<string, unknown>> => {
  let buf = new Uint8Array(0);
  for (const c of chunks) {
    const merged = new Uint8Array(buf.length + c.length);
    merged.set(buf, 0);
    merged.set(c, buf.length);
    buf = merged;
  }
  const out: Array<Record<string, unknown>> = [];
  while (buf.length >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
    if (buf.length < 4 + len) break;
    out.push(JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len))) as Record<string, unknown>);
    buf = buf.subarray(4 + len);
  }
  return out;
};
/** A `faucet` envelope as the node writes it (base64 JSON payload). */
const faucetEnvelope = (reply: object, kind = 'faucet') => ({
  v: 1, room: BOOT.roomId, kind, seq: 0, author: '', payload: btoa(JSON.stringify(reply)),
});

/**
 * One bidirectional stream of the fake transport. The test reads what the
 * provider wrote on it and whether it closed its side (FIN), and plays the
 * node's part on the readable: `reply()` writes a frame, `end()` finishes.
 */
class FakeBiStream {
  written: Uint8Array[] = [];
  closed = false;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  #push!: ReadableStreamDefaultController<Uint8Array>;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#push = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(chunk);
      },
      close: () => {
        this.closed = true;
      },
    });
  }

  reply(env: object): void {
    this.#push.enqueue(frame(env));
  }
  end(): void {
    this.#push.close();
  }
}

/**
 * A WebTransport stand-in.
 *  - `hold()` shuts the datagram sink, so every write stays pending until
 *    `release()` — the window the probe used to hold its lock across.
 *  - `close()` behaves like the real thing: it ERRORS the datagram stream, so
 *    writes still queued or in flight reject. `breakDatagrams()` does the same
 *    to a transport that is still in use.
 *  - `outcomes` records how every write the provider issued actually settled,
 *    so a test can prove a rejection happened rather than assume it.
 *  - `ready` settles when the test says so.
 */
class FakeTransport {
  written: Uint8Array[] = [];
  outcomes: Array<Promise<WriteOutcome>> = [];
  closed = false;
  getWriterCalls = 0;
  ready: Promise<void>;
  acceptHandshake!: () => void;
  failHandshake!: (err: Error) => void;
  #gate: Promise<void> = Promise.resolve();
  #open: () => void = () => {};
  #controller!: WritableStreamDefaultController;
  datagrams: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
  /** Streams the PROVIDER opened (createBidirectionalStream), in order. */
  opened: FakeBiStream[] = [];
  /** Streams the NODE opens toward the browser (forwarded traffic). */
  incomingBidirectionalStreams: ReadableStream<FakeBiStream>;
  #incoming!: ReadableStreamDefaultController<FakeBiStream>;

  constructor() {
    this.incomingBidirectionalStreams = new ReadableStream<FakeBiStream>({
      start: (controller) => {
        this.#incoming = controller;
      },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.acceptHandshake = resolve;
      this.failHandshake = reject;
    });
    const writable = new WritableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      write: async (chunk) => {
        await this.#gate;
        this.written.push(chunk);
      },
    });
    const realGetWriter = writable.getWriter.bind(writable);
    writable.getWriter = () => {
      this.getWriterCalls++;
      const writer = realGetWriter();
      const realWrite = writer.write.bind(writer);
      writer.write = (chunk?: Uint8Array) => {
        const result = realWrite(chunk);
        this.outcomes.push(
          result.then(
            () => ({ chunk: chunk!, outcome: 'written' as const }),
            () => ({ chunk: chunk!, outcome: 'rejected' as const }),
          ),
        );
        return result;
      };
      return writer;
    };
    this.datagrams = { writable, readable: new ReadableStream<Uint8Array>({}) };
  }

  hold(): void {
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }
  release(): void {
    this.#open();
  }
  breakDatagrams(): void {
    this.#controller.error(new Error('datagram stream errored'));
    this.#open(); // let a write stuck in the sink finish unwinding
  }
  close(): void {
    this.closed = true;
    this.breakDatagrams();
  }
  async outcomeOf(match: (c: Uint8Array) => boolean): Promise<WriteOutcome['outcome'] | 'never-issued'> {
    const all = await Promise.all(this.outcomes);
    return all.find((o) => match(o.chunk))?.outcome ?? 'never-issued';
  }
  async createBidirectionalStream(): Promise<FakeBiStream> {
    const stream = new FakeBiStream();
    this.opened.push(stream);
    return stream;
  }
  /** The node opens a stream toward the browser, as it does to forward a peer's envelope. */
  nodeOpens(): FakeBiStream {
    const stream = new FakeBiStream();
    this.#incoming.enqueue(stream);
    return stream;
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

  it('does not report the writes it abandoned at disconnect — their rejection is expected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wt = new FakeTransport();
    wt.hold();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);
    provider.sendTick(tick(1)); // queued behind the held ping when the room is left

    await provider.disconnect(); // closes the transport ⇒ the queued tick REJECTS
    expect(wt.closed).toBe(true);
    expect(await wt.outcomeOf(isTick(1))).toBe('rejected'); // the handler really ran…
    await settle();
    expect(warn).not.toHaveBeenCalled(); // …and kept quiet about it
  });

  it('is a silent no-op once disconnected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wt = new FakeTransport();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);
    await provider.disconnect();

    expect(() => provider.sendTick(tick(2))).not.toThrow();
    await settle();
    expect(await wt.outcomeOf(isTick(2))).toBe('never-issued'); // never reached the old transport
    expect(warn).not.toHaveBeenCalled();
  });

  it('DOES report a send that fails while the session is still live', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wt = new FakeTransport();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);

    wt.breakDatagrams(); // the lane dies under a connected session
    provider.sendTick(tick(3));
    expect(await wt.outcomeOf(isTick(3))).toBe('rejected');
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Failed to send movement datagram tick');
    await provider.disconnect();
  });
});

describe('NetworkProvider — a dial that was abandoned mid-handshake', () => {
  it('cannot take a newer session offline when it finally FAILS', async () => {
    const abandoned = new FakeTransport(); // handshake never completes…
    const live = new FakeTransport();
    live.acceptHandshake();
    queueTransports(abandoned, live);
    const provider = new NetworkProvider();

    const firstDial = provider.connect(BOOT); // awaiting `abandoned.ready`
    await provider.disconnect(); // leave mid-dial (a room swap, a Retry)
    await provider.connect(BOOT); // the newer session is up on `live`
    expect(provider.mode()).toBe('direct-unreliable');

    abandoned.failHandshake(new Error('closed before ready')); // …until it rejects
    await expect(firstDial).rejects.toThrow('closed before ready');

    // The late failure belongs to a dead dial: the live session is untouched…
    expect(provider.mode()).toBe('direct-unreliable');
    provider.sendTick(tick(7));
    await vi.waitFor(() => expect(live.written.some(isTick(7))).toBe(true));
    // …and an abandoned dial is not reported as a failed handshake.
    expect(console.error).not.toHaveBeenCalled();
    await provider.disconnect();
  });

  it('cannot hijack a newer session when its handshake COMPLETES late', async () => {
    const abandoned = new FakeTransport();
    const live = new FakeTransport();
    live.acceptHandshake();
    queueTransports(abandoned, live);
    const provider = new NetworkProvider();

    const firstDial = provider.connect(BOOT);
    await provider.disconnect();
    await provider.connect(BOOT);

    abandoned.acceptHandshake(); // a handshake can still complete after disconnect()
    await expect(firstDial).rejects.toThrow(/superseded/);

    // It took nothing: no writer on its own transport, none of the live one's state.
    expect(abandoned.getWriterCalls).toBe(0);
    expect(live.getWriterCalls).toBe(1);
    expect(provider.mode()).toBe('direct-unreliable');
    provider.sendTick(tick(9));
    await vi.waitFor(() => expect(live.written.some(isTick(9))).toBe(true));
    expect(abandoned.written.some(isTick(9))).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
    await provider.disconnect();
  });
});

describe('NetworkProvider — a dial it still owns', () => {
  it('reads offline after a failed handshake, reports it, and keeps sendTick safe', async () => {
    const wt = new FakeTransport();
    queueTransports(wt);
    const provider = new NetworkProvider();
    const dial = provider.connect(BOOT);
    wt.failHandshake(new Error('no route'));
    await expect(dial).rejects.toThrow('no route');
    expect(provider.mode()).toBe('offline');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(wt.closed).toBe(true); // no half-open transport left behind
    expect(() => provider.sendTick(tick(1))).not.toThrow();
  });

  it('reads offline when the transport cannot even be constructed, and can dial again afterwards', async () => {
    const next = new FakeTransport();
    next.acceptHandshake();
    queueTransports(); // nothing queued ⇒ `new WebTransport` throws
    const provider = new NetworkProvider();
    await expect(provider.connect(BOOT)).rejects.toThrow('no fake transport queued');
    expect(provider.mode()).toBe('offline');
    expect(console.error).toHaveBeenCalledTimes(1);

    queueTransports(next);
    await provider.connect(BOOT);
    expect(provider.mode()).toBe('direct-unreliable');
    await provider.disconnect();
  });
});

/**
 * 🥣 The faucet request stream (#245): one request per bidirectional stream,
 * FIN after the single frame so the node can finish its side (the leak fix),
 * and the reply taken ONLY from that stream — a `faucet` envelope on a stream
 * the node opened is forwarded traffic, which a room peer could have sent, and
 * must never pass for the node's answer (the spoofing fix).
 */
describe('NetworkProvider — the faucet request stream', () => {
  async function connected(): Promise<{ wt: FakeTransport; provider: NetworkProvider; replies: unknown[]; envelopes: Array<{ kind?: string }> }> {
    const wt = new FakeTransport();
    wt.acceptHandshake();
    queueTransports(wt);
    const provider = new NetworkProvider();
    await provider.connect(BOOT);
    const replies: unknown[] = [];
    const envelopes: Array<{ kind?: string }> = [];
    provider.onFaucetReply((env) => {
      replies.push(env);
    });
    provider.onEnvelope((env) => {
      envelopes.push(env);
    });
    return { wt, provider, replies, envelopes };
  }

  it('sends one framed request then FIN, and the reply on that stream reaches onFaucetReply only', async () => {
    const { wt, provider, replies, envelopes } = await connected();
    await provider.requestFaucet('give', 1234.9);

    expect(wt.opened).toHaveLength(1);
    const stream = wt.opened[0];
    const sent = unframe(stream.written);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('faucet');
    expect(sent[0].room).toBe(BOOT.roomId);
    expect(JSON.parse(atob(sent[0].payload as string))).toEqual({ op: 'give', amount: 1234 });
    expect(sent[0].seq).toBe(1);
    // The writable is closed after that one frame: the node's read loop ends at
    // our FIN and it can finish its side after replying, so the stream ends
    // instead of living (and holding a node task) until disconnect.
    expect(stream.closed).toBe(true);

    const reply = faucetEnvelope({ op: 'give', ok: true, spentCoin: 'ab'.repeat(32) });
    stream.reply(reply);
    stream.end();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual(reply);
    expect(envelopes).toHaveLength(0);
    // Every request carries the next seq, so the node's echo orders the replies.
    await provider.requestFaucet('status');
    expect(unframe(wt.opened[1].written)[0].seq).toBe(2);
    await provider.disconnect();
  });

  it('never takes a faucet envelope from a node-opened stream as a reply', async () => {
    const { wt, provider, replies, envelopes } = await connected();
    const forwarded = wt.nodeOpens();
    // What a room peer could inject through an older node: a status with its own address.
    forwarded.reply(faucetEnvelope({ op: 'status', ok: true, status: { address: 'txch1attacker' } }));
    forwarded.reply(faucetEnvelope({ target: 'x', status: 'dialing' }, 'bridge'));
    forwarded.end();
    await vi.waitFor(() => expect(envelopes).toHaveLength(2));
    // Both went down the generic path (where main.ts ignores `faucet`); none was a reply.
    expect(envelopes.map((e) => e.kind)).toEqual(['faucet', 'bridge']);
    expect(replies).toHaveLength(0);
    await provider.disconnect();
  });

  it('rejects a request it cannot send instead of resolving as if it had', async () => {
    const provider = new NetworkProvider();
    await expect(provider.requestFaucet('status')).rejects.toThrow('no connection to your node');
    const wt = new FakeTransport();
    wt.acceptHandshake();
    queueTransports(wt);
    await provider.connect(BOOT);
    await provider.disconnect();
    await expect(provider.requestFaucet('claim')).rejects.toThrow('no connection to your node');
    expect(wt.opened).toHaveLength(0);
  });
});
