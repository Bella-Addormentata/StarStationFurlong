/**
 * 🕹 arcadeSession — the P1 page renews its seat on the cadence and stands
 * up from every cabinet when the room is left.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindArcadeDoc, insertCoin, readSeat, setArcadeClock, setArcadeHostPredicate, setArcadeIdentity,
  setArcadePageId, ARCADE_SEAT_RENEW_MS,
} from './arcadeDoc';
import { leaveArcadeRoom, tickArcadeRoom } from './arcadeSession';

const CAB = 'arcade-cabinet-1';
let now = 5_000_000;

beforeEach(() => {
  now = 5_000_000;
  setArcadeClock(() => now);
  setArcadeHostPredicate(() => false);
  setArcadePageId('tab-a');
  setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
  bindArcadeDoc(new Y.Doc());
  leaveArcadeRoom([]); // clears the module's own timers
});

describe('the P1 page keeps its seat', () => {
  it('renews every ARCADE_SEAT_RENEW_MS, and not otherwise', () => {
    insertCoin(CAB);
    const t0 = readSeat(CAB).leaseAt;
    tickArcadeRoom([CAB], now); // the first tick renews at once (a baseline)
    now += ARCADE_SEAT_RENEW_MS - 1;
    tickArcadeRoom([CAB], now);
    expect(readSeat(CAB).leaseAt).toBe(t0);
    now += 1;
    tickArcadeRoom([CAB], now);
    expect(readSeat(CAB).leaseAt).toBe(now);
  });

  it('does nothing for a seat that is not mine', () => {
    tickArcadeRoom([CAB], now);
    expect(readSeat(CAB).holder).toBe('');
    setArcadeIdentity(() => ({ pub: 'BBBBbobpub', name: 'Bob' }));
    insertCoin(CAB);
    const theirs = readSeat(CAB);
    setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
    now += ARCADE_SEAT_RENEW_MS * 2;
    tickArcadeRoom([CAB], now);
    expect(readSeat(CAB)).toEqual(theirs);
  });

  it('leaving the room stands up from every cabinet this page holds', () => {
    insertCoin(CAB);
    insertCoin('arcade-cabinet-2');
    leaveArcadeRoom([CAB, 'arcade-cabinet-2', 'arcade-cabinet-3']);
    expect(readSeat(CAB).holder).toBe('');
    expect(readSeat('arcade-cabinet-2').holder).toBe('');
  });
});
