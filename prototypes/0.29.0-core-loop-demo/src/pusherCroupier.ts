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
 * CLOCKS: devices' clocks aren't synchronised, so a lease written on another
 * device is never judged by the expiry it claims: it lapses one
 * OPERATOR_LEASE_MS after this page last saw it renewed (leaseLapsesAt). Only
 * a tab on this device, which shares the clock, is also held to its own
 * expiry. Every client watches the renewals (World ticks every cabinet on
 * every client), and the panel asks the same question (isCoinPusherOperatorLive).
 *
 * OWNERSHIP: the operator creates a missing machine with itself as owner and
 * re-owns one whose owner is anyone else (a deed transfer, or a peer-written
 * owner). The chips inside stay where they are and go with the room, like its
 * furniture — nothing is paid out on a takeover, so a forged owner earns
 * nothing.
 *
 * TEARDOWN: a removed cabinet is drained by the same rule. Only a session that
 * may operate the machine (it holds the lease, or could take it over) pays
 * out the chips inside and deletes its keys, so the drain never merges with a
 * settle still in flight on another tab (see closeCoinPusher). The chips and
 * the machine's own keys go in one transaction; its per-player keys, which
 * carry no chips, are swept a batch per frame so a flood of them can't stall
 * one.
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
  continueCoinPusherKeySweep,
  drainAndClearCoinPusher,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequests,
  readCoinPusherState,
  refuseCoinPusherEmpty,
  refuseCoinPusherInsert,
  settleCoinPusherInsert,
  startCoinPusherKeySweep,
  writeCoinPusherOperatorLease,
  writeCoinPusherState,
} from './casinoDoc';
import type { CoinPusherKeySweep, CoinPusherOperatorLease } from './casinoDoc';
import { canRunCroupier } from './croupier';
import {
  chipsInMachine,
  emptyMachine,
  initialCoinPusherState,
  MACHINE_MAX_CHIPS,
  processInsert,
  PUSHER_ANTE,
  PUSHER_STALE_REQUEST_MS,
  RECENT_DROPS_MAX,
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
/** Removed cabinets this session is to clear once no other session may be
 *  operating them (closeCoinPusher), with the doc epoch each was removed in:
 *  one never reads or writes a different room's doc. */
const pendingTeardowns = new Map<string, number>();
/** Drained machines whose per-player keys this session is still deleting, a
 *  batch a frame (tickCoinPusherTeardowns). */
const sweeps = new Map<string, CoinPusherKeySweep>();
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

/** When this page first saw each machine's current lease record in this
 *  room's doc. The operator rewrites its record at every renewal, so this is
 *  when this page last saw the lease renewed. */
const leaseFirstSeen = new Map<string, { id: string; at: number }>();

/** The doc epoch of the room this session is leaving (leaveCoinPusherRoom):
 *  nothing there is operated or watched again, even while its last writes
 *  are being sent. The next room's doc has another epoch. */
let leavingDocEpoch: number | null = null;

function isLeavingRoom(): boolean {
  return leavingDocEpoch === casinoDocEpoch();
}

/**
 * When `lease` lapses as far as this page can tell, without comparing clocks
 * across devices (CLOCKS above): one OPERATOR_LEASE_MS after this page first
 * saw that exact record in this room's doc (what a previous room's doc showed
 * never counts). A tab on this device shares this clock, so its own expiry
 * counts too, though never past that. The record is peer-writable: one
 * claiming a far-future expiry holds a machine for one lease term, not
 * forever.
 */
function leaseLapsesAt(machineId: string, lease: CoinPusherOperatorLease, now: number): number {
  // Scoped to the bound doc: another room's same record starts afresh.
  const id = `${casinoDocEpoch()}|${lease.playerId}|${lease.sessionId}|${lease.expiresAt}`;
  let seen = leaseFirstSeen.get(machineId);
  if (seen?.id !== id) {
    seen = { id, at: now };
    leaseFirstSeen.set(machineId, seen);
  }
  const heldUntil = seen.at + OPERATOR_LEASE_MS;
  return isThisDevice(lease) ? Math.min(lease.expiresAt, heldUntil) : heldUntil;
}

/** Whether a lease was written by a session on this device (its tabs share
 *  the clock and the local node). */
function isThisDevice(lease: CoinPusherOperatorLease): boolean {
  return lease.sessionId.startsWith(`${deviceId}:`);
}

/** Earliest time this session may take `lease` over: when it lapses, plus
 *  the split window for another device of the same deed holder (SPLITS). */
function takeoverAt(
  machineId: string,
  lease: CoinPusherOperatorLease,
  playerId: string,
  now: number,
): number {
  const lapsesAt = leaseLapsesAt(machineId, lease, now);
  return lease.playerId === playerId && !isThisDevice(lease)
    ? lapsesAt + OPERATOR_UNCLEAN_TAKEOVER_MS
    : lapsesAt;
}

/** Whether some session is operating the machine, as far as this page can
 *  tell (the panel's DROP and door): this session by its own live lease, any
 *  other while its lease hasn't lapsed by leaseLapsesAt. */
export function isCoinPusherOperatorLive(machineId: string, now = Date.now()): boolean {
  if (isLeavingRoom()) return false;
  const lease = readCoinPusherOperatorLease(machineId);
  if (!lease) return false;
  if (lease.sessionId === operatorSessionId) return lease.expiresAt > now;
  return now < leaseLapsesAt(machineId, lease, now);
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
  // A room this session is leaving isn't operated again: its released leases
  // stay released while the release is being sent (leaveCoinPusherRoom).
  if (isLeavingRoom()) return;
  // World ticks only cabinets in the room, so one put back before its
  // teardown ran (or finished) is no longer to be torn down.
  pendingTeardowns.delete(machineId);
  sweeps.delete(machineId);
  // Every client watches the lease's renewals, a frame at a time: that is
  // how it tells a live operator from a lapsed one (CLOCKS above).
  const lease = readCoinPusherOperatorLease(machineId);
  if (lease && lease.sessionId !== operatorSessionId) leaseLapsesAt(machineId, lease, now);
  if (!canRunCroupier()) {
    stopCoinPusherOperator(machineId);
    return;
  }
  const playerId = getPlayerId();
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

  const timing = resolveDropTiming(state, request.phase, request.requestedAt, now);
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
    // Every settled drop, for the cabinet: a poll can settle several, and
    // lastDrop keeps only the latest.
    recentDrops: [
      ...(state.recentDrops ?? []),
      { chipId: drop.chipId, hole: request.hole },
    ].slice(-RECENT_DROPS_MAX),
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
 * A removed cabinet. Every client that sees the removal stops operating it
 * here. Its records are cleared (the chips still inside paid to the deed
 * holder, every key deleted) only by a session that may operate the machine
 * by the election's own rule: the one holding its lease, or one that could
 * take the lease over. Every settle happens on the lease holder, so the drain
 * is never merged with a drop another session is still settling, which would
 * bring the machine back and pay its chips twice. A deed-holder session that
 * has to wait keeps the teardown pending, for this room's doc only. The
 * operator normally drains first, and tickCoinPusherTeardowns finishes the job
 * if that session goes away still holding the lease. The recipient is never
 * read from the peer-writable machine.
 */
export function closeCoinPusher(
  machineId: string,
  canManage = canRunCroupier(),
  now = Date.now(),
): void {
  operators.delete(machineId);
  lastPolls.delete(machineId);
  // A room this session is leaving is left to the sessions still in it.
  if (!canManage || isLeavingRoom()) {
    pendingTeardowns.delete(machineId);
    sweeps.delete(machineId);
    leaseFirstSeen.delete(machineId);
    if (readCoinPusherOperatorLease(machineId)?.sessionId === operatorSessionId) {
      clearCoinPusherOperatorLease(machineId);
    }
    return;
  }
  pendingTeardowns.set(machineId, casinoDocEpoch());
  tearDownIfFree(machineId, now);
}

/** Drain a removed cabinet unless another session may still be operating it.
 *  A teardown left over from another room's doc (a room switch since) is
 *  dropped without touching this one. */
function tearDownIfFree(machineId: string, now: number): void {
  if (pendingTeardowns.get(machineId) !== casinoDocEpoch()) {
    pendingTeardowns.delete(machineId);
    leaseFirstSeen.delete(machineId);
    return;
  }
  const playerId = getPlayerId();
  const lease = readCoinPusherOperatorLease(machineId);
  if (lease && lease.sessionId !== operatorSessionId
    && now < takeoverAt(machineId, lease, playerId, now)) return;
  pendingTeardowns.delete(machineId);
  leaseFirstSeen.delete(machineId);
  // The chips and the machine's own keys go in one transaction; its
  // per-player keys (no chips in any) follow a batch per frame.
  drainAndClearCoinPusher(machineId, playerId);
  const sweep = startCoinPusherKeySweep(machineId);
  if (!continueCoinPusherKeySweep(sweep)) sweeps.set(machineId, sweep);
}

/** World calls this every frame. It carries each removed cabinet's key sweep
 *  on by one batch, and finishes the teardowns this session left to another
 *  session that has since gone away still holding the lease. */
export function tickCoinPusherTeardowns(now = Date.now()): void {
  if (pendingTeardowns.size === 0 && sweeps.size === 0) return;
  if (!canRunCroupier()) {
    for (const machineId of pendingTeardowns.keys()) leaseFirstSeen.delete(machineId);
    pendingTeardowns.clear();
    sweeps.clear();
    return;
  }
  for (const [machineId, sweep] of [...sweeps]) {
    if (continueCoinPusherKeySweep(sweep)) sweeps.delete(machineId);
  }
  for (const machineId of [...pendingTeardowns.keys()]) tearDownIfFree(machineId, now);
}

/** Stop operating every machine here, releasing the leases this session
 *  holds, so another tab or device needn't wait them out. */
export function releaseCoinPusherLeases(): void {
  for (const machineId of [...operators.keys()]) stopCoinPusherOperator(machineId);
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the leases this session holds, and operate or watch nothing more
 * in this room, so no frame takes a lease back while the release is being
 * sent. The room's lease observations, pending teardowns and key sweeps go
 * with it. The next room's doc lifts this by its own epoch.
 */
export function leaveCoinPusherRoom(): void {
  leavingDocEpoch = casinoDocEpoch();
  releaseCoinPusherLeases();
  leaseFirstSeen.clear();
  pendingTeardowns.clear();
  sweeps.clear();
}

/** How many machines this session is watching or tidying up (lease
 *  observations, pending teardowns, key sweeps): tests and debugging. */
export function coinPusherWatchCount(): number {
  return leaseFirstSeen.size + pendingTeardowns.size + sweeps.size;
}

// Best effort on page close: the write may not flush. (A page restored from
// the back/forward cache simply takes its leases again.)
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseCoinPusherLeases);
