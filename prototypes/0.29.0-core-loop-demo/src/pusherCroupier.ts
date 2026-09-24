/**
 * 🪙 Coin-pusher operator (#135) — slotCroupier.ts's auto operator, for the
 * arcade pusher.
 *
 * ELECTION: only the room's deed holder operates (canRunCroupier — the rule
 * every casino operator follows since #141/#142), and only ONE of their
 * browser sessions: a `pusher-operator:<mid>` lease is written, the session
 * waits OPERATOR_LEASE_SETTLE_MS for the doc to converge, then works while it
 * keeps the lease (renewed every OPERATOR_LEASE_RENEW_MS, lapsing after
 * OPERATOR_LEASE_MS). World ticks every cabinet every frame; there is no
 * start/stop control to fight the tick.
 *
 * OWNERSHIP: the operator creates a missing machine with itself as owner and
 * re-owns one whose owner is anyone else (a deed transfer, or a peer-written
 * owner). The chips inside stay where they are and go with the room, like its
 * furniture — nothing is paid out on a takeover, so a forged owner earns
 * nothing.
 *
 * WORK (at most every REQUEST_POLL_MS): the owner's door request first, then
 * every pending insert, oldest first. An insert is refused — no chips move —
 * when it is stale, the player has no chip, or the machine is full. Otherwise
 * resolveDropTiming keeps the phase the player saw (inside the timing
 * window), processInsert runs with a seed the operator draws itself, and
 * casinoDoc.settleCoinPusherInsert debits the chip, credits the payout,
 * publishes the machine and clears the request in one transaction.
 */
import {
  cancelCoinPusherRequest,
  casinoDocEpoch,
  clearCoinPusherEmptyRequest,
  clearCoinPusherOperatorLease,
  commitCoinPusherEmpty,
  drainAndClearCoinPusher,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequests,
  readCoinPusherState,
  refuseCoinPusherInsert,
  settleCoinPusherInsert,
  writeCoinPusherOperatorLease,
  writeCoinPusherState,
} from './casinoDoc';
import { canRunCroupier } from './croupier';
import {
  chipsInMachine,
  emptyMachine,
  initialCoinPusherState,
  MACHINE_MAX_CHIPS,
  processInsert,
  PUSHER_ANTE,
  PUSHER_STALE_REQUEST_MS,
  resolveDropTiming,
} from './games/coinPusher';
import type {
  CoinPusherState,
  PusherInsertRequest,
  PusherRefusalReason,
} from './games/coinPusher';
import { getPlayerId } from './identity';

interface PusherOperatorSession {
  docEpoch: number;
  playerId: string;
  readyAt: number;
  renewedAt: number;
}

const operators = new Map<string, PusherOperatorSession>();
const lastPolls = new Map<string, { docEpoch: number; checkedAt: number }>();
/** Short: a drop's timing window (MAX_DROP_LAG_MS) has to cover this wait. */
const REQUEST_POLL_MS = 100;
const OPERATOR_LEASE_MS = 8_000;
const OPERATOR_LEASE_SETTLE_MS = 2_000;
const OPERATOR_LEASE_RENEW_MS = 3_000;
const operatorSessionId = crypto.randomUUID();

/** A fresh 32-bit peg-field seed from the platform CSPRNG. The operator
 *  draws it when it settles the drop, so the player can neither choose nor
 *  predict it. */
export function randomPusherSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Stop operating `machineId` here, releasing the lease if this session holds it. */
export function stopCoinPusherOperator(machineId: string): void {
  if (!operators.has(machineId)) return;
  operators.delete(machineId);
  lastPolls.delete(machineId);
  if (readCoinPusherOperatorLease(machineId)?.sessionId === operatorSessionId) {
    clearCoinPusherOperatorLease(machineId);
  }
}

/** True while this browser session holds a live operator lease on the machine. */
export function isCoinPusherOperator(machineId: string, now = Date.now()): boolean {
  const lease = readCoinPusherOperatorLease(machineId);
  return operators.get(machineId)?.docEpoch === casinoDocEpoch()
    && lease?.sessionId === operatorSessionId
    && lease.expiresAt > now;
}

/**
 * World calls this for every coin-pusher cabinet every frame. It elects this
 * session (or not), keeps the lease, and runs the operator's work when due.
 */
export function tickCoinPusherMachine(machineId: string, now = Date.now()): void {
  if (!canRunCroupier()) {
    stopCoinPusherOperator(machineId);
    return;
  }
  const playerId = getPlayerId();
  const lease = readCoinPusherOperatorLease(machineId);
  const operator = operators.get(machineId);
  if (!operator
    || operator.docEpoch !== casinoDocEpoch()
    || operator.playerId !== playerId) {
    if (lease && lease.expiresAt > now && lease.sessionId !== operatorSessionId) return;
    writeCoinPusherOperatorLease(machineId, {
      playerId,
      sessionId: operatorSessionId,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operators.set(machineId, {
      docEpoch: casinoDocEpoch(),
      playerId,
      readyAt: now + OPERATOR_LEASE_SETTLE_MS,
      renewedAt: now,
    });
    return;
  }
  if (lease?.playerId !== playerId
    || lease.sessionId !== operatorSessionId
    || lease.expiresAt <= now) {
    operators.delete(machineId);
    return;
  }
  if (now - operator.renewedAt >= OPERATOR_LEASE_RENEW_MS) {
    writeCoinPusherOperatorLease(machineId, {
      playerId,
      sessionId: operatorSessionId,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  if (now < operator.readyAt) return;
  const docEpoch = casinoDocEpoch();
  const lastPoll = lastPolls.get(machineId);
  if (lastPoll?.docEpoch === docEpoch && now - lastPoll.checkedAt < REQUEST_POLL_MS) return;
  lastPolls.set(machineId, { docEpoch, checkedAt: now });
  operateCoinPusher(machineId, playerId, now);
}

/**
 * One pass of the operator's work on a machine: create or re-own it, carry
 * out the owner's door request, then settle every pending insert. Exported
 * for tests (with an injectable seed source); World reaches it only through
 * tickCoinPusherMachine's election.
 */
export function operateCoinPusher(
  machineId: string,
  operatorId: string,
  now: number,
  drawSeed: () => number = randomPusherSeed,
): void {
  let state = readCoinPusherState(machineId);
  if (!state) {
    writeCoinPusherState(machineId, initialCoinPusherState(operatorId, now));
    return;
  }
  if (state.ownerId !== operatorId) {
    writeCoinPusherState(machineId, { ...state, ownerId: operatorId, tick: state.tick + 1 });
    return;
  }

  const door = readCoinPusherEmptyRequest(machineId);
  if (door) {
    if (door.requester === state.ownerId) {
      const emptied = emptyMachine(state, door.requester);
      commitCoinPusherEmpty(machineId, state, emptied.state, door);
    } else {
      clearCoinPusherEmptyRequest(machineId, door.requestId);
    }
    state = readCoinPusherState(machineId);
    if (!state) return;
  }

  for (const request of readCoinPusherRequests(machineId)) {
    state = settleOneInsert(machineId, state, request, now, drawSeed);
    if (!state) return;
  }
}

/** Settle or refuse one request; returns the machine as stored afterwards. */
function settleOneInsert(
  machineId: string,
  state: CoinPusherState,
  request: PusherInsertRequest,
  now: number,
  drawSeed: () => number,
): CoinPusherState | null {
  const refuse = (reason: PusherRefusalReason): CoinPusherState | null => {
    refuseCoinPusherInsert(machineId, state, request, reason, now);
    return readCoinPusherState(machineId);
  };
  if (now - request.requestedAt > PUSHER_STALE_REQUEST_MS) return refuse('expired');
  if (readChips(request.player) < PUSHER_ANTE) return refuse('no-chips');
  if (chipsInMachine(state) + PUSHER_ANTE > MACHINE_MAX_CHIPS) return refuse('machine-full');

  const timing = resolveDropTiming(state, request.phase, now);
  let drop: ReturnType<typeof processInsert>;
  try {
    drop = processInsert(state, request.player, request.hole, timing.dropPhase, drawSeed());
  } catch (err) {
    // Unreachable for a guarded request; never let one poison the queue.
    console.error('[coin-pusher] drop failed; request withdrawn, no chips moved:', err);
    cancelCoinPusherRequest(machineId, request.player, request.requestId);
    return readCoinPusherState(machineId);
  }
  const next: CoinPusherState = {
    ...drop.state,
    lastDrop: {
      requestId: request.requestId,
      player: request.player,
      hole: request.hole,
      chipId: drop.chipId,
      landedX: drop.landedX,
      paid: drop.paid,
      phase: timing.dropPhase,
      honored: timing.honored,
      atMs: now,
    },
  };
  const result = settleCoinPusherInsert(machineId, state, next, request);
  if (result === 'no-chips') return refuse('no-chips');
  if (result === 'invalid') {
    console.error('[coin-pusher] settle rejected the drop; request withdrawn, no chips moved');
    cancelCoinPusherRequest(machineId, request.player, request.requestId);
  }
  return readCoinPusherState(machineId);
}

/**
 * A removed cabinet: stop operating it here and, on a managing client (the
 * closeSlotMachine rule — the deed holder or a room editor), pay the chips
 * still inside to the machine's owner and delete every key it used.
 */
export function closeCoinPusher(machineId: string, canManage = canRunCroupier()): void {
  operators.delete(machineId);
  lastPolls.delete(machineId);
  if (readCoinPusherOperatorLease(machineId)?.sessionId === operatorSessionId) {
    clearCoinPusherOperatorLease(machineId);
  }
  if (!canManage) return;
  drainAndClearCoinPusher(machineId);
}
