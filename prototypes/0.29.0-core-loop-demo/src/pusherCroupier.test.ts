/**
 * 🪙 pusherCroupier tests (issue #135): the operator's election, ownership,
 * and one pass of its work — settling, refusing and emptying — against a real
 * Yjs-backed casino map.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequest,
  readCoinPusherState,
  writeCoinPusherEmptyRequest,
  writeCoinPusherOperatorLease,
  writeCoinPusherRequest,
  writeCoinPusherState,
} from './casinoDoc';
import { setSoleCroupierPredicate } from './croupier';
import {
  chipsInMachine,
  currentPusherPhase,
  initialCoinPusherState,
  MACHINE_MAX_CHIPS,
  MAX_DROP_LAG_MS,
  processInsert,
  PUSHER_STALE_REQUEST_MS,
  type CoinPusherState,
  type Pile,
  type PusherHole,
  type PusherInsertRequest,
} from './games/coinPusher';
import { getPlayerId } from './identity';
import {
  closeCoinPusher,
  isCoinPusherOperator,
  operateCoinPusher,
  tickCoinPusherMachine,
} from './pusherCroupier';

const OPERATOR = getPlayerId();
const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';
const ATTACKER = 'attacker-Mallory';
const MACHINE = 'pusher-1';
const NOW = 1_000_000;

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  setSoleCroupierPredicate(() => true);
});

afterEach(() => {
  setSoleCroupierPredicate(() => true);
});

/** A machine owned by `owner` that has taken `n` drops from OTHER. */
function machineWith(n: number, owner = OPERATOR): CoinPusherState {
  let s = initialCoinPusherState(owner, 0);
  for (let i = 0; i < n; i++) {
    s = processInsert(s, OTHER, (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  }
  return s;
}

function request(
  player: string,
  requestId: string,
  phase: number,
  requestedAt = NOW - 100,
  hole: PusherHole = 1,
): PusherInsertRequest {
  return { requestId, player, hole, phase, requestedAt };
}

// ── One pass of work ─────────────────────────────────────────────────────────

describe('operateCoinPusher', () => {
  it('creates a missing machine, owned by the operator', () => {
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const s = readCoinPusherState(MACHINE)!;
    expect(s.ownerId).toBe(OPERATOR);
    expect(chipsInMachine(s)).toBe(0);
  });

  it('re-owns a machine owned by anyone else: the chips stay inside and nobody is paid', () => {
    const before = machineWith(30, ATTACKER);
    writeCoinPusherState(MACHINE, before);
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const after = readCoinPusherState(MACHINE)!;
    expect(after.ownerId).toBe(OPERATOR);
    expect(after.upper).toEqual(before.upper);
    expect(after.lower).toEqual(before.lower);
    expect(after.tick).toBe(before.tick + 1);
    expect(readChips(ATTACKER)).toBe(0);
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('settles a drop made in time: one chip in, the payout out, the player\'s phase kept', () => {
    const base = machineWith(60);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 3);
    const seen = currentPusherPhase(base, NOW - 300); // pressed 300 ms ago
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', seen));
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1234);
    const after = readCoinPusherState(MACHINE)!;
    const drop = after.lastDrop!;
    expect(drop.requestId).toBe('req-1');
    expect(drop.honored).toBe(true);
    expect(drop.phase).toBe(seen);
    // Exactly the engine's drop at that phase with the operator's seed.
    const expected = processInsert(base, PLAYER, 1, seen, 1234);
    expect(after.upper).toEqual(expected.state.upper);
    expect(after.lower).toEqual(expected.state.lower);
    expect(drop.paid).toBe(expected.paid);
    expect(readChips(PLAYER)).toBe(3 - 1 + expected.paid);
    expect(after.totalInserted).toBe(base.totalInserted + 1);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
  });

  it('a late drop falls at the pusher\'s current phase instead', () => {
    const base = machineWith(20);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 3);
    const stale = currentPusherPhase(base, NOW - MAX_DROP_LAG_MS - 200);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', stale));
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1);
    const drop = readCoinPusherState(MACHINE)!.lastDrop!;
    expect(drop.honored).toBe(false);
    expect(drop.phase).toBeCloseTo(currentPusherPhase(base, NOW), 12);
    expect(readChips(PLAYER)).toBe(2 + drop.paid);
  });

  it('draws the seed itself, once per drop', () => {
    writeCoinPusherState(MACHINE, machineWith(10));
    buyInChips(PLAYER, 3);
    buyInChips(OTHER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'a-1', 0.2));
    writeCoinPusherRequest(MACHINE, request(OTHER, 'b-2', 0.7));
    let draws = 0;
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => { draws += 1; return draws; });
    expect(draws).toBe(2);
    // Both settled in one pass, oldest first: the later one is the last drop.
    expect(readCoinPusherState(MACHINE)!.lastDrop!.requestId).toBe('b-2');
    expect(readChips(PLAYER) + readChips(OTHER)).toBe(
      6 - 2 + (readCoinPusherState(MACHINE)!.totalPaid - machineWith(10).totalPaid),
    );
  });

  it('refuses a request from a player without a chip, and nothing moves', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    // Written straight into the map — no helper, no balance.
    doc.getMap('casino').set(`pusher-req:${MACHINE}:${ATTACKER}`, request(ATTACKER, 'forged', 0.5));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const after = readCoinPusherState(MACHINE)!;
    expect(after.lastRefusal).toMatchObject({ requestId: 'forged', player: ATTACKER, reason: 'no-chips' });
    expect(after.totalInserted).toBe(base.totalInserted);
    expect(after.upper).toEqual(base.upper);
    expect(after.lower).toEqual(base.lower);
    expect(readChips(ATTACKER)).toBe(0);
    expect(readCoinPusherRequest(MACHINE, ATTACKER)).toBeNull();
  });

  it('refuses a request left over from long ago', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'old', 0.5, NOW - PUSHER_STALE_REQUEST_MS - 1));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherState(MACHINE)!.lastRefusal?.reason).toBe('expired');
    expect(readChips(PLAYER)).toBe(3);
  });

  it('refuses a drop into a full machine', () => {
    const n = { id: 1 };
    const pile = (x: number): Pile => {
      const chipIds = Array.from({ length: 8 }, () => n.id++);
      return { x, count: 8, chipIds };
    };
    const full: CoinPusherState = {
      ...initialCoinPusherState(OPERATOR, 0),
      upper: Array.from({ length: 16 }, (_, i) => pile(i * 0.06)),
      totalInserted: MACHINE_MAX_CHIPS,
    };
    full.nextChipId = n.id;
    writeCoinPusherState(MACHINE, full);
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', 0.5));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherState(MACHINE)!.lastRefusal?.reason).toBe('machine-full');
    expect(readChips(PLAYER)).toBe(3);
  });

  it('opens the door for the owner and ignores a door request from anyone else', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd1', requester: ATTACKER, requestedAt: NOW });
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(chipsInMachine(base));
    expect(readChips(ATTACKER)).toBe(0);

    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd2', requester: OPERATOR, requestedAt: NOW });
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(0);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });
});

// ── Election ─────────────────────────────────────────────────────────────────

describe('tickCoinPusherMachine', () => {
  it('only the deed holder operates', () => {
    setSoleCroupierPredicate(() => false);
    tickCoinPusherMachine(MACHINE, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 5_000);
    expect(readCoinPusherOperatorLease(MACHINE)).toBeNull();
    expect(readCoinPusherState(MACHINE)).toBeNull();
  });

  it('takes the lease, waits for it to settle, then works', () => {
    tickCoinPusherMachine(MACHINE, NOW);
    expect(readCoinPusherOperatorLease(MACHINE)?.playerId).toBe(OPERATOR);
    expect(readCoinPusherState(MACHINE)).toBeNull(); // still settling
    tickCoinPusherMachine(MACHINE, NOW + 2_000);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
    expect(isCoinPusherOperator(MACHINE, NOW + 2_000)).toBe(true);
  });

  it('leaves a live lease held by another session alone, and takes it once it lapses', () => {
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: 'other-tab', expiresAt: NOW + 5_000 });
    tickCoinPusherMachine(MACHINE, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 2_500);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe('other-tab');
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherMachine(MACHINE, NOW + 5_001);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).not.toBe('other-tab');
    tickCoinPusherMachine(MACHINE, NOW + 7_001);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
  });

  it('stops and releases the lease when this client is no longer the deed holder', () => {
    tickCoinPusherMachine(MACHINE, NOW);
    expect(readCoinPusherOperatorLease(MACHINE)).not.toBeNull();
    setSoleCroupierPredicate(() => false);
    tickCoinPusherMachine(MACHINE, NOW + 100);
    expect(readCoinPusherOperatorLease(MACHINE)).toBeNull();
  });
});

// ── Removal ──────────────────────────────────────────────────────────────────

describe('closeCoinPusher', () => {
  it('a managing client pays the chips inside to the owner and clears the machine', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    closeCoinPusher(MACHINE, true);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
  });

  it('any other client only stops operating', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    closeCoinPusher(MACHINE, false);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
  });
});
