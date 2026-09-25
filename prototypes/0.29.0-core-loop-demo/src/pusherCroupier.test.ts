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
  drainAndClearCoinPusher,
  PUSHER_SWEEP_BATCH,
  readChips,
  readCoinPusherDoorResult,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequest,
  readCoinPusherRequests,
  readCoinPusherResult,
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
  PUSHER_PERIOD_MS,
  PUSHER_STALE_REQUEST_MS,
  RECENT_DROPS_MAX,
  unseenDropHoles,
  type CoinPusherState,
  type Pile,
  type PusherHole,
  type PusherInsertRequest,
} from './games/coinPusher';
import { getPlayerId } from './identity';
import {
  closeCoinPusher,
  coinPusherOperatorSession,
  isCoinPusherOperator,
  MAX_REQUESTS_PER_POLL,
  OPERATOR_UNCLEAN_TAKEOVER_MS,
  operateCoinPusher,
  tickCoinPusherMachine,
  tickCoinPusherTeardowns,
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
  closeCoinPusher(MACHINE, false); // reset this session's state for MACHINE
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

function sync(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
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
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', seen, NOW - 300));
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
    const pressedAt = NOW - MAX_DROP_LAG_MS - 200;
    writeCoinPusherRequest(MACHINE,
      request(PLAYER, 'req-1', currentPusherPhase(base, pressedAt), pressedAt));
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1);
    const drop = readCoinPusherState(MACHINE)!.lastDrop!;
    expect(drop.honored).toBe(false);
    expect(drop.phase).toBeCloseTo(currentPusherPhase(base, NOW), 12);
    expect(readChips(PLAYER)).toBe(2 + drop.paid);
  });

  it('a drop pressed a whole cycle ago is late too, though the pusher is back where it was', () => {
    const base = machineWith(20);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 3);
    const pressedAt = NOW - PUSHER_PERIOD_MS - 100;
    writeCoinPusherRequest(MACHINE,
      request(PLAYER, 'req-1', currentPusherPhase(base, pressedAt), pressedAt));
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1);
    const drop = readCoinPusherState(MACHINE)!.lastDrop!;
    expect(drop.honored).toBe(false);
    expect(drop.phase).toBeCloseTo(currentPusherPhase(base, NOW), 12);
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

  it('records every drop a poll settles for the cabinet, not just the last', () => {
    const base = machineWith(10);
    writeCoinPusherState(MACHINE, base);
    const holes: PusherHole[] = [0, 2, 1];
    holes.forEach((hole, i) => {
      buyInChips(`p${i}`, 1);
      writeCoinPusherRequest(MACHINE, request(`p${i}`, `r-${i}`, 0.5, NOW - 100, hole));
    });
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 7);
    const after = readCoinPusherState(MACHINE)!;
    expect(after.lastDrop!.requestId).toBe('r-2');
    // A cabinet that last looked before the poll lights all three holes.
    expect(unseenDropHoles(after, base.nextChipId)).toEqual(holes);
  });

  it('keeps the recent drops to RECENT_DROPS_MAX', () => {
    writeCoinPusherState(MACHINE, machineWith(10));
    for (let i = 0; i < RECENT_DROPS_MAX + 3; i++) {
      buyInChips(`q${i}`, 1);
      writeCoinPusherRequest(MACHINE, request(`q${i}`, `r-${String(i).padStart(2, '0')}`, 0.5, NOW - 100, (i % 3) as PusherHole));
      operateCoinPusher(MACHINE, OPERATOR, NOW, () => i);
    }
    const after = readCoinPusherState(MACHINE)!;
    expect(after.recentDrops).toHaveLength(RECENT_DROPS_MAX);
    expect(after.recentDrops!.at(-1)!.chipId).toBe(after.nextChipId - 1);
  });

  it('refuses a request from a player without a chip, and nothing moves', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    // Written straight into the map — no helper, no balance.
    doc.getMap('casino').set(`pusher-req:${MACHINE}:${ATTACKER}`, request(ATTACKER, 'forged', 0.5));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const after = readCoinPusherState(MACHINE)!;
    expect(readCoinPusherResult(MACHINE, ATTACKER)).toMatchObject({
      kind: 'refused', requestId: 'forged', reason: 'no-chips',
    });
    expect(after).toEqual(base);
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
    expect(readCoinPusherResult(MACHINE, PLAYER)).toMatchObject({ kind: 'refused', reason: 'expired' });
    expect(readChips(PLAYER)).toBe(3);
  });

  it('refuses a drop into a full machine', () => {
    const n = { id: 1 };
    const pile = (x: number): Pile => {
      const chipIds = Array.from({ length: 8 }, () => n.id++);
      return { x, count: 8, chipIds };
    };
    // 8 piles of 8 on each platform, spaced one pile apart: 128 chips.
    const full: CoinPusherState = {
      ...initialCoinPusherState(OPERATOR, 0),
      upper: Array.from({ length: 8 }, (_, i) => pile(0.03 + i * 0.06)),
      lower: Array.from({ length: 8 }, (_, i) => pile(0.63 + i * 0.06)),
      totalInserted: MACHINE_MAX_CHIPS,
    };
    full.nextChipId = n.id;
    expect(writeCoinPusherState(MACHINE, full)).toBe(true);
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', 0.5));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherResult(MACHINE, PLAYER)).toMatchObject({ kind: 'refused', reason: 'machine-full' });
    expect(readChips(PLAYER)).toBe(3);
  });

  it('works through a bounded batch per pass however many requests are queued', () => {
    writeCoinPusherState(MACHINE, machineWith(20));
    const queued = 3 * MAX_REQUESTS_PER_POLL + 1;
    for (let i = 0; i < queued; i++) {
      const pid = `flood-${i}`; // no chips: each is refused
      doc.getMap('casino').set(`pusher-req:${MACHINE}:${pid}`,
        request(pid, `r-${String(i).padStart(3, '0')}`, 0.5));
    }
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherRequests(MACHINE)).toHaveLength(queued - MAX_REQUESTS_PER_POLL);
    // Oldest first: the first batch was answered.
    expect(readCoinPusherResult(MACHINE, 'flood-0')?.requestId).toBe('r-000');
    expect(readCoinPusherResult(MACHINE, `flood-${MAX_REQUESTS_PER_POLL}`)).toBeNull();
    for (let pass = 0; pass < 3; pass++) operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherRequests(MACHINE)).toHaveLength(0);
  });

  it('opens the door for the owner and turns anyone else down — answering each', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd1', requester: ATTACKER, requestedAt: NOW });
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(readCoinPusherDoorResult(MACHINE)).toEqual({ kind: 'refused', requestId: 'd1', atMs: NOW });
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(chipsInMachine(base));
    expect(readChips(ATTACKER)).toBe(0);

    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd2', requester: OPERATOR, requestedAt: NOW });
    operateCoinPusher(MACHINE, OPERATOR, NOW + 1);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(readCoinPusherDoorResult(MACHINE)).toEqual({
      kind: 'opened', requestId: 'd2', emptied: chipsInMachine(base), atMs: NOW + 1,
    });
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(0);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it('a door request left by a previous owner is answered as refused, not as an empty machine', () => {
    // The deed changed hands while the old owner's door request was pending:
    // the new operator re-owns the machine, then turns the request down.
    const base = machineWith(40, OTHER);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd-old', requester: OTHER, requestedAt: NOW });
    operateCoinPusher(MACHINE, OPERATOR, NOW); // re-owns
    operateCoinPusher(MACHINE, OPERATOR, NOW + 100);
    expect(readCoinPusherDoorResult(MACHINE)).toEqual({ kind: 'refused', requestId: 'd-old', atMs: NOW + 100 });
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(chipsInMachine(base));
    expect(readChips(OTHER)).toBe(0);
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

  it('another tab on this device takes over as soon as the lease lapses', () => {
    const device = coinPusherOperatorSession().split(':')[0];
    const otherTab = `${device}:other-tab`;
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: otherTab, expiresAt: NOW + 5_000 });
    tickCoinPusherMachine(MACHINE, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 2_500);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(otherTab);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherMachine(MACHINE, NOW + 5_001);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherMachine(MACHINE, NOW + 7_001);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
  });

  it('another device of the same deed holder waits out the split window before taking over', () => {
    // It may only be cut off from us, still settling drops on its side.
    const otherDevice = 'another-device:tab';
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: otherDevice, expiresAt: NOW + 5_000 });
    tickCoinPusherMachine(MACHINE, NOW + 5_001);
    tickCoinPusherMachine(MACHINE, NOW + 5_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(otherDevice);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherMachine(MACHINE, NOW + 5_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherMachine(MACHINE, NOW + 7_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
  });

  it('honors a lease record for one lease term at most, however far ahead it claims to run', () => {
    // A peer-written lease with a far-future expiry, from someone else…
    writeCoinPusherOperatorLease(MACHINE, { playerId: OTHER, sessionId: 'rogue:tab', expiresAt: Number.MAX_VALUE });
    tickCoinPusherMachine(MACHINE, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 7_999);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe('rogue:tab');
    tickCoinPusherMachine(MACHINE, NOW + 8_000);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('a far-future lease claiming another of our devices holds one term plus the split window', () => {
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: 'rogue:tab2', expiresAt: Number.MAX_VALUE });
    tickCoinPusherMachine(MACHINE, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe('rogue:tab2');
    tickCoinPusherMachine(MACHINE, NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('a lease record seen in another room\'s doc starts afresh here', () => {
    const rogue = { playerId: OTHER, sessionId: 'rogue:tab', expiresAt: Number.MAX_VALUE };
    writeCoinPusherOperatorLease(MACHINE, rogue);
    tickCoinPusherMachine(MACHINE, NOW); // first seen here, in this room
    // Much later, another room whose same-id machine carries the same record.
    bindCasinoDoc(new Y.Doc());
    writeCoinPusherOperatorLease(MACHINE, rogue);
    tickCoinPusherMachine(MACHINE, NOW + 100_000);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe('rogue:tab');
    tickCoinPusherMachine(MACHINE, NOW + 100_000 + 8_000);
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('a lapsed lease of someone else (a previous deed holder) is taken as soon as it lapses', () => {
    writeCoinPusherOperatorLease(MACHINE, { playerId: OTHER, sessionId: 'their-device:tab', expiresAt: NOW + 5_000 });
    tickCoinPusherMachine(MACHINE, NOW + 4_999);
    expect(readCoinPusherOperatorLease(MACHINE)?.playerId).toBe(OTHER);
    tickCoinPusherMachine(MACHINE, NOW + 5_001);
    expect(readCoinPusherOperatorLease(MACHINE)?.playerId).toBe(OPERATOR);
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

  it('pays the deed holder running it, never the owner a peer-written machine names', () => {
    const forged = machineWith(30, ATTACKER);
    writeCoinPusherState(MACHINE, forged);
    closeCoinPusher(MACHINE, true);
    expect(readChips(ATTACKER)).toBe(0);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(forged));
  });

  it('any other client only stops operating', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    closeCoinPusher(MACHINE, false);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('the session operating the machine drains it at once', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', 0.5));
    tickCoinPusherMachine(MACHINE, NOW); // takes the lease
    expect(readCoinPusherOperatorLease(MACHINE)?.sessionId).toBe(coinPusherOperatorSession());
    closeCoinPusher(MACHINE, true, NOW + 10);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readCoinPusherOperatorLease(MACHINE)).toBeNull();
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull(); // a first batch, at once
  });

  it('sweeps a removed cabinet\'s per-player keys a batch per frame', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const map = doc.getMap('casino');
    const flood = 2 * PUSHER_SWEEP_BATCH + 10;
    for (let i = 0; i < flood; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    const left = () => [...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`)).length;
    closeCoinPusher(MACHINE, true, NOW); // no lease: this session drains
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(left()).toBe(flood - PUSHER_SWEEP_BATCH);
    tickCoinPusherTeardowns(NOW + 16);
    expect(left()).toBe(flood - 2 * PUSHER_SWEEP_BATCH);
    tickCoinPusherTeardowns(NOW + 32);
    expect(left()).toBe(0);
  });

  it('stops sweeping when the cabinet is put back', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const map = doc.getMap('casino');
    for (let i = 0; i < 2 * PUSHER_SWEEP_BATCH; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 16); // World ticks it again: it is back
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'fresh', 0.5));
    tickCoinPusherTeardowns(NOW + 32);
    tickCoinPusherTeardowns(NOW + 48);
    expect([...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`))).toHaveLength(PUSHER_SWEEP_BATCH);
    expect(readCoinPusherRequest(MACHINE, PLAYER)?.requestId).toBe('fresh');
  });

  it('another tab leaves the drain to the tab operating the machine, finishing it only if that tab goes away', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherTeardowns(NOW + 4_999);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
    // The operating tab closed without draining; its lease lapses.
    tickCoinPusherTeardowns(NOW + 5_000);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it('another device waits out the split window before draining in the operator\'s place', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: 'another-device:tab', expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherTeardowns(NOW + 5_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherTeardowns(NOW + 5_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it('never races a drop the operating tab is settling: the merged room pays every chip once', () => {
    // Doc A is the operating tab (another session of this deed holder); doc B
    // is this one.
    const base = machineWith(60);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 8_000 });
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', currentPusherPhase(base, NOW - 100)));
    const docA = doc;
    const docB = new Y.Doc();
    sync(docA, docB);
    // A settles the drop, while B, not yet synced, sees the cabinet removed.
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1234);
    const settled = readCoinPusherState(MACHINE)!;
    expect(settled.totalInserted).toBe(base.totalInserted + 1);
    bindCasinoDoc(docB);
    closeCoinPusher(MACHINE, true, NOW);
    expect(readCoinPusherState(MACHINE)).toEqual(base); // left to A
    sync(docA, docB);
    // A sees the removal too and, holding the lease, drains what it settled.
    bindCasinoDoc(docA);
    drainAndClearCoinPusher(MACHINE, OPERATOR);
    sync(docA, docB);
    bindCasinoDoc(docB);
    tickCoinPusherTeardowns(NOW + 100); // the lease is gone: nothing left to pay
    sync(docA, docB);
    for (const d of [docA, docB]) {
      bindCasinoDoc(d);
      expect(readCoinPusherState(MACHINE)).toBeNull();
      expect(readChips(PLAYER)).toBe(3 - 1 + settled.lastDrop!.paid);
      expect(readChips(PLAYER) + readChips(OPERATOR)).toBe(3 + chipsInMachine(base));
    }
  });

  it('a teardown left pending when the room changes never touches the new room\'s doc', () => {
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherState(MACHINE, machineWith(30));
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW); // pending: another tab operates it
    // Join another room whose cabinet happens to share the id, no lease on it.
    const nextRoom = new Y.Doc();
    bindCasinoDoc(nextRoom);
    const theirs = machineWith(12);
    writeCoinPusherState(MACHINE, theirs);
    tickCoinPusherTeardowns(NOW + 10_000);
    expect(readCoinPusherState(MACHINE)).toEqual(theirs);
    expect(readChips(OPERATOR)).toBe(0);
    // Nor is it waiting to: back in the first room, nothing is drained either.
    bindCasinoDoc(doc);
    tickCoinPusherTeardowns(NOW + 10_000);
    expect(readCoinPusherState(MACHINE)).not.toBeNull();
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('a cabinet put back before its teardown ran is left alone', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease(MACHINE, { playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherMachine(MACHINE, NOW + 100); // World ticks it again: it is back
    tickCoinPusherTeardowns(NOW + 6_000);
    expect(readCoinPusherState(MACHINE)?.upper).toEqual(base.upper);
    expect(readChips(OPERATOR)).toBe(0);
  });
});
