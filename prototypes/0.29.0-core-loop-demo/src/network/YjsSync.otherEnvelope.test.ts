import { describe, it, expect, vi } from 'vitest';
import { YjsSync } from './YjsSync';

// The node answers a handshake's dial on the stream the handshake came in on:
// its `bridge` reports arrive between the y-sync frames (main.rs
// report_dial_status). YjsSync hands every other kind to `onOtherEnvelope`.

const frame = (env: Record<string, unknown>): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(env));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  return out;
};
const bridge = (status: string): Record<string, unknown> => ({
  v: 1,
  room: 'home-0123456789ef',
  kind: 'bridge',
  seq: 0,
  author: '',
  payload: btoa(JSON.stringify({ target: 'a'.repeat(64), status, detail: null })),
});
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function session(onOtherEnvelope?: (env: { kind?: string; room?: string; payload?: string }) => void) {
  let toClient!: ReadableStreamDefaultController<Uint8Array>;
  const channel = {
    readable: new ReadableStream<Uint8Array>({ start: (c) => { toClient = c; } }),
    writable: new WritableStream<Uint8Array>(),
  };
  const sync = new YjsSync({ roomId: 'home-0123456789ef', channel, bootRecord: () => ({}), onOtherEnvelope });
  return { sync, send: (bytes: Uint8Array) => toClient.enqueue(bytes), close: () => toClient.close() };
}

describe('YjsSync: what else the node writes on the sync stream', () => {
  it('hands a bridge report to the listener, whole, in the order it came', async () => {
    const seen: string[] = [];
    const s = session((env) => seen.push(`${env.kind}:${env.room}:${JSON.parse(atob(env.payload ?? '')).status}`));
    await s.sync.start();
    // Two reports in one chunk, then one split across two chunks.
    const two = new Uint8Array([...frame(bridge('dialing')), ...frame(bridge('failed'))]);
    s.send(two);
    const third = frame(bridge('connected'));
    s.send(third.subarray(0, 9));
    s.send(third.subarray(9));
    await settle();
    expect(seen).toEqual([
      'bridge:home-0123456789ef:dialing',
      'bridge:home-0123456789ef:failed',
      'bridge:home-0123456789ef:connected',
    ]);
    await s.sync.stop();
    s.close();
  });

  it('a listener that throws does not stop the reader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const s = session(() => {
        calls++;
        if (calls === 1) throw new Error('listener failed');
      });
      await s.sync.start();
      s.send(frame(bridge('dialing')));
      await settle();
      s.send(frame(bridge('failed')));
      await settle();
      expect(calls).toBe(2);
      await s.sync.stop();
      s.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('with no listener every other kind is dropped, as before', async () => {
    const s = session();
    await s.sync.start();
    s.send(frame(bridge('dialing')));
    await settle();
    // Nothing of it reached the doc, and the reader lives on.
    expect(s.sync.doc.share.size).toBe(0);
    await s.sync.stop();
    s.close();
  });

  it('a y-sync frame is never handed to the listener', async () => {
    const seen: Array<string | undefined> = [];
    const s = session((env) => seen.push(env.kind));
    await s.sync.start();
    // An empty SyncStep2 (message 0, step 1, a zero-length... update of two
    // zero bytes: no structs, no deletes).
    s.send(frame({ v: 1, room: 'home-0123456789ef', kind: 'ysync', seq: 1, author: '', payload: btoa(String.fromCharCode(0, 1, 2, 0, 0)) }));
    s.send(frame(bridge('dialing')));
    await settle();
    expect(seen).toEqual(['bridge']);
    await s.sync.stop();
    s.close();
  });
});
