/**
 * 🪙 Coin-pusher operator (#135) — slotCroupier.ts's auto operator, for the
 * arcade pusher.
 *
 * ELECTION: only the room's deed holder operates (canRunCroupier — the rule
 * every casino operator follows since #141/#142), and only ONE of their
 * browser sessions, for every coin pusher in the room, under the room's one
 * casino-operator lease, which the slot machines share (casinoOperator.ts,
 * ELECTION: the take, its settling wait, renewals and lapse). One operator
 * for the room, not one per cabinet: a player's `bal:` is a whole value, so
 * two sessions settling that player's drops on two cabinets at once would
 * each write it, and the merge would keep only one of the two writes. World
 * ticks the room every frame (tickCoinPusherRoom): the tick reports whether
 * this game needs the room (a cabinet to operate or one to drain, and the
 * deed), runs the election, and works only while it says this session holds
 * the lease past its settling wait, and the check before every write
 * (stillOperates) agrees. There is no start/stop control to fight the tick;
 * a session whose room has no cabinet left needs the room no more, and the
 * lease goes once no game does.
 *
 * SPLITS and CLOCKS: why another device waits a window before taking over a
 * lease it has seen lapse, and how a lease is judged lapsed without
 * comparing clocks across devices, are the election's (casinoOperator.ts,
 * SPLITS and CLOCKS). The panel asks it the same question: its DROP waits
 * until the operator is past its settling wait (coinPusherOperatorState). A
 * request is aged on this page's clock too, from when it arrived in this
 * page's doc (readCoinPusherRequestArrival), however deep in the queue it
 * waits; its `requestedAt`, the player's clock, decides only whether the
 * drop's timing is kept.
 *
 * OWNERSHIP: the operator creates a missing machine with itself as owner, and
 * re-owns one whose owner is anyone else (a deed transfer, a peer-written
 * owner, or another install of the deed holder, which has a player id of its
 * own). It creates one only where there is no record at all: a record that is
 * there but won't read is left as it is, ledger and all. The chips inside stay
 * where they are and go with the room, like its furniture — nothing is paid
 * out on a takeover, so a forged owner earns nothing. The owner is therefore
 * the install operating the room, and only its panel offers the door.
 *
 * TEARDOWN: a removed cabinet is drained by the same rule. Only the room's
 * operator, past its settling wait, pays out the chips inside and deletes its
 * keys: by then a previous holder's last settles have reached this doc, so the
 * drain never merges with a settle still in flight elsewhere, which would
 * bring the machine back and pay its chips twice (see closeCoinPusher). A
 * session that must wait keeps the teardown pending, and the room tick keeps
 * the election going for it even with no cabinet left. The chips and the
 * machine's own keys go in one transaction. Its per-player keys, which carry
 * no chips, are swept afterwards, one batch a frame however many cabinets
 * were removed, so a flood of them can't stall a frame.
 *
 * WORK (at most every REQUEST_POLL_MS): the owner's door request first
 * (carried out, or answered with a refusal when its requester doesn't own the
 * machine), then the first MAX_REQUESTS_PER_POLL inserts to arrive. The requests come
 * from casinoDoc's per-machine index, which looks at no more than
 * PUSHER_REQUEST_SCAN of them, so a poll costs the same however many keys
 * peers write (the slot operator likewise takes one head request per poll).
 * An insert is refused — no chips move — when it is stale, the player has no
 * chip, the machine is full, its counters have no room for another drop, or
 * the player's balance couldn't take the most the drop could pay; a drop that
 * fails anyway is refused too (jammed), never cleared without an answer.
 * Otherwise
 * resolveDropTiming keeps the phase the player saw (inside the timing
 * window), processInsert runs with a seed the operator draws itself, and
 * casinoDoc.settleCoinPusherInsert debits the chip, credits the payout,
 * publishes the machine, answers the player and clears the request in one
 * transaction.
 */
import {
  casinoDocEpoch,
  commitCoinPusherEmpty,
  continueCoinPusherKeySweep,
  drainAndClearCoinPusher,
  isCoinPusherRecordUnreadable,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherRequestArrival,
  readCoinPusherRequests,
  readCoinPusherState,
  refuseCoinPusherEmpty,
  refuseCoinPusherInsert,
  settleCoinPusherInsert,
  startCoinPusherKeySweep,
  writeCoinPusherState,
} from './casinoDoc';
import type { CoinPusherKeySweep } from './casinoDoc';
import {
  casinoLeaseObserved,
  casinoOperatorSession,
  coinPusherOperatorState,
  currentTake,
  electCasinoOperator,
  isLeavingCasinoRoom,
  leaveCasinoRoom,
  operatorReady,
  ownsCasinoOperatorLease,
  registerOperatorGame,
  releaseCasinoOperatorLease,
  reportOperatorNeed,
  stillOperates,
} from './casinoOperator';
import { canRunCroupier } from './croupier';
import {
  chipsInMachine,
  emptyMachine,
  hasRoomForDrop,
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

/** The lease's timing and the panel's state are the election's
 *  (casinoOperator.ts); the names this module exported stay. */
export { OPERATOR_UNCLEAN_TAKEOVER_MS, coinPusherOperatorState } from './casinoOperator';
export type { CasinoOperatorState as CoinPusherOperatorState } from './casinoOperator';

const lastPolls = new Map<string, { docEpoch: number; checkedAt: number }>();
/** Removed cabinets this session is to clear once no other session may be
 *  operating them (closeCoinPusher), with the doc epoch each was removed in:
 *  one never reads or writes a different room's doc. */
const pendingTeardowns = new Map<string, number>();
/** Drained machines whose per-player keys this session is still deleting, in
 *  turn, one batch a frame between them (tickCoinPusherTeardowns). */
const sweeps = new Map<string, CoinPusherKeySweep>();
/** Short: a drop's timing window (MAX_DROP_LAG_MS) has to cover this wait. */
const REQUEST_POLL_MS = 100;
/** Inserts settled or refused per poll (≤ 40 a second per machine). */
export const MAX_REQUESTS_PER_POLL = 4;

/**
 * This game's part in the room's one lease (casinoOperator.ts). A take that
 * has ended, whichever call ended it, leaves the polls made under it stale;
 * never the queues: a removed cabinet stays to be drained under the next take
 * (TEARDOWN), and a sweep needs no lease. Leaving the room forgets all three.
 */
registerOperatorGame('pusher', {
  onStop() { lastPolls.clear(); },
  onLeave() { pendingTeardowns.clear(); sweeps.clear(); lastPolls.clear(); },
});

/** This page's operator session id (`<device>:<page load>`). */
export function coinPusherOperatorSession(): string {
  return casinoOperatorSession();
}

/** Whether some session is operating the room's coin pushers (starting or at
 *  work), as far as this page can tell (coinPusherOperatorState). */
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

/** True while this browser session holds the room's live lease, in its
 *  current take (casinoOperator.ts ownsCasinoOperatorLease). */
export function isCoinPusherOperator(now = Date.now()): boolean {
  return ownsCasinoOperatorLease(getPlayerId(), now);
}

/**
 * World calls this every frame with the room's coin-pusher cabinets. It
 * reports this game's need for the room and runs the room's election
 * (casinoOperator.ts: this session keeps, takes or gives up the one lease
 * under which it operates every cabinet), then the operator's work on each
 * cabinet when due. With no cabinet left and nothing to drain, this game
 * needs the room no more, and the lease goes once no game does.
 */
export function tickCoinPusherRoom(machineIds: readonly string[], now = Date.now()): void {
  // A room this session is leaving isn't operated again: its released lease
  // stays released while the release is being sent (leaveCoinPusherRoom).
  if (isLeavingCasinoRoom()) return;
  // World ticks only cabinets in the room, so one put back before its
  // teardown ran (or finished) is no longer to be torn down.
  for (const machineId of machineIds) {
    pendingTeardowns.delete(machineId);
    sweeps.delete(machineId);
  }
  // The deed holder needs the room while a cabinet is to be operated or torn
  // down; nobody else ever does. The election watches the room's records on
  // every client, every frame (that is how it tells a live operator from a
  // lapsed one), and tidies earlier builds' lapsed leases for a session that
  // may operate.
  const may = canRunCroupier();
  reportOperatorNeed('pusher', may && (machineIds.length > 0 || hasTeardownsHere()));
  const outcome = electCasinoOperator(now, may);
  // The lease may be held here for the slot machines alone (a venture room's
  // manual operator): the pushers' work still takes the deed.
  if (outcome.kind !== 'ready' || !may) return;
  const { docEpoch, playerId: operatorId, tenure } = outcome;
  // Past its settling wait, the operator drains the cabinets removed meanwhile
  // (TEARDOWN).
  for (const [machineId, removedIn] of [...pendingTeardowns]) {
    if (removedIn === docEpoch) tearDown(machineId, operatorId, now);
    else pendingTeardowns.delete(machineId);
  }
  // The check every write under the lease makes (casinoOperator.ts
  // stillOperates), once for the frame's passes: no await lies between them.
  if (!stillOperates(docEpoch, tenure, now)) return;
  for (const machineId of machineIds) {
    const lastPoll = lastPolls.get(machineId);
    if (lastPoll?.docEpoch === docEpoch && now - lastPoll.checkedAt < REQUEST_POLL_MS) continue;
    lastPolls.set(machineId, { docEpoch, checkedAt: now });
    operateCoinPusher(machineId, operatorId, now);
  }
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
    // Created only where there is no record at all. One that is there but
    // won't read is kept as it is, ledger and all: the meter warns, and
    // nothing is played on it until the cabinet is removed.
    if (!isCoinPusherRecordUnreadable(machineId)) {
      writeCoinPusherState(machineId, initialCoinPusherState(operatorId, now));
    }
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

  // A batch of the first to arrive is settled or refused, each aged from its
  // arrival in this page's doc (CLOCKS): the index stamps every request as it
  // arrives, so one deep in a flood's queue is aged from then too, not from
  // when a read first reaches it.
  for (const request of readCoinPusherRequests(machineId, MAX_REQUESTS_PER_POLL)) {
    const arrived = readCoinPusherRequestArrival(machineId, request.player) ?? now;
    state = settleOneInsert(machineId, state, request, Math.max(0, now - arrived), now, drawSeed);
    if (!state) return;
  }
}

/** Settle or refuse one request, which has waited `waitedMs` since it arrived
 *  in this page's doc; returns the machine as stored afterwards. */
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
  // A machine whose counters have no room for another drop (only a record a
  // peer wrote gets there) takes no more: refused before the drop, so the
  // settle never meets a counter past the safe-integer range.
  if (!hasRoomForDrop(state)) return refuse('jammed');
  // A drop pays at most every chip in the machine, its own included, so it
  // leaves the player at most the chips inside richer. A balance that couldn't
  // take that is refused before the drop: a refusal never depends on how the
  // chip falls.
  if (!Number.isSafeInteger(readChips(request.player) + chipsInMachine(state))) {
    return refuse('balance-full');
  }

  const timing = resolveDropTiming(state, request.phase, request.requestedAt, now);
  let drop: ReturnType<typeof processInsert>;
  try {
    drop = processInsert(state, request.player, request.hole, timing.dropPhase, drawSeed());
  } catch (err) {
    // Unreachable for a guarded request; never let one poison the queue, and
    // never clear it without an answer.
    console.error('[coin-pusher] drop failed; refused as jammed, no chips moved:', err);
    return refuse('jammed');
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
  if (result === 'no-chips' || result === 'balance-full') return refuse(result);
  if (result === 'invalid') {
    // Unreachable behind the checks above: the operator computed the drop
    // itself. Still answered, never cleared silently.
    console.error('[coin-pusher] settle rejected the drop; refused as jammed, no chips moved');
    return refuse('jammed');
  }
  return readCoinPusherState(machineId);
}

/**
 * A removed cabinet. Every client that sees the removal stops operating it
 * here. Its records are cleared (the chips still inside paid to the deed
 * holder, every key deleted) only by the room's operator, past its settling
 * wait (TEARDOWN): every settle happens on the lease holder, and by then a
 * previous holder's last settles have reached this doc, so the drain is never
 * merged with a drop another session is still settling, which would bring the
 * machine back and pay its chips twice. The operator drains at once. Any other
 * deed-holder session keeps the teardown pending, for this room's doc only:
 * its room tick takes the lease once it may (at once if nobody holds it,
 * otherwise when the holder goes away), and drains after the settling wait.
 * The recipient is never read from the peer-writable machine.
 */
export function closeCoinPusher(
  machineId: string,
  canManage = canRunCroupier(),
  now = Date.now(),
): void {
  lastPolls.delete(machineId);
  // A room this session is leaving is left to the sessions still in it.
  if (!canManage || isLeavingCasinoRoom()) {
    pendingTeardowns.delete(machineId);
    sweeps.delete(machineId);
    return;
  }
  pendingTeardowns.set(machineId, casinoDocEpoch());
  // By the room's shared take, read afresh (casinoOperator.ts operatorReady):
  // never under a take the slot side has already ended.
  if (operatorReady(now)) tearDown(machineId, currentTake()!.playerId, now);
}

/** Whether a cabinet removed in this room's doc is waiting to be drained. */
function hasTeardownsHere(): boolean {
  const docEpoch = casinoDocEpoch();
  for (const removedIn of pendingTeardowns.values()) if (removedIn === docEpoch) return true;
  return false;
}

/** Drain a removed cabinet, as the room's operator past its settling wait,
 *  checked once more just before the write for both callers (stillOperates):
 *  a take that has ended since — lost, lapsed, released or ended by the slot
 *  side — drains nothing. The chips and the machine's own keys go in one
 *  transaction. Its per-player keys (no chips in any) are left to the
 *  teardown tick, which World runs after the room tick: it deletes them a
 *  batch a frame, never a second batch in the frame that drained. When the
 *  chips inside can't be credited yet, nothing is written and the teardown
 *  stays pending: the operator tries again on its next pass. */
function tearDown(machineId: string, recipient: string, now: number): void {
  const take = currentTake();
  if (!take || !stillOperates(take.docEpoch, take.tenure, now)) return;
  if (drainAndClearCoinPusher(machineId, recipient) === null) return;
  pendingTeardowns.delete(machineId);
  sweeps.set(machineId, startCoinPusherKeySweep(machineId));
}

/** World calls this every frame, after the room tick. It deletes one batch of
 *  removed cabinets' per-player keys, whichever cabinets and however many
 *  were removed: the sweeps take turns, so a frame's work stays one batch.
 *  It also forgets teardowns left over from another room's doc (a room switch
 *  since). The drains themselves are the operator's (tickCoinPusherRoom). */
export function tickCoinPusherTeardowns(): void {
  if (pendingTeardowns.size === 0 && sweeps.size === 0) return;
  if (!canRunCroupier()) {
    pendingTeardowns.clear();
    sweeps.clear();
    return;
  }
  const docEpoch = casinoDocEpoch();
  for (const [machineId, removedIn] of [...pendingTeardowns]) {
    if (removedIn !== docEpoch) pendingTeardowns.delete(machineId);
  }
  for (const [machineId, sweep] of [...sweeps]) {
    sweeps.delete(machineId);
    // A sweep that finds nothing left ends without deleting anything, and the
    // next takes this frame's batch. One that deleted goes to the back.
    if (!continueCoinPusherKeySweep(sweep)) {
      sweeps.set(machineId, sweep);
      return;
    }
  }
}

/** Stop operating here, releasing the room's lease if this session holds it
 *  (casinoOperator.ts releaseCasinoOperatorLease), so another tab or device
 *  needn't wait it out. The page's one pagehide listener calls the same. */
export function releaseCoinPusherLease(): void {
  releaseCasinoOperatorLease();
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the lease if this session holds it, and operate or watch nothing
 * more in this room, so no frame takes the lease back while the release is
 * being sent (casinoOperator.ts leaveCasinoRoom). The room's lease
 * observation, pending teardowns and key sweeps go with it (onLeave). The
 * next room's doc lifts this by its own epoch. The slot side's wrapper does
 * the same, so the second of the two calls is a no-op.
 */
export function leaveCoinPusherRoom(): void {
  leaveCasinoRoom();
}

/** How much this session is watching or tidying up (another session's room
 *  record, as the election memoises it; pending teardowns; key sweeps):
 *  tests and debugging. */
export function coinPusherWatchCount(): number {
  return casinoLeaseObserved() + pendingTeardowns.size + sweeps.size;
}
