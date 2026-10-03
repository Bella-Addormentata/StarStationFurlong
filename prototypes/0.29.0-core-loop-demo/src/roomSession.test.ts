/**
 * 🚏🤖📡 A room session held open (roomSession.openRoomSession), over a
 * stand-in transport: what it reads from an address, when it hands a session
 * over (only once the room's real state has arrived), whose answer it waits
 * for, how it hangs up (once, both halves), what a confirm says, and the open
 * deadline (a late open is hung up, never handed over).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBootstrap } from './network/protocol';

/** The stand-in transport's state and the answers it gives. */
const net = vi.hoisted(() => ({
  providers: [] as Array<{ disconnects: number }>,
  syncs: [] as Array<{ stops: number; linked: number; doc: unknown }>,
  connect: (): Promise<void> => Promise.resolve(),
  ready: (_sync: unknown, _ms: number, _hostedHere: boolean): Promise<boolean> => Promise.resolve(true),
  readyCalls: [] as Array<{ ms: number; hostedHere: boolean }>,
  confirm: (_since: Uint8Array, _ms: number): Promise<boolean> => Promise.resolve(true),
}));

vi.mock('./network/NetworkProvider', () => ({
  NetworkProvider: class {
    disconnects = 0;
    constructor() {
      net.providers.push(this);
    }
    connect(): Promise<void> {
      return net.connect();
    }
    openChannel(): Promise<object> {
      return Promise.resolve({});
    }
    onEnvelope(): void {}
    getBootRecord(): null {
      return null;
    }
    disconnect(): Promise<void> {
      this.disconnects++;
      return Promise.resolve();
    }
  },
}));

vi.mock('./network/YjsSync', async () => {
  const Y = await import('yjs');
  return {
    YjsSync: class {
      doc = new Y.Doc();
      stops = 0;
      linked = 0;
      constructor() {
        net.syncs.push(this);
      }
      start(): Promise<void> {
        return Promise.resolve();
      }
      stop(): Promise<void> {
        this.stops++;
        return Promise.resolve();
      }
      ingestEnvelope(): void {}
      markPeerLinked(): void {
        this.linked++;
      }
      resync(): void {}
      confirmOwnWrites(since: Uint8Array, ms: number): Promise<boolean> {
        return net.confirm(since, ms);
      }
    },
  };
});

vi.mock('./keypair', () => ({ ysyncSigner: () => ({}) }));

vi.mock('./farDoorWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./farDoorWrite')>();
  return {
    ...actual,
    roomStateArrived: (sync: unknown, ms: number, hostedHere: boolean) => {
      net.readyCalls.push({ ms, hostedHere });
      return net.ready(sync, ms, hostedHere);
    },
  };
});

import { ROOM_SESSION_OPEN_MS, openRoomSession, type RoomSessionDeps } from './roomSession';

const BOOT = { roomId: 'ferry-1' } as RoomBootstrap;

const deps = (over: Partial<RoomSessionDeps> = {}): RoomSessionDeps => ({
  decode: () => BOOT,
  resolve: async (boot) => boot,
  hostedHere: () => true,
  ...over,
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  net.providers.length = 0;
  net.syncs.length = 0;
  net.readyCalls.length = 0;
  net.connect = () => Promise.resolve();
  net.ready = () => Promise.resolve(true);
  net.confirm = () => Promise.resolve(true);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

describe('opening a room session', () => {
  it('reads nothing from an address it cannot decode, and dials nothing', async () => {
    expect(await openRoomSession(deps({ decode: () => null }), 'garbage')).toBeNull();
    expect(await openRoomSession(deps({ decode: () => { throw new Error('bad pass'); } }), 'garbage')).toBeNull();
    expect(net.providers).toHaveLength(0);
  });

  it("hands a session over once the room's state has arrived, and hangs up once", async () => {
    const s = await openRoomSession(deps(), 'ssf://room#room=ferry-1');
    expect(s).not.toBeNull();
    expect(s!.roomId).toBe('ferry-1');
    expect(s!.doc).toBe(net.syncs[0].doc);
    expect(s!.closed).toBe(false);
    expect(await s!.confirm(new Uint8Array(), 1000)).toBe(true);
    s!.close();
    s!.close();
    expect(s!.closed).toBe(true);
    expect(net.syncs[0].stops).toBe(1);
    expect(net.providers[0].disconnects).toBe(1);
    // Closed, nothing is acknowledged, and the transport is not asked.
    net.confirm = () => { throw new Error('asked after close'); };
    expect(await s!.confirm(new Uint8Array(), 1000)).toBe(false);
  });

  it('reads a confirm that fails as not acknowledged', async () => {
    const s = await openRoomSession(deps(), 'x');
    net.confirm = () => Promise.reject(new Error('channel gone'));
    expect(await s!.confirm(new Uint8Array(), 1000)).toBe(false);
  });

  it('waits for the live host of a room hosted elsewhere, and for a replica here', async () => {
    await openRoomSession(deps({ hostedHere: () => false }), 'x');
    expect(net.syncs[0].linked).toBe(1);
    await openRoomSession(deps(), 'x');
    expect(net.syncs[1].linked).toBe(0);
    expect(net.readyCalls).toEqual([
      { ms: 20_000, hostedHere: false },
      { ms: 10_000, hostedHere: true },
    ]);
  });

  it("hands nothing over when the room's state never arrives, and hangs up", async () => {
    net.ready = () => Promise.resolve(false);
    expect(await openRoomSession(deps(), 'x')).toBeNull();
    expect(net.syncs[0].stops).toBe(1);
    expect(net.providers[0].disconnects).toBe(1);
  });

  it('hangs up a dial that fails, or an address that cannot be resolved', async () => {
    net.connect = () => Promise.reject(new Error('no route'));
    expect(await openRoomSession(deps(), 'x')).toBeNull();
    expect(net.providers[0].disconnects).toBe(1);
    expect(await openRoomSession(deps({ resolve: () => Promise.reject(new Error('no node')) }), 'x')).toBeNull();
    expect(net.providers).toHaveLength(1);
  });

  it('abandons an open past its deadline, and never hands over a late one', async () => {
    vi.useFakeTimers();
    let arrive: (ok: boolean) => void = () => {};
    net.ready = () => new Promise<boolean>((r) => { arrive = r; });
    let opened: unknown = 'pending';
    void openRoomSession(deps(), 'x').then((s) => { opened = s; });
    await vi.advanceTimersByTimeAsync(ROOM_SESSION_OPEN_MS - 1);
    expect(opened).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBeNull();
    expect(net.syncs[0].stops).toBe(1);
    expect(net.providers[0].disconnects).toBe(1);
    // The room's state arrives after all: nothing more is handed over or opened.
    arrive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBeNull();
    expect(net.syncs[0].stops).toBe(1);
    expect(net.providers).toHaveLength(1);
  });
});
