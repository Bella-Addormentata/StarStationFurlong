/**
 * 🪙 pusherCroupier tests (issue #135): the operator's election, ownership,
 * and one pass of its work — settling, refusing and emptying — against a real
 * Yjs-backed casino map.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  cancelCoinPusherRequest,
  buyInChips,
  clearCoinPusherOperatorLease,
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
  PUSHER_ANTE,
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
  coinPusherOperatorState,
  coinPusherWatchCount,
  isCoinPusherOperator,
  isCoinPusherOperatorLive,
  leaveCoinPusherRoom,
  MAX_REQUESTS_PER_POLL,
  OPERATOR_UNCLEAN_TAKEOVER_MS,
  operateCoinPusher,
  releaseCoinPusherLease,
  tickCoinPusherRoom,
  tickCoinPusherTeardowns,
} from './pusherCroupier';

const OPERATOR = getPlayerId();
const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';
const ATTACKER = 'attacker-Mallory';
const MACHINE = 'pusher-1';
/** Another cabinet in the room, for tests that need an operator already at work. */
const SPARE = 'pusher-spare';
const NOW = 1_000_000;
/** The operator's settling wait (OPERATOR_LEASE_SETTLE_MS). */
const SETTLE_MS = 2_000;

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  setSoleCroupierPredicate(() => true);
});

afterEach(() => {
  setSoleCroupierPredicate(() => true);
  leaveCoinPusherRoom(); // reset this session's operator and watch state
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

/** Take the room's lease at `t` and tick past the settling wait: this session
 *  is then the operator that drains removed cabinets. Returns that time. */
function becomeReadyOperator(machineIds: readonly string[], t = NOW): number {
  tickCoinPusherRoom(machineIds, t);
  tickCoinPusherRoom(machineIds, t + SETTLE_MS);
  return t + SETTLE_MS;
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

  it("plays a request whatever its player's clock says: a clock far behind loses only the timing", () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    buyInChips(PLAYER, 3);
    // The player's clock runs ten minutes behind the operator's.
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'behind', 0.5, NOW - 10 * 60_000));
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const result = readCoinPusherResult(MACHINE, PLAYER);
    expect(result).toMatchObject({ kind: 'drop', honored: false });
    expect(readChips(PLAYER)).toBe(3 - PUSHER_ANTE + (result?.kind === 'drop' ? result.paid : NaN));
  });

  it('refuses a request that has waited longer than PUSHER_STALE_REQUEST_MS since it first saw it', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    // One more request than a poll settles: the last one waits.
    const players = Array.from({ length: MAX_REQUESTS_PER_POLL + 1 }, (_, i) => `player-${i}`);
    for (const [i, player] of players.entries()) {
      buyInChips(player, 3);
      writeCoinPusherRequest(MACHINE, request(player, `r${i}`, 0.5, NOW));
    }
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const waiting = players[players.length - 1];
    expect(readCoinPusherResult(MACHINE, waiting)).toBeNull(); // seen, not reached
    // A newcomer is aged from when it is first seen, not from its own time.
    buyInChips(OTHER, 3);
    writeCoinPusherRequest(MACHINE, request(OTHER, 'r9', 0.5, NOW - 10 * 60_000));
    operateCoinPusher(MACHINE, OPERATOR, NOW + PUSHER_STALE_REQUEST_MS + 1);
    expect(readCoinPusherResult(MACHINE, waiting)).toMatchObject({ kind: 'refused', reason: 'expired' });
    expect(readChips(waiting)).toBe(3);
    expect(readCoinPusherResult(MACHINE, OTHER)).toMatchObject({ kind: 'drop' });
  });

  it('ages a replaced request from its own first sighting, not the one it replaced', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const players = Array.from({ length: MAX_REQUESTS_PER_POLL + 1 }, (_, i) => `player-${i}`);
    for (const [i, player] of players.entries()) {
      buyInChips(player, 3);
      writeCoinPusherRequest(MACHINE, request(player, `r${i}`, 0.5, NOW));
    }
    operateCoinPusher(MACHINE, OPERATOR, NOW);
    const waiting = players[players.length - 1];
    // Its panel withdrew it and asked again, between two polls.
    expect(cancelCoinPusherRequest(MACHINE, waiting, 'r4')).toBe(true);
    expect(writeCoinPusherRequest(MACHINE, request(waiting, 'r5', 0.5, NOW))).toBe(true);
    operateCoinPusher(MACHINE, OPERATOR, NOW + PUSHER_STALE_REQUEST_MS + 1);
    expect(readCoinPusherResult(MACHINE, waiting)).toMatchObject({ kind: 'drop', requestId: 'r5' });
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

describe('tickCoinPusherRoom', () => {
  it('only the deed holder operates', () => {
    setSoleCroupierPredicate(() => false);
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 5_000);
    expect(readCoinPusherOperatorLease()).toBeNull();
    expect(readCoinPusherState(MACHINE)).toBeNull();
  });

  it('takes the lease, waits for it to settle, then works', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    expect(readCoinPusherOperatorLease()?.playerId).toBe(OPERATOR);
    expect(readCoinPusherState(MACHINE)).toBeNull(); // still settling
    tickCoinPusherRoom([MACHINE], NOW + 2_000);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
    expect(isCoinPusherOperator(NOW + 2_000)).toBe(true);
    // Its own lease is judged by its own clock: live until it expires.
    expect(isCoinPusherOperatorLive(NOW + 7_999)).toBe(true);
    expect(isCoinPusherOperatorLive(NOW + 8_000)).toBe(false);
  });

  it('operates every cabinet in the room under one lease, and none while another session holds it', () => {
    // Another tab of this deed holder operates the room. A cabinet it hasn't
    // touched yet isn't this session's to take either: one player's drops on
    // two cabinets are never settled by two sessions, each writing the
    // player's whole balance.
    const device = coinPusherOperatorSession().split(':')[0];
    const otherTab = `${device}:operator-tab`;
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: otherTab, expiresAt: NOW + 5_000 });
    writeCoinPusherState('pusher-2', machineWith(5));
    buyInChips(PLAYER, 2);
    writeCoinPusherRequest('pusher-2', request(PLAYER, 'req-2', 0.5, NOW + 4_000));
    for (const t of [NOW, NOW + 2_500, NOW + 4_999]) tickCoinPusherRoom([MACHINE, 'pusher-2'], t);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(otherTab);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readCoinPusherRequest('pusher-2', PLAYER)?.requestId).toBe('req-2');
    expect(readChips(PLAYER)).toBe(2);
    // Its lease lapses: this session takes the room and works both cabinets.
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW + 5_001);
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW + 7_001);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
    expect(readCoinPusherResult('pusher-2', PLAYER)?.kind).toBe('drop');
    expect(readChips(PLAYER)).toBe(2 - 1 + readCoinPusherState('pusher-2')!.lastDrop!.paid);
  });

  it('settles one player\'s drops on two cabinets in turn, each against the balance the last left', () => {
    buyInChips(PLAYER, 2);
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW);
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW + 2_000); // both machines made
    const at = NOW + 2_100;
    for (const machine of [MACHINE, 'pusher-2']) {
      const s = readCoinPusherState(machine)!;
      writeCoinPusherRequest(machine, request(PLAYER, `req-${machine}`, currentPusherPhase(s, at), at));
    }
    tickCoinPusherRoom([MACHINE, 'pusher-2'], at + 100);
    const paid = [MACHINE, 'pusher-2'].map((machine) => readCoinPusherState(machine)!.lastDrop!.paid);
    expect(readChips(PLAYER)).toBe(2 - 2 + paid[0] + paid[1]);
  });

  it('reads a lease naming this session as offline in a room it isn\'t operating yet', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 2_000);
    expect(coinPusherOperatorState(NOW + 2_000)).toBe('ready');
    // Another room's doc, with a record naming this session left in it.
    bindCasinoDoc(new Y.Doc());
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: coinPusherOperatorSession(), expiresAt: NOW + 8_000 });
    expect(coinPusherOperatorState(NOW + 2_001)).toBe('offline');
    tickCoinPusherRoom([MACHINE], NOW + 2_016); // takes it here, settling wait and all
    expect(coinPusherOperatorState(NOW + 2_016)).toBe('starting');
  });

  it('keeps the room\'s lease while a cabinet remains, and lets it go once none is left', () => {
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 3_000); // pusher-2 removed
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    expect(readCoinPusherOperatorLease()?.expiresAt).toBe(NOW + 3_000 + 8_000); // renewed
    tickCoinPusherRoom([], NOW + 3_016); // and the last one
    expect(readCoinPusherOperatorLease()).toBeNull();
    expect(isCoinPusherOperator(NOW + 3_016)).toBe(false);
  });

  it('shows its own machine starting up until its settling wait is over', () => {
    // A record naming this session while it operates nothing (a leftover, or
    // forged) has no one at work behind it.
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: coinPusherOperatorSession(), expiresAt: NOW + 8_000 });
    expect(coinPusherOperatorState(NOW)).toBe('offline');
    tickCoinPusherRoom([MACHINE], NOW);
    expect(coinPusherOperatorState(NOW + 1_999)).toBe('starting');
    expect(coinPusherOperatorState(NOW + 2_000)).toBe('ready');
  });

  it('tells a player the operator is starting up until its settling wait is over', () => {
    setSoleCroupierPredicate(() => false); // a player at the cabinet
    const lease = (t: number, sessionId = 'their-device:tab') =>
      writeCoinPusherOperatorLease({ playerId: OTHER, sessionId, expiresAt: t + 8_000 });
    lease(NOW);
    tickCoinPusherRoom([MACHINE], NOW); // first seen held now
    // A drop made now would reach an operator that doesn't work yet.
    expect(coinPusherOperatorState(NOW + 1_999)).toBe('starting');
    expect(coinPusherOperatorState(NOW + 2_000)).toBe('ready');
    // A renewal is the same holder: still ready.
    lease(NOW + 3_000);
    tickCoinPusherRoom([MACHINE], NOW + 3_000);
    expect(coinPusherOperatorState(NOW + 3_001)).toBe('ready');
    // Another session taking over starts its own wait.
    lease(NOW + 4_000, 'their-other-device:tab');
    tickCoinPusherRoom([MACHINE], NOW + 4_000);
    expect(coinPusherOperatorState(NOW + 5_999)).toBe('starting');
    expect(coinPusherOperatorState(NOW + 6_000)).toBe('ready');
    // So does the same session taking it again after letting it go.
    clearCoinPusherOperatorLease();
    tickCoinPusherRoom([MACHINE], NOW + 7_000);
    expect(coinPusherOperatorState(NOW + 7_000)).toBe('offline');
    lease(NOW + 7_500, 'their-other-device:tab');
    tickCoinPusherRoom([MACHINE], NOW + 7_500);
    expect(coinPusherOperatorState(NOW + 9_499)).toBe('starting');
    expect(coinPusherOperatorState(NOW + 9_500)).toBe('ready');
  });

  it('reads a new tenure as a new take, even when it never saw the lease go', () => {
    setSoleCroupierPredicate(() => false); // a player at the cabinet
    const lease = (t: number, tenure: string) => writeCoinPusherOperatorLease({
      playerId: OTHER, sessionId: 'their-device:tab', tenure, expiresAt: t + 8_000,
    });
    lease(NOW, 'first');
    tickCoinPusherRoom([MACHINE], NOW);
    expect(coinPusherOperatorState(NOW + 2_000)).toBe('ready');
    lease(NOW + 3_000, 'first'); // a renewal
    tickCoinPusherRoom([MACHINE], NOW + 3_000);
    expect(coinPusherOperatorState(NOW + 3_001)).toBe('ready');
    // The holder let the lease go and took it again between two of this
    // page's frames: a new take, with a settling wait of its own.
    lease(NOW + 4_000, 'second');
    tickCoinPusherRoom([MACHINE], NOW + 4_000);
    expect(coinPusherOperatorState(NOW + 5_999)).toBe('starting');
    expect(coinPusherOperatorState(NOW + 6_000)).toBe('ready');
  });

  it('writes a fresh tenure each time it takes the lease, and keeps it when renewing', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    const first = readCoinPusherOperatorLease()?.tenure;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    tickCoinPusherRoom([MACHINE], NOW + 3_000); // a renewal
    expect(readCoinPusherOperatorLease()?.expiresAt).toBe(NOW + 3_000 + 8_000);
    expect(readCoinPusherOperatorLease()?.tenure).toBe(first);
    tickCoinPusherRoom([], NOW + 3_016); // lets it go…
    tickCoinPusherRoom([MACHINE], NOW + 3_032); // …and takes it again
    const second = readCoinPusherOperatorLease()?.tenure;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it('another tab on this device takes over as soon as the lease lapses', () => {
    const device = coinPusherOperatorSession().split(':')[0];
    const otherTab = `${device}:other-tab`;
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: otherTab, expiresAt: NOW + 5_000 });
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 2_500);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(otherTab);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherRoom([MACHINE], NOW + 5_001);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherRoom([MACHINE], NOW + 7_001);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
  });

  it('another device of the same deed holder waits out the split window before taking over', () => {
    // It may only be cut off from us, still settling drops on its side. Its
    // clock isn't ours: its lease runs one term from when this page saw it.
    const otherDevice = 'another-device:tab';
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: otherDevice, expiresAt: NOW + 5_000 });
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(otherDevice);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherRoom([MACHINE], NOW + 10_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherState(MACHINE)?.ownerId).toBe(OPERATOR);
  });

  it('judges another device\'s lease by the renewals it sees, never by that device\'s clock', () => {
    // Our other device's clock runs 100 s slow: each lease it writes has
    // already expired by ours, yet it is live, renewing every 3 s.
    const otherDevice = 'another-device:tab';
    let t = NOW;
    for (; t < NOW + 2 * OPERATOR_UNCLEAN_TAKEOVER_MS; t += 3_000) {
      writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: otherDevice, expiresAt: t - 100_000 + 8_000 });
      tickCoinPusherRoom([MACHINE], t);
      expect(readCoinPusherOperatorLease()?.sessionId).toBe(otherDevice);
    }
    // It stops renewing: taken a term and the split window after the last.
    const last = t - 3_000;
    tickCoinPusherRoom([MACHINE], last + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(otherDevice);
    tickCoinPusherRoom([MACHINE], last + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('tells a player a live operator from a lapsed one without comparing clocks', () => {
    setSoleCroupierPredicate(() => false); // a player at the cabinet, not the deed holder
    // The operator's clock runs 10 s behind this player's: by the player's
    // clock, every lease it writes has already expired.
    for (let t = NOW; t <= NOW + 30_000; t += 3_000) {
      writeCoinPusherOperatorLease({ playerId: OTHER, sessionId: 'their-device:tab', expiresAt: t - 10_000 + 8_000 });
      tickCoinPusherRoom([MACHINE], t); // World ticks every cabinet on every client
      expect(isCoinPusherOperatorLive(t + 2_999)).toBe(true);
    }
    // No renewal after NOW + 30 s: offline one lease term later.
    expect(isCoinPusherOperatorLive(NOW + 30_000 + 7_999)).toBe(true);
    expect(isCoinPusherOperatorLive(NOW + 30_000 + 8_000)).toBe(false);
  });

  it('honors a lease record for one lease term at most, however far ahead it claims to run', () => {
    // A peer-written lease with a far-future expiry, claiming this device…
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease({ playerId: OTHER, sessionId: `${device}:rogue-tab`, expiresAt: Number.MAX_VALUE });
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 7_999);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(`${device}:rogue-tab`);
    tickCoinPusherRoom([MACHINE], NOW + 8_000);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('a far-future lease claiming another of our devices holds one term plus the split window', () => {
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: 'rogue:tab2', expiresAt: Number.MAX_VALUE });
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe('rogue:tab2');
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('a lease record seen in another room\'s doc starts afresh here', () => {
    const rogue = { playerId: OTHER, sessionId: 'rogue:tab', expiresAt: Number.MAX_VALUE };
    writeCoinPusherOperatorLease(rogue);
    tickCoinPusherRoom([MACHINE], NOW); // first seen here, in this room
    // Much later, another room whose same-id machine carries the same record.
    bindCasinoDoc(new Y.Doc());
    writeCoinPusherOperatorLease(rogue);
    tickCoinPusherRoom([MACHINE], NOW + 100_000);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe('rogue:tab');
    tickCoinPusherRoom([MACHINE], NOW + 100_000 + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe('rogue:tab');
    tickCoinPusherRoom([MACHINE], NOW + 100_000 + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('treats another device\'s lease as the deed holder\'s own, whatever player id it names', () => {
    // An install that restored the deed holder's identity key has a player
    // id of its own, and it may only be cut off from us.
    writeCoinPusherOperatorLease({ playerId: OTHER, sessionId: 'their-device:tab', expiresAt: NOW + 5_000 });
    tickCoinPusherRoom([MACHINE], NOW);
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS - 1);
    expect(readCoinPusherOperatorLease()?.playerId).toBe(OTHER);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    tickCoinPusherRoom([MACHINE], NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS);
    expect(readCoinPusherOperatorLease()?.playerId).toBe(OPERATOR);
  });

  it('releases the room\'s lease and stops operating every cabinet (leaving the page)', () => {
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW);
    tickCoinPusherRoom([MACHINE, 'pusher-2'], NOW + 2_000);
    expect(readCoinPusherState('pusher-2')?.ownerId).toBe(OPERATOR);
    releaseCoinPusherLease();
    expect(readCoinPusherOperatorLease()).toBeNull();
    expect(isCoinPusherOperator(NOW + 2_001)).toBe(false);
    expect(isCoinPusherOperatorLive(NOW + 2_001)).toBe(false);
  });

  it('clears its own lapsed lease at once, so a page leaving before the next frame leaves none behind', () => {
    tickCoinPusherRoom([MACHINE], NOW); // expires at NOW + 8_000
    // No frames for a while (a background tab), then one past the expiry.
    tickCoinPusherRoom([MACHINE], NOW + 9_000);
    expect(readCoinPusherOperatorLease()).toBeNull();
    // Leaving now has nothing left to release, and leaves nothing behind.
    releaseCoinPusherLease();
    expect(readCoinPusherOperatorLease()).toBeNull();
    // Staying, the next frame takes the lease afresh, settling wait and all.
    tickCoinPusherRoom([MACHINE], NOW + 9_016);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    expect(coinPusherOperatorState(NOW + 9_016)).toBe('starting');
  });

  it('leaves a lease another session took over alone when it stops operating', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    const theirs = { playerId: OPERATOR, sessionId: 'our-other-device:tab', expiresAt: NOW + 10_000 };
    writeCoinPusherOperatorLease(theirs); // their write won the merge
    tickCoinPusherRoom([MACHINE], NOW + 16);
    expect(isCoinPusherOperator(NOW + 16)).toBe(false);
    expect(readCoinPusherOperatorLease()).toEqual(theirs);
  });

  it('leaving the room releases its leases and takes none back while the release is sent', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    leaveCoinPusherRoom();
    // Frames go on while the release is flushed, and with no sync the
    // croupier predicate still reads true.
    for (const t of [NOW + 16, NOW + 3_000, NOW + 9_000]) tickCoinPusherRoom([MACHINE], t);
    expect(readCoinPusherOperatorLease()).toBeNull();
    expect(isCoinPusherOperator(NOW + 9_000)).toBe(false);
    expect(isCoinPusherOperatorLive(NOW + 9_000)).toBe(false);
    // The next room's doc lifts it.
    bindCasinoDoc(new Y.Doc());
    tickCoinPusherRoom([MACHINE], NOW + 10_000);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
  });

  it('leaving the room forgets its lease observation, request sightings, teardowns and sweeps', () => {
    // A removed cabinet whose keys are still being swept (drained by this
    // session as the room's operator, which then lets the lease go)…
    writeCoinPusherState('pusher-3', machineWith(5));
    const map = doc.getMap('casino');
    for (let i = 0; i < 2 * PUSHER_SWEEP_BATCH; i++) map.set(`pusher-result:pusher-3:p${i}`, 'junk');
    const ready = becomeReadyOperator([SPARE], NOW - SETTLE_MS);
    closeCoinPusher('pusher-3', true, ready);
    releaseCoinPusherLease();
    // …a request this session has seen…
    writeCoinPusherState('pusher-5', machineWith(5));
    writeCoinPusherRequest('pusher-5', request(PLAYER, 'seen', 0.5));
    operateCoinPusher('pusher-5', OPERATOR, NOW); // no chips: refused, but seen
    // …then a remote operator's lease, watched, and another removed cabinet
    // left to it.
    writeCoinPusherOperatorLease({ playerId: OTHER, sessionId: 'their-device:tab', expiresAt: NOW + 5_000 });
    tickCoinPusherRoom([MACHINE], NOW);
    writeCoinPusherState('pusher-4', machineWith(2));
    closeCoinPusher('pusher-4', true, NOW);
    expect(coinPusherWatchCount()).toBe(4);
    leaveCoinPusherRoom();
    expect(coinPusherWatchCount()).toBe(0);
    // Nor is anything watched there again: the remote lease reads as no
    // operator at all, and isn't recorded.
    expect(isCoinPusherOperatorLive(NOW + 1)).toBe(false);
    tickCoinPusherRoom([MACHINE], NOW + 16);
    expect(coinPusherWatchCount()).toBe(0);
    tickCoinPusherTeardowns();
    expect([...map.keys()].filter((k) => k.startsWith('pusher-result:pusher-3:'))).toHaveLength(PUSHER_SWEEP_BATCH);
    expect(readCoinPusherState('pusher-4')).not.toBeNull();
  });

  it('stops and releases the lease when this client is no longer the deed holder', () => {
    tickCoinPusherRoom([MACHINE], NOW);
    expect(readCoinPusherOperatorLease()).not.toBeNull();
    setSoleCroupierPredicate(() => false);
    tickCoinPusherRoom([MACHINE], NOW + 100);
    expect(readCoinPusherOperatorLease()).toBeNull();
  });
});

// ── Removal ──────────────────────────────────────────────────────────────────

describe('closeCoinPusher', () => {
  it('the operator pays the chips inside to the deed holder and clears the machine', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const ready = becomeReadyOperator([SPARE]);
    closeCoinPusher(MACHINE, true, ready + 10);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
  });

  it('pays the deed holder running it, never the owner a peer-written machine names', () => {
    const forged = machineWith(30, ATTACKER);
    writeCoinPusherState(MACHINE, forged);
    const ready = becomeReadyOperator([SPARE]);
    closeCoinPusher(MACHINE, true, ready + 10);
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

  it('the operator past its settling wait drains a removed cabinet at once', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const ready = becomeReadyOperator([MACHINE]);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', 0.5));
    closeCoinPusher(MACHINE, true, ready + 10);
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull(); // a first batch, at once
    // The room's lease is for every cabinet: it goes once none is left.
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherRoom([], ready + 26);
    expect(readCoinPusherOperatorLease()).toBeNull();
  });

  it('an operator still in its settling wait keeps the teardown pending, and drains once past it', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    tickCoinPusherRoom([MACHINE], NOW); // takes the lease: settling until NOW + 2 s
    closeCoinPusher(MACHINE, true, NOW + 10);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherRoom([], NOW + SETTLE_MS - 1);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession()); // kept for it
    tickCoinPusherRoom([], NOW + SETTLE_MS);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
    tickCoinPusherRoom([], NOW + SETTLE_MS + 16);
    expect(readCoinPusherOperatorLease()).toBeNull();
  });

  it('with no lease, the teardown takes it and drains only past the settling wait', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    closeCoinPusher(MACHINE, true, NOW); // nobody holds the lease
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherRoom([], NOW + 16); // no cabinet left, but a teardown: the lease is taken
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    tickCoinPusherRoom([], NOW + 16 + SETTLE_MS - 1);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherRoom([], NOW + 16 + SETTLE_MS);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it("a previous holder's last settle lands before the drain: the merged room pays every chip once", () => {
    // Doc A is the previous holder, settling one last drop; doc B is this
    // session, which sees the cabinet removed with no lease in its doc yet.
    const base = machineWith(60);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1', currentPusherPhase(base, NOW - 100)));
    const docA = doc;
    const docB = new Y.Doc();
    sync(docA, docB);
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 1234);
    const settled = readCoinPusherState(MACHINE)!;
    expect(settled.totalInserted).toBe(base.totalInserted + 1);
    bindCasinoDoc(docB);
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherRoom([], NOW + 16); // takes the lease, and waits
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    sync(docA, docB); // A's settle arrives during the wait
    tickCoinPusherRoom([], NOW + 16 + SETTLE_MS); // drains what A settled
    sync(docA, docB);
    for (const d of [docA, docB]) {
      bindCasinoDoc(d);
      expect(readCoinPusherState(MACHINE)).toBeNull();
      expect(readChips(PLAYER)).toBe(3 - 1 + settled.lastDrop!.paid);
      expect(readChips(PLAYER) + readChips(OPERATOR)).toBe(3 + chipsInMachine(base));
    }
  });

  it('sweeps a removed cabinet\'s per-player keys a batch per frame', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const map = doc.getMap('casino');
    const flood = 2 * PUSHER_SWEEP_BATCH + 10;
    for (let i = 0; i < flood; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    const left = () => [...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`)).length;
    const ready = becomeReadyOperator([SPARE]);
    closeCoinPusher(MACHINE, true, ready);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(left()).toBe(flood - PUSHER_SWEEP_BATCH);
    tickCoinPusherTeardowns();
    expect(left()).toBe(flood - 2 * PUSHER_SWEEP_BATCH);
    tickCoinPusherTeardowns();
    expect(left()).toBe(0);
  });

  it('stops sweeping when the cabinet is put back', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const map = doc.getMap('casino');
    for (let i = 0; i < 2 * PUSHER_SWEEP_BATCH; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    const ready = becomeReadyOperator([SPARE]);
    closeCoinPusher(MACHINE, true, ready);
    tickCoinPusherRoom([SPARE, MACHINE], ready + 16); // World ticks it again: it is back
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'fresh', 0.5));
    tickCoinPusherTeardowns();
    tickCoinPusherTeardowns();
    expect([...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`))).toHaveLength(PUSHER_SWEEP_BATCH);
    expect(readCoinPusherRequest(MACHINE, PLAYER)?.requestId).toBe('fresh');
  });

  it('gives its sweeps up once it may no longer manage the room', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    const map = doc.getMap('casino');
    for (let i = 0; i < 2 * PUSHER_SWEEP_BATCH; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    const ready = becomeReadyOperator([SPARE]);
    closeCoinPusher(MACHINE, true, ready);
    setSoleCroupierPredicate(() => false);
    tickCoinPusherTeardowns();
    expect([...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`))).toHaveLength(PUSHER_SWEEP_BATCH);
  });

  it('another tab leaves the drain to the tab operating the machine, finishing it only if that tab goes away', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherRoom([], NOW + 4_999);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
    // The operating tab closed without draining; its lease lapses. This tab
    // takes it over, and drains once past its own settling wait.
    tickCoinPusherRoom([], NOW + 5_000);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(coinPusherOperatorSession());
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherRoom([], NOW + 5_000 + SETTLE_MS);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it('another device waits out the split window before draining in the operator\'s place', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: 'another-device:tab', expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherRoom([], NOW); // first seen now: its lease runs a term from here
    const takeover = NOW + 8_000 + OPERATOR_UNCLEAN_TAKEOVER_MS;
    tickCoinPusherRoom([], takeover - 1);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe('another-device:tab');
    tickCoinPusherRoom([], takeover); // taken over, then the settling wait
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    tickCoinPusherRoom([], takeover + SETTLE_MS);
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readChips(OPERATOR)).toBe(chipsInMachine(base));
  });

  it('never races a drop the operating tab is settling: the merged room pays every chip once', () => {
    // Doc A is the operating tab (another session of this deed holder); doc B
    // is this one.
    const base = machineWith(60);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 8_000 });
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
    tickCoinPusherRoom([], NOW + 16);
    expect(readCoinPusherState(MACHINE)).toEqual(base); // left to A
    sync(docA, docB);
    // A sees the removal too and, holding the lease, drains what it settled.
    bindCasinoDoc(docA);
    drainAndClearCoinPusher(MACHINE, OPERATOR);
    sync(docA, docB);
    bindCasinoDoc(docB);
    tickCoinPusherTeardowns();
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
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW); // pending: another tab operates it
    // Join another room whose cabinet happens to share the id, no lease on it.
    const nextRoom = new Y.Doc();
    bindCasinoDoc(nextRoom);
    const theirs = machineWith(12);
    writeCoinPusherState(MACHINE, theirs);
    tickCoinPusherRoom([], NOW + 10_000);
    expect(readCoinPusherOperatorLease()).toBeNull(); // nothing of this room's to tear down
    // Another cabinet there: this session operates the room, and drains none of it.
    becomeReadyOperator([SPARE], NOW + 10_016);
    expect(readCoinPusherState(MACHINE)).toEqual(theirs);
    expect(readChips(OPERATOR)).toBe(0);
    // Nor is it waiting to: back in the first room, nothing is drained either.
    releaseCoinPusherLease();
    bindCasinoDoc(doc);
    tickCoinPusherRoom([], NOW + 20_000);
    tickCoinPusherRoom([], NOW + 20_000 + SETTLE_MS);
    tickCoinPusherTeardowns();
    expect(readCoinPusherState(MACHINE)).not.toBeNull();
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('forgets a teardown left pending in another room', () => {
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherState(MACHINE, machineWith(30));
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW); // pending: another tab operates it
    bindCasinoDoc(new Y.Doc());
    tickCoinPusherTeardowns();
    expect(coinPusherWatchCount()).toBe(0);
  });

  it('a session whose lease was just taken over leaves the drain to the new holder', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const ready = becomeReadyOperator([MACHINE]);
    // Another session takes the room over before this one's next frame.
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: 'another-device:tab', expiresAt: ready + 8_000 });
    closeCoinPusher(MACHINE, true, ready + 10);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('a cabinet removed while this session leaves the room is left to the sessions still in it', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    leaveCoinPusherRoom();
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherRoom([], NOW + 16);
    tickCoinPusherRoom([], NOW + 16 + SETTLE_MS);
    tickCoinPusherTeardowns();
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(0);
  });

  it('a cabinet put back before its teardown ran is left alone', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    const device = coinPusherOperatorSession().split(':')[0];
    writeCoinPusherOperatorLease({ playerId: OPERATOR, sessionId: `${device}:operator-tab`, expiresAt: NOW + 5_000 });
    closeCoinPusher(MACHINE, true, NOW);
    tickCoinPusherRoom([MACHINE], NOW + 100); // World ticks it again: it is back
    tickCoinPusherTeardowns();
    tickCoinPusherRoom([MACHINE], NOW + 6_000); // the lapsed lease is taken over…
    tickCoinPusherRoom([MACHINE], NOW + 6_000 + SETTLE_MS); // …and the cabinet operated, not drained
    expect(readCoinPusherState(MACHINE)?.upper).toEqual(base.upper);
    expect(readChips(OPERATOR)).toBe(0);
  });
});
