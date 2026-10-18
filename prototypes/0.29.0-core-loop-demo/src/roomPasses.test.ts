/**
 * 🚪 Room passes — USE PASS warms a room in the background (#60 P2), and since
 * #231 P6b the node learns the room key and the pass's member cards from that
 * prefetch itself (#272 review round 9), so a host every live route fails to
 * reach can be knocked on through the chain. These drive the real roomPasses
 * module, provider and ysync against a fake WebTransport whose node never
 * answers and whose host is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBootstrap } from './network/protocol';
import { addPass, initRoomPasses, passState, removePass } from './roomPasses';

class FakeBiStream {
  written: Uint8Array[] = [];
  closed = false;
  readable = new ReadableStream<Uint8Array>({});
  writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      this.written.push(chunk);
    },
    close: () => {
      this.closed = true;
    },
  });
}

/** A node that accepts the handshake and every stream, and says nothing back. */
class SilentTransport {
  ready = Promise.resolve();
  opened: FakeBiStream[] = [];
  datagrams = { writable: new WritableStream<Uint8Array>({ write() {} }), readable: new ReadableStream<Uint8Array>({}) };
  incomingBidirectionalStreams = new ReadableStream<FakeBiStream>({});
  async createBidirectionalStream(): Promise<FakeBiStream> {
    const stream = new FakeBiStream();
    this.opened.push(stream);
    return stream;
  }
  close(): void {}
}

/** Every whole `[u32-LE len][JSON]` frame written on a stream, decoded. */
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

const transports: SilentTransport[] = [];
const g = globalThis as { WebTransport?: unknown; window?: unknown };
let hadWindow = false;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  g.WebTransport = function () {
    const next = new SilentTransport();
    transports.push(next);
    return next;
  };
  // roomPasses polls for the room's state with window.setTimeout.
  hadWindow = 'window' in g;
  if (!hadWindow) g.window = globalThis;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete g.WebTransport;
  if (!hadWindow) delete g.window;
  transports.length = 0;
});

describe('USE PASS prefetch (#231 P6b)', () => {
  it("hands the node the pass's cards from the prefetch itself, so a host no live route reaches can be knocked on", async () => {
    // #272 review round 9: the primary session joins a pass's room only once
    // its prefetch is READY, and the prefetch's provider has no posture probe
    // — so the node got neither the pass's cards nor leave to use them, and
    // with every live route to the host failing it could not knock: the room
    // never became ready. The prefetch's cap now carries the cards, with no
    // posture claimed and nothing armed.
    initRoomPasses({ decode: (seed) => JSON.parse(atob(seed)) as RoomBootstrap, resolve: async (boot) => boot });
    const card = { nodeId: 'host', ck: 'Y2s=', kxPk: 'ab', issuedAt: 100, sig: 'ff' };
    const boot: RoomBootstrap = {
      v: 2,
      roomId: 'far-room',
      wtUrl: 'https://127.0.0.1:4443/ssf',
      certHashesB64: ['AAAA'],
      roomKeyB64: 'a2V5',
      memberHints: [{ irohNodeId: 'host', irohRelayUrls: ['https://relay.example'], nodeCard: card }],
    };
    expect(addPass(btoa(JSON.stringify(boot)))).toEqual({ ok: true, roomId: 'far-room' });
    // The node accepted the connection; the host never delivers the room's state.
    await vi.waitFor(() => expect(passState('far-room')).toBe('loading'));
    expect(transports).toHaveLength(1);
    const envelopes = transports[0].opened.flatMap((s) => unframe(s.written));
    const caps = envelopes.filter((env) => env.kind === 'cap');
    expect(caps).toHaveLength(1);
    expect(caps[0].room).toBe('far-room');
    expect(JSON.parse(atob(caps[0].payload as string))).toEqual({
      roomKeyB64: 'a2V5',
      chiaMode: false,
      publicRoom: null,
      seq: expect.any(Number),
      shareCard: true,
      prefetch: true,
      memberCards: [card],
      passPrivate: true,
    });
    expect(envelopes.some((env) => env.kind === 'ysync')).toBe(true); // the prefetch's own sync went on as before
    expect(passState('far-room')).toBe('loading'); // not ready: nothing more is claimed for the room
    removePass('far-room');
  });
});
