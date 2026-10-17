/**
 * 🚪🔥 Warm neighbours (neighbourWarm.createNeighbourWarmer), over stand-in
 * sessions: which rooms it dials, when it hangs up, what it hands a join, and
 * how it treats a failed open, a keyed room and a pass that changed.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { RoomSession } from './roomSession';
import { createNeighbourWarmer, MAX_WARM_NEIGHBOURS, RETRY_MS } from './neighbourWarm';

interface FakeSession extends RoomSession {
  closes: number;
}

function fakeSession(roomId: string, fill?: (doc: Y.Doc) => void): FakeSession {
  const doc = new Y.Doc();
  fill?.(doc);
  const s = {
    roomId,
    doc,
    closes: 0,
    closed: false,
    confirm: () => Promise.resolve(true),
    close() {
      s.closes++;
      s.closed = true;
    },
  };
  return s as FakeSession;
}

/** A stand-in opener: each dial waits until the test answers it. */
function harness() {
  const dials: Array<{ address: string; answer: (s: RoomSession | null) => Promise<void> }> = [];
  let clock = 0;
  const warmer = createNeighbourWarmer({
    open: (address) =>
      new Promise<RoomSession | null>((resolve) => {
        dials.push({
          address,
          answer: async (s) => {
            resolve(s);
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      }),
    now: () => clock,
  });
  return { warmer, dials, tick: (ms: number) => (clock += ms) };
}

const n = (roomId: string, address = `pass:${roomId}`) => ({ roomId, address });

describe('createNeighbourWarmer', () => {
  it('dials each neighbour once, never the current room, up to the cap', () => {
    const { warmer, dials } = harness();
    const many = Array.from({ length: MAX_WARM_NEIGHBOURS + 2 }, (_, i) => n(`r${i}`));
    warmer.setNeighbours([n('here'), n('r0'), ...many], 'here');
    expect(dials.map((d) => d.address)).toEqual(many.slice(0, MAX_WARM_NEIGHBOURS).map((m) => m.address));
    warmer.setNeighbours(many, 'here');
    expect(dials).toHaveLength(MAX_WARM_NEIGHBOURS);
  });

  it('hands a join the warm replica once the session is open', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('next')], 'here');
    expect(warmer.warmStateFor('next')).toBeNull();
    await dials[0].answer(fakeSession('next', (d) => d.getMap('roomInfo').set('name', 'Galley')));
    expect(warmer.warmRoomIds()).toEqual(['next']);
    const joined = new Y.Doc();
    expect(warmer.seedDoc(joined, 'next')).toBe(true);
    expect(joined.getMap('roomInfo').get('name')).toBe('Galley');
    expect(warmer.seedDoc(new Y.Doc(), 'elsewhere')).toBe(false);
  });

  it('hangs up a room that is no longer next door, including one still dialling', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('a'), n('b')], 'here');
    const a = fakeSession('a');
    await dials[0].answer(a);
    warmer.setNeighbours([], 'here');
    expect(a.closes).toBe(1);
    const b = fakeSession('b');
    await dials[1].answer(b);
    expect(b.closes).toBe(1);
    expect(warmer.warmRoomIds()).toEqual([]);
  });

  it('keeps the room just left warm when it is a neighbour of the new room', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('b')], 'a');
    const b = fakeSession('b');
    await dials[0].answer(b);
    // Walked into b: a is now next door, b is where we stand.
    warmer.setNeighbours([n('a')], 'b');
    expect(b.closes).toBe(1);
    expect(dials.map((d) => d.address)).toEqual(['pass:b', 'pass:a']);
  });

  it('hangs up a keyed room and leaves it alone until the retry time', async () => {
    const { warmer, dials, tick } = harness();
    warmer.setNeighbours([n('vault')], 'here');
    const s = fakeSession('vault', (d) => d.getMap('roomInfo').set('accessMode', 'keyed'));
    await dials[0].answer(s);
    expect(s.closes).toBe(1);
    expect(warmer.warmStateFor('vault')).toBeNull();
    warmer.setNeighbours([n('vault')], 'here');
    expect(dials).toHaveLength(1);
    tick(RETRY_MS);
    warmer.setNeighbours([n('vault')], 'here');
    expect(dials).toHaveLength(2);
  });

  it('retries a failed open only after the retry time', async () => {
    const { warmer, dials, tick } = harness();
    warmer.setNeighbours([n('far')], 'here');
    await dials[0].answer(null);
    warmer.setNeighbours([n('far')], 'here');
    expect(dials).toHaveLength(1);
    tick(RETRY_MS - 1);
    warmer.setNeighbours([n('far')], 'here');
    expect(dials).toHaveLength(1);
    tick(1);
    warmer.setNeighbours([n('far')], 'here');
    expect(dials).toHaveLength(2);
  });

  it('redials when the door holds a new pass for the same room', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('b', 'old')], 'here');
    const old = fakeSession('b');
    await dials[0].answer(old);
    warmer.setNeighbours([n('b', 'new')], 'here');
    expect(old.closes).toBe(1);
    expect(dials.map((d) => d.address)).toEqual(['old', 'new']);
  });

  it('redials a session the far end hung up', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('b')], 'here');
    const s = fakeSession('b');
    await dials[0].answer(s);
    s.close();
    expect(warmer.warmStateFor('b')).toBeNull();
    warmer.setNeighbours([n('b')], 'here');
    expect(dials).toHaveLength(2);
  });

  it('closeAll hangs up everything', async () => {
    const { warmer, dials } = harness();
    warmer.setNeighbours([n('a'), n('b')], 'here');
    const a = fakeSession('a');
    await dials[0].answer(a);
    warmer.closeAll();
    expect(a.closes).toBe(1);
    const b = fakeSession('b');
    await dials[1].answer(b);
    expect(b.closes).toBe(1);
  });
});
