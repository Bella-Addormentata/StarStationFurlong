/**
 * 🪙📒 The coin pusher operator on a doc holding part of an update, where
 * the machine's record rewritten in the part still to come reads as gone
 * (Yjs parks the rewrite but applies its delete at once): it writes no fresh
 * machine over it, and a teardown waits for the rest before it drains, so
 * the chips inside are neither dropped nor left in a removed cabinet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindCasinoDoc, casinoWhole, readChips, readCoinPusherState } from './casinoDoc';
import { setSoleCroupierPredicate } from './croupier';
import { chipsInMachine, initialCoinPusherState, processInsert, type CoinPusherState, type PusherHole } from './games/coinPusher';
import { getPlayerId } from './identity';
import { closeCoinPusher, leaveCoinPusherRoom, operateCoinPusher, tickCoinPusherRoom } from './pusherCroupier';

const OPERATOR = getPlayerId();
const OTHER = 'player-Carol';
const MACHINE = 'pusher-1';
const NOW = 1_000_000;

function machineWith(n: number, owner = OPERATOR): CoinPusherState {
  let s = initialCoinPusherState(owner, 0);
  for (let i = 0; i < n; i++) {
    s = processInsert(s, OTHER, (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  }
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setSoleCroupierPredicate(() => true);
});

afterEach(() => {
  leaveCoinPusherRoom();
  vi.useRealTimers();
});

describe('coin pusher operator on a doc holding part of an update', () => {
  for (const [label, prevClient, nextClient] of [['new operator wins ties', 1, 9], ['new operator loses ties', 9, 1]] as const) {
    it(`does not write a fresh machine over one whose rewrite is parked (${label})`, () => {
      // The previous operator's page (another of the owner's sessions).
      const prev = new Y.Doc();
      prev.clientID = prevClient;
      prev.getMap('casino').set(`pusher:${MACHINE}`, machineWith(60));
      // This page, the operator now, has seen that machine.
      const doc = new Y.Doc();
      doc.clientID = nextClient;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(prev));
      bindCasinoDoc(doc);
      const before = chipsInMachine(readCoinPusherState(MACHINE)!);
      expect(before).toBeGreaterThan(0);
      // The previous operator's last two writes: something else, then a settle
      // (a rewrite of the machine). This page gets the second first.
      const ups: Uint8Array[] = [];
      prev.on('update', (u: Uint8Array) => ups.push(u));
      prev.getMap('casino').set('seat:craps-1:player-Zed', { stand: 0, angle: 0, at: 1 });
      prev.getMap('casino').set(`pusher:${MACHINE}`, machineWith(61));
      Y.applyUpdate(doc, ups[1]);
      expect(casinoWhole()).toBe(false);
      expect(readCoinPusherState(MACHINE)).toBeNull(); // reads as gone
      operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1);
      Y.applyUpdate(doc, ups[0]);
      Y.applyUpdate(prev, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(prev)));
      expect(casinoWhole()).toBe(true);
      const after = readCoinPusherState(MACHINE)!;
      const prevAfter = prev.getMap('casino').get(`pusher:${MACHINE}`) as CoinPusherState;
      // The machine keeps the chips inside it (the 61-drop machine), on both pages.
      expect(chipsInMachine(after)).toBe(chipsInMachine(machineWith(61)));
      expect(chipsInMachine(prevAfter)).toBe(chipsInMachine(machineWith(61)));
    });
  }

  it('a removed cabinet torn down meanwhile pays its owner what the machine holds, once the rest comes', () => {
    const prev = new Y.Doc();
    prev.clientID = 1;
    prev.getMap('casino').set(`pusher:${MACHINE}`, machineWith(60));
    const doc = new Y.Doc();
    doc.clientID = 9;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(prev));
    bindCasinoDoc(doc);
    // This page operates the room's pushers (past its settling wait).
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 2_000);
    expect(readCoinPusherState(MACHINE)!.ownerId).toBe(OPERATOR);
    sync(prev, doc);
    const ups: Uint8Array[] = [];
    prev.on('update', (u: Uint8Array) => ups.push(u));
    prev.getMap('casino').set('seat:craps-1:player-Zed', { stand: 0, angle: 0, at: 1 });
    // (the previous operator's last settle, re-owned by this page meanwhile)
    prev.getMap('casino').set(`pusher:${MACHINE}`, { ...machineWith(61), ownerId: OPERATOR, tick: 999 });
    Y.applyUpdate(doc, ups[1]);
    expect(casinoWhole()).toBe(false);
    const chips0 = readChips(OPERATOR);
    // The cabinet is removed: the operator drains it.
    vi.setSystemTime(NOW + 3_000);
    closeCoinPusher(MACHINE, true, NOW + 3_000);
    Y.applyUpdate(doc, ups[0]);
    sync(prev, doc);
    expect(casinoWhole()).toBe(true);
    // The room's next frames (the cabinet is gone from the room).
    for (let t = NOW + 3_100; t <= NOW + 4_000; t += 100) { vi.setSystemTime(t); tickCoinPusherRoom([], t); }
    const left = readCoinPusherState(MACHINE);
    const inside = left ? chipsInMachine(left) : 0;
    const paid = readChips(OPERATOR) - chips0;
    // Every chip the machine held ends up paid to the owner, none left in a removed cabinet.
    expect({ paid, inside }).toEqual({ paid: chipsInMachine(machineWith(61)), inside: 0 });
  });
});

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}
