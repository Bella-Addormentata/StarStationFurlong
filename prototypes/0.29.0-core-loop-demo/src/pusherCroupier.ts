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
 * SPLITS: a Y.Map lease is not a mutex. Two sessions cut off from each other
 * could each take it and settle drops from the same machine; when the docs
 * merge only one machine value survives while both players' balance writes
 * do. Settling can't be made partition-safe without an authoritative ledger
 * (the Registry-anchored chips), so the rule here keeps a second operator from
 * ever starting while the first may only be cut off: a session of the SAME
 * deed holder on ANOTHER device may take over a lapsed lease only after
 * OPERATOR_UNCLEAN_TAKEOVER_MS more. Tabs on one device share its local node,
 * so they take over as soon as the lease lapses (a reload, a closed tab); a
 * session that stops operating releases its lease so a successor needn't
 * wait. Only a split outlasting that window can still put two operators on
 * one machine.
 *
 * OWNERSHIP: the operator creates a missing machine with itself as owner and
 * re-owns one whose owner is anyone else (a deed transfer, or a peer-written
 * owner). The chips inside stay where they are and go with the room, like its
 * furniture — nothing is paid out on a takeover, so a forged owner earns
 * nothing.
 *
 * WORK (at most every REQUEST_POLL_MS): the owner's door request first
 * (carried out, or answered with a refusal when its requester doesn't own the
 * machine), then the MAX_REQUESTS_PER_POLL oldest inserts. The requests come
 * from casinoDoc's per-machine index, which looks at no more than
 * PUSHER_REQUEST_SCAN of them, so a poll costs the same however many keys
 * peers write (the slot operator likewise takes one head request per poll).
 * An insert is refused — no chips move — when it is stale, the player has no
 * chip, or the machine is full. Otherwise
 * resolveDropTiming keeps the phase the player saw (inside the timing
 * window), processInsert runs with a seed the operator draws itself, and
 * casinoDoc.settleCoinPusherInsert debits the chip, credits the payout,
 * publishes the machine, answers the player and clears the request in one
 * transaction.
 */
import {
  cancelCoinPusherRequest,
  casinoDocEpoch,
  clearCoinPusherOperatorLease,
  commitCoinPusherEmpty,
  drainAndClearCoinPusher,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequests,
  readCoinPusherState,
  refuseCoinPusherEmpty,
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
/** Inserts settled or refused per poll (≤ 40 a second per machine). */
export const MAX_REQUESTS_PER_POLL = 4;
const OPERATOR_LEASE_MS = 8_000;
const OPERATOR_LEASE_SETTLE_MS = 2_000;
const OPERATOR_LEASE_RENEW_MS = 3_000;
/** How much longer than a lapse another device of the same deed holder waits
 *  before taking over (see SPLITS above). */
export const OPERATOR_UNCLEAN_TAKEOVER_MS = 60_000;
const DEVICE_KEY = 'ssf-pusher-operator-device';

/** One id per browser profile (localStorage), shared by its tabs. */
function loadDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
    const fresh = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // private mode: this page is its own device
  }
}

const deviceId = loadDeviceId();
/** `<device>:<page load>` — the lease record's sessionId. */
const operatorSessionId = `${deviceId}:${crypto.randomUUID()}`;

/** This page's operator session id (`<device>:<page load>`). */
export function coinPusherOperatorSession(): string {
  return operatorSessionId;
}

/** When this page first saw each machine's current lease record. */
const leaseFirstSeen = new Map<string, { id: string; at: number }>();

/**
 * Earliest time this session may take `lease` over. The record is
 * peer-writable, so its `expiresAt` is honored for at most OPERATOR_LEASE_MS
 * after this page first saw that exact record — what a live operator's lease
 * is worth anyway, since it rewrites it every OPERATOR_LEASE_RENEW_MS. A
 * record written with a far-future expiry can therefore hold a machine for
 * one lease term, not forever.
 */
function takeoverAt(
  machineId: string,
  lease: { playerId: string; sessionId: string; expiresAt: number },
  playerId: string,
  now: number,
): number {
  const id = `${lease.playerId}|${lease.sessionId}|${lease.expiresAt}`;
  let seen = leaseFirstSeen.get(machineId);
  if (seen?.id !== id) {
    seen = { id, at: now };
    leaseFirstSeen.set(machineId, seen);
  }
  const expiresAt = Math.min(lease.expiresAt, seen.at + OPERATOR_LEASE_MS);
  const sameDevice = lease.sessionId.startsWith(`${deviceId}:`);
  return lease.playerId === playerId && !sameDevice
    ? expiresAt + OPERATOR_UNCLEAN_TAKEOVER_MS
    : expiresAt;
}

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
    if (lease && lease.sessionId !== operatorSessionId
      && now < takeoverAt(machineId, lease, playerId, now)) return;
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
 * One pass of the operator's work on a machine: create or re-own it, answer
 * the door request, then settle or refuse a bounded batch of pending inserts.
 * Exported for tests (with an injectable seed source); World reaches it only
 * through tickCoinPusherMachine's election.
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
      commitCoinPusherEmpty(machineId, state, emptied.state, door, operatorId, now);
    } else {
      refuseCoinPusherEmpty(machineId, door, now);
    }
    state = readCoinPusherState(machineId);
    if (!state) return;
  }

  for (const request of readCoinPusherRequests(machineId, MAX_REQUESTS_PER_POLL)) {
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
    refuseCoinPusherInsert(machineId, request, reason, now);
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
 * A removed cabinet: stop operating it here and, on the deed holder's client,
 * pay the chips still inside to the deed holder (the machine's owner — the
 * operator re-owns every machine it runs) and delete every key it used. Other
 * clients only stop; the recipient is never read from the peer-writable
 * machine.
 */
export function closeCoinPusher(machineId: string, canManage = canRunCroupier()): void {
  operators.delete(machineId);
  lastPolls.delete(machineId);
  leaseFirstSeen.delete(machineId);
  if (readCoinPusherOperatorLease(machineId)?.sessionId === operatorSessionId) {
    clearCoinPusherOperatorLease(machineId);
  }
  if (!canManage) return;
  drainAndClearCoinPusher(machineId, getPlayerId());
}

// Leaving the page releases every lease this session holds, so another tab
// or device needn't wait out the lapse (best effort: the write may not flush).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const machineId of [...operators.keys()]) stopCoinPusherOperator(machineId);
  });
}
