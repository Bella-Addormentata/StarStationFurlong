/**
 * ⚓ #163 — the far room's end of a DOCK / UNDOCK.
 *
 * Two halves, pinned separately:
 *  - applyFarDockRequest: the decision over the far room's doc — which door,
 *    compare-and-swap on its record, and the port fitted in the same
 *    transaction as a dock;
 *  - YjsSync.confirmOwnWrites: the acknowledgment the short-lived session
 *    waits for before it hangs up — driven against an in-memory node that
 *    answers SyncStep1 from its own replica, exactly as the real one does.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import { buildDoorPairing, buildDoorTombstone, readAllDoorsFrom, readDoorFrom } from './doorsDoc';
import {
  applyFarDockRequest, berthAfterSettle, initFarDoorWrite, roomStateReady, writeFarDock,
} from './farDoorWrite';
import { YjsSync } from './network/YjsSync';
import type { NearEnd } from './dockRules';

const seedFor = (roomId: string): string => btoa(JSON.stringify({ roomId }));
const SHIP = 'module-ship';
const STATION = 'home-station';

const near: NearEnd = {
  roomId: SHIP,
  address: seedFor(SHIP),
  doorId: 'd:shipport',
  wall: 'x-',
  lateral: 0,
};

/** The station's doc: one port door `d:bay`, docked to the ship. */
function stationDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('doorLayout').set('d:bay', { id: 'd:bay', wall: 'y+', lateral: 0, placed: true });
  doc.getMap('doorPolicy').set('d:bay', { passage: 'public', construction: 'owner', adapter: true });
  doc.getMap('doors').set(
    'd:bay',
    buildDoorPairing(seedFor(SHIP), { segments: dockChain(), farDoor: near.doorId, transient: true, dockedAt: 100 }),
  );
  return doc;
}

describe('applyFarDockRequest — UNDOCK', () => {
  it('tombstones the far door that points back at us, keeping the berth memory', () => {
    const doc = stationDoc();
    const out = applyFarDockRequest(
      doc,
      { kind: 'undock', farAddress: seedFor(STATION), nearDoorId: near.doorId, undockedAt: 200 },
      near,
    );
    expect(out).toEqual({ result: { ok: true, detail: 'written' }, wrote: true });
    const rec = readAllDoorsFrom(doc).get('d:bay');
    expect(rec?.paired).toBe(false);
    expect(rec && !rec.paired && rec.dock).toEqual({ farDoor: near.doorId, farWall: 'x-', farLateral: 0, undockedAt: 200 });
  });

  it('writes nothing when the far side no longer holds our dock', () => {
    const doc = stationDoc();
    doc.getMap('doors').set('d:bay', buildDoorPairing(seedFor('someone-else'), { segments: dockChain() }));
    const out = applyFarDockRequest(
      doc,
      { kind: 'undock', farAddress: seedFor(STATION), farDoor: 'd:bay', nearDoorId: near.doorId, undockedAt: 200 },
      near,
    );
    expect(out).toEqual({ result: { ok: true, detail: 'nothing-to-undo' }, wrote: false });
    expect(readAllDoorsFrom(doc).get('d:bay')?.paired).toBe(true);
  });

  it('a take-back undoes only the dock carrying its own stamp', () => {
    const doc = stationDoc(); // d:bay docked to the ship at 100
    const takeBack = (onlyDockedAt: number) => applyFarDockRequest(
      doc,
      {
        kind: 'undock', farAddress: seedFor(STATION), farDoor: 'd:bay', nearDoorId: near.doorId,
        undockedAt: 101, onlyDockedAt,
      },
      near,
    );
    expect(takeBack(99)).toEqual({ result: { ok: true, detail: 'nothing-to-undo' }, wrote: false });
    expect(readAllDoorsFrom(doc).get('d:bay')?.paired).toBe(true);
    expect(takeBack(100).wrote).toBe(true);
    expect(readAllDoorsFrom(doc).get('d:bay')?.paired).toBe(false);
  });
});

describe('applyFarDockRequest — DOCK', () => {
  const dockAt = (doc: Y.Doc) => applyFarDockRequest(
    doc,
    { kind: 'dock', farAddress: seedFor(STATION), farDoor: 'd:bay', nearDoorId: near.doorId, dockedAt: 300 },
    near,
  );

  it('re-docks a remembered berth on its port', () => {
    const doc = stationDoc();
    doc.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP), { undockedAt: 200 }));
    const out = dockAt(doc);
    expect(out).toEqual({ result: { ok: true, detail: 'written' }, wrote: true });
    const rec = readAllDoorsFrom(doc).get('d:bay');
    expect(rec?.paired && rec.dockedAt).toBe(300);
    expect(rec?.paired && rec.connectedRoomAddress).toBe(near.address);
  });

  it('fits the half on a door that never had a connection — in the same transaction', () => {
    const doc = stationDoc();
    doc.getMap('doors').delete('d:bay');
    doc.getMap('doorPolicy').set('d:bay', { passage: 'public', construction: 'owner', adapter: false });
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    expect(dockAt(doc).wrote).toBe(true);
    expect(transactions).toBe(1);
    expect(readAllDoorsFrom(doc).get('d:bay')?.paired).toBe(true);
    expect((doc.getMap('doorPolicy').get('d:bay') as { adapter?: boolean }).adapter).toBe(true);
  });

  it('reads the named berth itself — never through the 64-record snapshot that could hide it', () => {
    // A crowded far room: 70 other records land BEFORE the berth, so the
    // capped snapshot never reaches it — and it is occupied.
    const doc = new Y.Doc();
    for (let i = 0; i < 70; i++) {
      doc.getMap('doors').set(`d:r${i}`, buildDoorPairing(seedFor(`room-${i}`)));
    }
    doc.getMap('doorLayout').set('d:bay', { id: 'd:bay', wall: 'y+', lateral: 0, placed: true });
    doc.getMap('doorPolicy').set('d:bay', { passage: 'public', construction: 'owner', adapter: true });
    doc.getMap('doors').set('d:bay', buildDoorPairing(seedFor('someone-else'), { segments: dockChain() }));
    expect(readAllDoorsFrom(doc).has('d:bay')).toBe(false); // the cap hides it…
    expect(dockAt(doc)).toEqual({ result: { ok: false, reason: 'occupied' }, wrote: false }); // …not from the decision
    expect(readDoorFrom(doc, 'd:bay')).toEqual(
      buildDoorPairing(seedFor('someone-else'), { segments: dockChain() }),
    ); // the occupant is untouched
  });

  it('never re-fits a port its owner removed — even while the old berth memory still stands', () => {
    const doc = stationDoc();
    // The removal's policy write has landed; its tombstone write has not (or
    // never will — any tombstoned door without a port is closed).
    doc.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP), { undockedAt: 200 }));
    doc.getMap('doorPolicy').set('d:bay', { passage: 'public', construction: 'owner', adapter: false });
    const before = Y.encodeStateVector(doc);
    expect(dockAt(doc)).toEqual({ result: { ok: false, reason: 'closed' }, wrote: false });
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it('refuses an occupied berth and a door that no longer exists — and writes nothing', () => {
    const doc = stationDoc();
    doc.getMap('doors').set('d:bay', buildDoorPairing(seedFor('someone-else'), { segments: dockChain() }));
    const before = Y.encodeStateVector(doc);
    const occupied = applyFarDockRequest(
      doc,
      { kind: 'dock', farAddress: seedFor(STATION), farDoor: 'd:bay', nearDoorId: near.doorId, dockedAt: 300 },
      near,
    );
    expect(occupied).toEqual({ result: { ok: false, reason: 'occupied' }, wrote: false });
    const gone = applyFarDockRequest(
      doc,
      { kind: 'dock', farAddress: seedFor(STATION), farDoor: 'd:removed', nearDoorId: near.doorId, dockedAt: 300 },
      near,
    );
    expect(gone).toEqual({ result: { ok: false, reason: 'gone' }, wrote: false });
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

describe('berthAfterSettle — two modules claiming one berth', () => {
  const other: NearEnd = {
    roomId: 'module-other', address: seedFor('module-other'), doorId: 'd:otherport', wall: 'x+', lateral: 0,
  };
  const dockReq = (nearDoorId: string, dockedAt: number) => ({
    kind: 'dock' as const, farAddress: seedFor(STATION), farDoor: 'd:bay', nearDoorId, dockedAt,
  });

  it('the CRDT keeps exactly one of two concurrent claims — and only its writer has docked', () => {
    // A free berth on a port, replicated to two clients' sessions.
    const base = stationDoc();
    base.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP), { undockedAt: 200 }));
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    // Both read it free, both write, both would be acknowledged.
    expect(applyFarDockRequest(a, dockReq(near.doorId, 300), near).wrote).toBe(true);
    expect(applyFarDockRequest(b, dockReq(other.doorId, 301), other).wrote).toBe(true);
    // The settle window: each replica receives the other's claim.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readDoorFrom(a, 'd:bay')).toEqual(readDoorFrom(b, 'd:bay')); // one berth, one answer
    const aOut = berthAfterSettle(a, dockReq(near.doorId, 300), near);
    const bOut = berthAfterSettle(b, dockReq(other.doorId, 301), other);
    expect([aOut, bOut].filter((o) => o === null)).toHaveLength(1);
    expect([aOut, bOut].find((o) => o !== null)).toEqual({ ok: false, reason: 'occupied' });
  });

  it('the same port claimed twice at once: only the claim the CRDT kept — its stamp too — has docked', () => {
    const doc = stationDoc(); // d:bay holds this port's dock, stamped 100
    expect(berthAfterSettle(doc, dockReq(near.doorId, 300), near)).toEqual({ ok: false, reason: 'superseded' });
    expect(berthAfterSettle(doc, dockReq(near.doorId, 100), near)).toBeNull();
  });

  it('a berth closed under the claim reports closed', () => {
    const doc = stationDoc();
    doc.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP)));
    doc.getMap('doorPolicy').set('d:bay', { passage: 'public', construction: 'owner', adapter: false });
    expect(berthAfterSettle(doc, dockReq(near.doorId, 300), near)).toEqual({ ok: false, reason: 'closed' });
  });
});

describe('writeFarDock — a dock between two doors of ONE module', () => {
  const boot = { roomId: SHIP, wtUrl: '', certHashesB64: [] };
  const nearA: NearEnd = { roomId: SHIP, address: seedFor(SHIP), doorId: 'd:a', wall: 'x-', lateral: 0 };

  /** The ship: two port doors docked to each other. */
  function shipDoc(): Y.Doc {
    const doc = new Y.Doc();
    doc.getMap('doorLayout').set('d:a', { id: 'd:a', wall: 'x-', lateral: 0, placed: true });
    doc.getMap('doorLayout').set('d:b', { id: 'd:b', wall: 'x+', lateral: 0, placed: true });
    for (const id of ['d:a', 'd:b']) {
      doc.getMap('doorPolicy').set(id, { passage: 'public', construction: 'owner', adapter: true });
    }
    const dock = (farDoor: string) =>
      buildDoorPairing(seedFor(SHIP), { segments: dockChain(), farDoor, transient: true, dockedAt: 100 });
    doc.getMap('doors').set('d:a', dock('d:b'));
    doc.getMap('doors').set('d:b', dock('d:a'));
    return doc;
  }

  it('writes the OTHER door in the bound doc — UNDOCK and DOCK alike', async () => {
    vi.useFakeTimers();
    try {
      const ship = shipDoc();
      initFarDoorWrite({
        decode: () => boot,
        resolve: async (b) => b,
        hostedHere: () => true,
        activeRoomDoc: (roomId) => (roomId === SHIP ? ship : null),
      });
      // UNDOCK at d:a (its own tombstone is the caller's): d:b lets go too.
      ship.getMap('doors').set('d:a', buildDoorTombstone(seedFor(SHIP), { farDoor: 'd:b', undockedAt: 101 }));
      expect(
        await writeFarDock(
          { kind: 'undock', farAddress: seedFor(SHIP), farDoor: 'd:b', nearDoorId: 'd:a', undockedAt: 101 },
          nearA,
        ),
      ).toEqual({ ok: true, detail: 'written' });
      expect(readDoorFrom(ship, 'd:b')).toEqual(
        buildDoorTombstone(seedFor(SHIP), { farDoor: 'd:a', farWall: 'x-', farLateral: 0, undockedAt: 101 }),
      );
      // DOCK again from d:a: d:b is re-made in the same doc, once it settles.
      const docking = writeFarDock(
        { kind: 'dock', farAddress: seedFor(SHIP), farDoor: 'd:b', nearDoorId: 'd:a', dockedAt: 102 },
        nearA,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await docking).toEqual({ ok: true, detail: 'written' });
      expect(readDoorFrom(ship, 'd:b')).toMatchObject({ paired: true, farDoor: 'd:a', dockedAt: 102 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a same-room DOCK settles too — of two doors re-docked to one at once, only the kept claim holds', async () => {
    vi.useFakeTimers();
    try {
      // A third port d:c; d:a ↔ d:b undocked, so d:b is a free berth.
      const base = shipDoc();
      base.getMap('doorLayout').set('d:c', { id: 'd:c', wall: 'y+', lateral: 0, placed: true });
      base.getMap('doorPolicy').set('d:c', { passage: 'public', construction: 'owner', adapter: true });
      base.getMap('doors').set('d:a', buildDoorTombstone(seedFor(SHIP), { farDoor: 'd:b', undockedAt: 150 }));
      base.getMap('doors').set('d:b', buildDoorTombstone(seedFor(SHIP), { farDoor: 'd:a', undockedAt: 150 }));
      const a = new Y.Doc();
      const b = new Y.Doc();
      Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
      initFarDoorWrite({
        decode: () => boot,
        resolve: async (x) => x,
        hostedHere: () => true,
        activeRoomDoc: (roomId) => (roomId === SHIP ? a : null),
      });
      // This client re-docks d:a → d:b …
      const mine = writeFarDock(
        { kind: 'dock', farAddress: seedFor(SHIP), farDoor: 'd:b', nearDoorId: 'd:a', dockedAt: 300 },
        nearA,
      );
      await vi.advanceTimersByTimeAsync(0); // its claim is written
      // … while another client, on its own replica, docks d:c → d:b.
      const nearC: NearEnd = { roomId: SHIP, address: seedFor(SHIP), doorId: 'd:c', wall: 'y+', lateral: 0 };
      expect(
        applyFarDockRequest(
          b,
          { kind: 'dock', farAddress: seedFor(SHIP), farDoor: 'd:b', nearDoorId: 'd:c', dockedAt: 301 },
          nearC,
        ).wrote,
      ).toBe(true);
      // The settle window: the replicas exchange their claims.
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      await vi.advanceTimersByTimeAsync(2_000);
      const out = await mine;
      const kept = readDoorFrom(a, 'd:b');
      expect(kept).toEqual(readDoorFrom(b, 'd:b')); // one berth, one answer
      const ours = kept?.paired === true && kept.farDoor === 'd:a';
      expect(out).toEqual(ours ? { ok: true, detail: 'written' } : { ok: false, reason: 'occupied' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says unreachable — and writes nothing — once this client stands elsewhere', async () => {
    const ship = shipDoc();
    initFarDoorWrite({ decode: () => boot, resolve: async (b) => b, hostedHere: () => true, activeRoomDoc: () => null });
    const before = Y.encodeStateVector(ship);
    expect(
      await writeFarDock(
        { kind: 'undock', farAddress: seedFor(SHIP), farDoor: 'd:b', nearDoorId: 'd:a', undockedAt: 101 },
        nearA,
      ),
    ).toEqual({ ok: false, reason: 'unreachable' });
    expect(Y.encodeStateVector(ship)).toEqual(before);
  });
});

describe('roomStateReady — whose copy of the far room counts', () => {
  it('a room hosted here: the owner + name on our node will do', () => {
    expect(roomStateReady({ linkedSynced: false, hasOwnerAndName: true, hostedHere: true })).toBe(true);
    expect(roomStateReady({ linkedSynced: false, hasOwnerAndName: false, hostedHere: true })).toBe(false);
  });

  it('a room hosted elsewhere: only a fresh answer from its live host — never the cached copy', () => {
    expect(roomStateReady({ linkedSynced: false, hasOwnerAndName: true, hostedHere: false })).toBe(false);
    expect(roomStateReady({ linkedSynced: true, hasOwnerAndName: false, hostedHere: false })).toBe(true);
  });
});

// ── YjsSync.confirmOwnWrites against an in-memory node ───────────────────────

/** Minimal y-sync framing, mirroring YjsSync's own (varuint type, subtype,
 *  length, bytes) inside a JSON envelope behind a u32 LE length prefix. */
function readVarUint(buf: Uint8Array, at: { i: number }): number {
  let value = 0;
  let shift = 0;
  while (at.i < buf.length) {
    const b = buf[at.i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return value;
}
function varUint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A node holding `nodeDoc`: applies Updates (unless `dropUpdates`), answers
 *  every SyncStep1 with a SyncStep2 from its replica, in stream order. */
function fakeNode(nodeDoc: Y.Doc, opts: { dropUpdates?: boolean } = {}) {
  let toClient!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { toClient = c; } });
  let pending = new Uint8Array(0);
  const reply = (subtype: number, data: Uint8Array) => {
    const payload = new Uint8Array([...varUint(0), ...varUint(subtype), ...varUint(data.length), ...data]);
    const json = new TextEncoder().encode(JSON.stringify({ v: 1, room: 'r', kind: 'ysync', seq: 0, payload: b64(payload) }));
    const frame = new Uint8Array(4 + json.length);
    new DataView(frame.buffer).setUint32(0, json.length, true);
    frame.set(json, 4);
    toClient.enqueue(frame);
  };
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      pending = merged;
      while (pending.length >= 4) {
        const len = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0, true);
        if (pending.length < 4 + len) break;
        const env = JSON.parse(new TextDecoder().decode(pending.subarray(4, 4 + len)));
        pending = pending.subarray(4 + len);
        const msg = unb64(env.payload);
        const at = { i: 0 };
        readVarUint(msg, at); // type
        const subtype = readVarUint(msg, at);
        const dlen = readVarUint(msg, at);
        const data = msg.subarray(at.i, at.i + dlen);
        if (subtype === 0) reply(1, Y.encodeStateAsUpdate(nodeDoc, data));
        else if (!opts.dropUpdates) Y.applyUpdate(nodeDoc, data);
      }
    },
  });
  return { readable, writable };
}

describe('YjsSync.confirmOwnWrites — the far write\'s acknowledgment', () => {
  const connected = async (nodeDoc: Y.Doc, opts?: { dropUpdates?: boolean }) => {
    // bootRecord supplied, so the envelope builder never reaches for `window`.
    const sync = new YjsSync({ roomId: 'r', channel: fakeNode(nodeDoc, opts), bootRecord: () => ({}) });
    await sync.start();
    await sync.whenServerSynced;
    return sync;
  };

  it('resolves true once the node has APPLIED our write', async () => {
    const nodeDoc = stationDoc();
    const sync = await connected(nodeDoc);
    expect(readAllDoorsFrom(sync.doc).get('d:bay')?.paired).toBe(true); // real state first
    const since = Y.encodeStateVector(sync.doc);
    sync.doc.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP), { undockedAt: 1 }));
    expect(await sync.confirmOwnWrites(since, 2000)).toBe(true);
    expect(readAllDoorsFrom(nodeDoc).get('d:bay')?.paired).toBe(false);
    await sync.stop();
  });

  it('times out false when the node never applies it', async () => {
    const nodeDoc = stationDoc();
    const sync = await connected(nodeDoc, { dropUpdates: true });
    const since = Y.encodeStateVector(sync.doc);
    sync.doc.getMap('doors').set('d:bay', buildDoorTombstone(seedFor(SHIP), { undockedAt: 1 }));
    expect(await sync.confirmOwnWrites(since, 150)).toBe(false);
    expect(readAllDoorsFrom(nodeDoc).get('d:bay')?.paired).toBe(true);
    await sync.stop();
  });
});
