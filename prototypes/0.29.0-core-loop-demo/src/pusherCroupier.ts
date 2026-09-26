/**
 * 🪙 Coin-pusher operator (#135) — slotCroupier.ts's auto operator, for the
 * arcade pusher.
 *
 * ELECTION: only the room's deed holder operates (canRunCroupier — the rule
 * every casino operator follows since #141/#142), and only ONE of their
 * browser sessions, for every coin pusher in the room: one `pusher-operator`
 * lease is written for the room, the session waits OPERATOR_LEASE_SETTLE_MS
 * for the doc to converge, then works while it keeps the lease (renewed every
 * OPERATOR_LEASE_RENEW_MS, lapsing after OPERATOR_LEASE_MS). One operator for
 * the room, not one per cabinet: a player's `bal:` is a whole value, so two
 * sessions settling that player's drops on two cabinets at once would each
 * write it, and the merge would keep only one of the two writes. World ticks
 * the room every frame (tickCoinPusherRoom); there is no start/stop control to
 * fight the tick, and a session whose room has no cabinet left lets the lease
 * go.
 *
 * SPLITS: a Y.Map lease is not a mutex. Two sessions cut off from each other
 * could each take it and settle drops; when the docs merge only one machine
 * value survives while both players' balance writes do (or one balance write
 * survives where both debited it). Settling can't be made partition-safe
 * without an authoritative ledger (the Registry-anchored chips), so the rule
 * here keeps a second operator from ever starting while the first may only be
 * cut off: a session on ANOTHER device may take over a lapsed lease only after
 * OPERATOR_UNCLEAN_TAKEOVER_MS more. (Only the deed holder operates, so
 * another device's lease is the deed holder's own, whatever player id it
 * names: an install that restored their identity key has its own.) Tabs on one
 * device share its local node, so they take over as soon as the lease lapses
 * (a reload, a closed tab); a session that stops operating releases its lease
 * so a successor needn't wait. Only a split outlasting that window can still
 * put two operators in one room.
 *
 * CLOCKS: devices' clocks aren't synchronised, so a lease written on another
 * device is never judged by the expiry it claims: it lapses one
 * OPERATOR_LEASE_MS after this page last saw it renewed (leaseLapsesAt). Only
 * a tab on this device, which shares the clock, is also held to its own
 * expiry. Every client watches the renewals (World ticks the room on every
 * client), and the panel asks the same question: its DROP waits until the
 * operator is past its settling wait (coinPusherOperatorState). A request is
 * aged the same way, from when the operator first saw it; its `requestedAt`,
 * the player's clock, decides only whether the drop's timing is kept.
 *
 * OWNERSHIP: the operator creates a missing machine with itself as owner and
 * re-owns one whose owner is anyone else (a deed transfer, a peer-written
 * owner, or another install of the deed holder, which has a player id of its
 * own). The chips inside stay where they are and go with the room, like its
 * furniture — nothing is paid out on a takeover, so a forged owner earns
 * nothing. The owner is therefore the install operating the room, and only
 * its panel offers the door.
 *
 * TEARDOWN: a removed cabinet is drained by the same rule. Only a session that
 * may operate the room (it holds the lease, or could take it over) pays out
 * the chips inside and deletes its keys, so the drain never merges with a
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
  /** This turn's token in the lease record, fresh for every take and kept
   *  across its renewals (CoinPusherOperatorLease.tenure). */
  tenure: string;
  readyAt: number;
  renewedAt: number;
}

/** This session's turn as the room's operator, if it has one. */
let operator: PusherOperatorSession | null = null;
const lastPolls = new Map<string, { docEpoch: number; checkedAt: number }>();
/** When this session first saw each machine's pending requests (player →
 *  request id and time), in the room of `docEpoch`. A request's age is
 *  measured on this page's clock from that sighting, never from its
 *  `requestedAt`, which is the player's clock (CLOCKS). */
const requestsSeen = new Map<string, { docEpoch: number; byPlayer: Map<string, { requestId: string; at: number }> }>();
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

/** The room's lease as this page saw it in this room's doc: when it first
 *  saw the current record (`at` — the operator rewrites its record at every
 *  renewal, so this is when this page last saw the lease renewed), and when it
 *  first saw the record's holder hold it in this tenure (`heldSince`). */
let leaseSeen: { id: string; holder: string; at: number; heldSince: number } | null = null;

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
 * claiming a far-future expiry holds the room for one lease term, not
 * forever.
 */
function leaseLapsesAt(lease: CoinPusherOperatorLease, now: number): number {
  const heldUntil = seeLease(lease, now).at + OPERATOR_LEASE_MS;
  return isThisDevice(lease) ? Math.min(lease.expiresAt, heldUntil) : heldUntil;
}

/** Note the room's lease as this page sees it now (leaseSeen). A new record
 *  by the same holder in the same tenure is a renewal: it keeps `heldSince`.
 *  A new tenure is a new take, with its own settling wait, even when this
 *  page never saw the lease go. */
function seeLease(lease: CoinPusherOperatorLease, now: number) {
  // Scoped to the bound doc: another room's same record starts afresh.
  const holder = `${casinoDocEpoch()}|${lease.playerId}|${lease.sessionId}|${lease.tenure ?? ''}`;
  const id = `${holder}|${lease.expiresAt}`;
  let seen = leaseSeen;
  if (seen?.id !== id) {
    seen = { id, holder, at: now, heldSince: seen?.holder === holder ? seen.heldSince : now };
    leaseSeen = seen;
  }
  return seen;
}

/** Whether a lease was written by a session on this device (its tabs share
 *  the clock and the local node). */
function isThisDevice(lease: CoinPusherOperatorLease): boolean {
  return lease.sessionId.startsWith(`${deviceId}:`);
}

/** Earliest time this session may take `lease` over: when it lapses, plus
 *  the split window when it is another device's (SPLITS). Only the deed
 *  holder operates, so a lease from another device is the deed holder's own,
 *  whatever player id it names: an install that restored the deed holder's
 *  identity key has a player id of its own. */
function takeoverAt(lease: CoinPusherOperatorLease, now: number): number {
  const lapsesAt = leaseLapsesAt(lease, now);
  return isThisDevice(lease) ? lapsesAt : lapsesAt + OPERATOR_UNCLEAN_TAKEOVER_MS;
}

/** The room's coin-pusher operator as this page can tell it: none with a
 *  live lease (`offline`), one still in its OPERATOR_LEASE_SETTLE_MS wait
 *  after taking the lease (`starting` — a drop made now would reach it too
 *  late to keep its timing), or one at work (`ready`). */
export type CoinPusherOperatorState = 'offline' | 'starting' | 'ready';

/**
 * The room's operator state (every cabinet's DROP and door): this session by
 * its own lease and wait, any other while its lease hasn't lapsed by
 * leaseLapsesAt, ready OPERATOR_LEASE_SETTLE_MS after this page first saw its
 * holder take it — never sooner than the holder itself, which waits that long
 * from its own write. Renewals don't restart the wait; a new take does (its
 * record carries a new tenure), even one this page saw no gap before.
 */
export function coinPusherOperatorState(now = Date.now()): CoinPusherOperatorState {
  if (isLeavingRoom()) return 'offline';
  const lease = readCoinPusherOperatorLease();
  if (!lease) return 'offline';
  if (lease.sessionId === operatorSessionId) {
    if (!operator || operator.docEpoch !== casinoDocEpoch() || lease.expiresAt <= now) return 'offline';
    return now < operator.readyAt ? 'starting' : 'ready';
  }
  if (now >= leaseLapsesAt(lease, now)) return 'offline';
  return now < seeLease(lease, now).heldSince + OPERATOR_LEASE_SETTLE_MS ? 'starting' : 'ready';
}

/** Whether some session is operating the room's coin pushers (starting or at
 *  work), as far as this page can tell. */
export function isCoinPusherOperatorLive(now = Date.now()): boolean {
  return coinPusherOperatorState(now) !== 'offline';
}

/** A fresh 32-bit peg-field seed from the platform CSPRNG. The operator
 *  draws it when it settles the drop, so the player can neither choose nor
 *  predict it. */
export function randomPusherSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Stop operating the room's coin pushers here, releasing the lease if this
 *  session holds it. */
export function stopCoinPusherOperator(): void {
  if (!operator) return;
  operator = null;
  lastPolls.clear();
  requestsSeen.clear();
  if (readCoinPusherOperatorLease()?.sessionId === operatorSessionId) {
    clearCoinPusherOperatorLease();
  }
}

/** True while this browser session holds a live operator lease on the room. */
export function isCoinPusherOperator(now = Date.now()): boolean {
  const lease = readCoinPusherOperatorLease();
  return operator?.docEpoch === casinoDocEpoch()
    && lease?.sessionId === operatorSessionId
    && lease.expiresAt > now;
}

/**
 * World calls this every frame with the room's coin-pusher cabinets. It runs
 * the room's election (this session keeps, takes or gives up the one lease
 * under which it operates every cabinet), then the operator's work on each
 * cabinet when due. With no cabinet left, this session lets its lease go.
 */
export function tickCoinPusherRoom(machineIds: readonly string[], now = Date.now()): void {
  // A room this session is leaving isn't operated again: its released lease
  // stays released while the release is being sent (leaveCoinPusherRoom).
  if (isLeavingRoom()) return;
  // World ticks only cabinets in the room, so one put back before its
  // teardown ran (or finished) is no longer to be torn down.
  for (const machineId of machineIds) {
    pendingTeardowns.delete(machineId);
    sweeps.delete(machineId);
  }
  // Every client watches the lease's renewals, a frame at a time: that is
  // how it tells a live operator from a lapsed one (CLOCKS above). With no
  // lease, whoever takes it next starts its wait afresh.
  const lease = readCoinPusherOperatorLease();
  if (!lease) leaseSeen = null;
  else if (lease.sessionId !== operatorSessionId) seeLease(lease, now);
  // Nothing left to operate: let the lease go, so a cabinet placed later
  // needn't wait it out on another device.
  if (machineIds.length === 0) {
    stopCoinPusherOperator();
    return;
  }
  const operatorId = electCoinPusherOperator(lease, now);
  if (operatorId === null) return;
  const docEpoch = casinoDocEpoch();
  for (const machineId of machineIds) {
    const lastPoll = lastPolls.get(machineId);
    if (lastPoll?.docEpoch === docEpoch && now - lastPoll.checkedAt < REQUEST_POLL_MS) continue;
    lastPolls.set(machineId, { docEpoch, checkedAt: now });
    operateCoinPusher(machineId, operatorId, now);
  }
}

/**
 * The room's election, once a frame (ELECTION above): take the lease when no
 * other session may hold it, renew it, or give it up. Returns the operator's
 * player id once it is past its settling wait, else null.
 */
function electCoinPusherOperator(lease: CoinPusherOperatorLease | null, now: number): string | null {
  if (!canRunCroupier()) {
    stopCoinPusherOperator();
    return null;
  }
  const playerId = getPlayerId();
  if (!operator
    || operator.docEpoch !== casinoDocEpoch()
    || operator.playerId !== playerId) {
    if (lease && lease.sessionId !== operatorSessionId
      && now < takeoverAt(lease, now)) return null;
    const tenure = crypto.randomUUID();
    writeCoinPusherOperatorLease({
      playerId,
      sessionId: operatorSessionId,
      tenure,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator = {
      docEpoch: casinoDocEpoch(),
      playerId,
      tenure,
      readyAt: now + OPERATOR_LEASE_SETTLE_MS,
      renewedAt: now,
    };
    return null;
  }
  if (lease?.playerId !== playerId
    || lease.sessionId !== operatorSessionId
    || lease.expiresAt <= now) {
    // Lost, or lapsed. A lapsed record of this session's own goes now: once
    // this session stops operating, a release has nothing to find, so a page
    // leaving before the next frame would otherwise leave it for another
    // device to wait out. The next frame takes the lease afresh.
    stopCoinPusherOperator();
    return null;
  }
  if (now - operator.renewedAt >= OPERATOR_LEASE_RENEW_MS) {
    writeCoinPusherOperatorLease({
      playerId,
      sessionId: operatorSessionId,
      tenure: operator.tenure,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  return now < operator.readyAt ? null : playerId;
}

/**
 * One pass of the operator's work on a machine: create or re-own it, answer
 * the door request, then settle or refuse a bounded batch of pending inserts.
 * Exported for tests (with an injectable seed source); World reaches it only
 * through tickCoinPusherRoom's election.
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

  // Every pending request the read returns counts as seen now (the first
  // time it is); a batch of the oldest is then settled or refused.
  const pending = readCoinPusherRequests(machineId);
  const seen = seeRequests(machineId, pending, now);
  for (const request of pending.slice(0, MAX_REQUESTS_PER_POLL)) {
    const waited = now - (seen.get(request.player)?.at ?? now);
    state = settleOneInsert(machineId, state, request, waited, now, drawSeed);
    if (!state) return;
  }
}

/** Note the machine's pending requests as seen: a request keeps the time this
 *  session first saw it until its player files another. */
function seeRequests(
  machineId: string,
  pending: readonly PusherInsertRequest[],
  now: number,
): Map<string, { requestId: string; at: number }> {
  const docEpoch = casinoDocEpoch();
  let seen = requestsSeen.get(machineId);
  if (seen?.docEpoch !== docEpoch) {
    seen = { docEpoch, byPlayer: new Map() };
    requestsSeen.set(machineId, seen);
  }
  const current = new Map<string, { requestId: string; at: number }>();
  for (const request of pending) {
    const before = seen.byPlayer.get(request.player);
    current.set(request.player, before?.requestId === request.requestId
      ? before
      : { requestId: request.requestId, at: now });
  }
  // Only what is still pending is kept: an answered or withdrawn request goes.
  seen.byPlayer = current;
  return current;
}

/** Settle or refuse one request, which has waited `waitedMs` since this
 *  session first saw it; returns the machine as stored afterwards. */
function settleOneInsert(
  machineId: string,
  state: CoinPusherState,
  request: PusherInsertRequest,
  waitedMs: number,
  now: number,
  drawSeed: () => number,
): CoinPusherState | null {
  const refuse = (reason: PusherRefusalReason): CoinPusherState | null => {
    refuseCoinPusherInsert(machineId, request, reason, now);
    return readCoinPusherState(machineId);
  };
  // Aged on this page's clock: `requestedAt` is the player's, and decides
  // only whether the drop's timing is kept (resolveDropTiming).
  if (waitedMs > PUSHER_STALE_REQUEST_MS) return refuse('expired');
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
 * holder, every key deleted) only by a session that may operate the room by
 * the election's own rule: the one holding its lease, or one that could take
 * the lease over. Every settle happens on the lease holder, so the drain is
 * never merged with a drop another session is still settling, which would
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
  lastPolls.delete(machineId);
  requestsSeen.delete(machineId);
  // A room this session is leaving is left to the sessions still in it.
  if (!canManage || isLeavingRoom()) {
    pendingTeardowns.delete(machineId);
    sweeps.delete(machineId);
    return;
  }
  pendingTeardowns.set(machineId, casinoDocEpoch());
  tearDownIfFree(machineId, now);
}

/** Drain a removed cabinet unless another session may still be operating the
 *  room. A teardown left over from another room's doc (a room switch since)
 *  is dropped without touching this one. */
function tearDownIfFree(machineId: string, now: number): void {
  if (pendingTeardowns.get(machineId) !== casinoDocEpoch()) {
    pendingTeardowns.delete(machineId);
    return;
  }
  const playerId = getPlayerId();
  const lease = readCoinPusherOperatorLease();
  if (lease && lease.sessionId !== operatorSessionId
    && now < takeoverAt(lease, now)) return;
  pendingTeardowns.delete(machineId);
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
    pendingTeardowns.clear();
    sweeps.clear();
    return;
  }
  for (const [machineId, sweep] of [...sweeps]) {
    if (continueCoinPusherKeySweep(sweep)) sweeps.delete(machineId);
  }
  for (const machineId of [...pendingTeardowns.keys()]) tearDownIfFree(machineId, now);
}

/** Stop operating here, releasing the room's lease if this session holds it,
 *  so another tab or device needn't wait it out. */
export function releaseCoinPusherLease(): void {
  stopCoinPusherOperator();
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the lease if this session holds it, and operate or watch nothing
 * more in this room, so no frame takes the lease back while the release is
 * being sent. The room's lease observation, request sightings, pending
 * teardowns and key sweeps go with it. The next room's doc lifts this by its
 * own epoch.
 */
export function leaveCoinPusherRoom(): void {
  leavingDocEpoch = casinoDocEpoch();
  releaseCoinPusherLease();
  leaseSeen = null;
  requestsSeen.clear();
  pendingTeardowns.clear();
  sweeps.clear();
}

/** How much this session is watching or tidying up (the room's lease
 *  observation, request sightings, pending teardowns, key sweeps): tests and
 *  debugging. */
export function coinPusherWatchCount(): number {
  return (leaseSeen ? 1 : 0) + requestsSeen.size + pendingTeardowns.size + sweeps.size;
}

// Best effort on page close: the write may not flush. (A page restored from
// the back/forward cache simply takes the lease again.)
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseCoinPusherLease);
