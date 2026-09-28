/**
 * 🎰 Slot-machine operator (#109) — accepts spin requests, holds each round's
 * house seed, and settles or refunds the round.
 *
 * ELECTION: ONE browser session operates every casino game in the room, under
 * the room's one operator lease (casinoOperator.ts: the take and its settling
 * wait, renewals, lapse, the split window between devices, clocks, earlier
 * builds' per-machine leases, and the v0.38 room keys the lease shadows). The
 * slots are one of the lease's games: every frame tickSlotMachineRoom reports
 * whether they NEED the room (a machine to operate, a round to wind down, a
 * removed machine holding chips), runs the election, and works only once it
 * answers 'ready'. One operator for the room, not one per machine: a player's
 * `bal:` is a whole value, so two sessions settling that player's spins on
 * two machines at once would each write it, and the merge would keep only one
 * of the two writes (a debit or a payout would vanish). The session operates
 * the machines whose bankroll its player owns:
 *   • AUTO: the room's deed holder (canRunCroupier) operates every one.
 *   • BY HAND (a venture room, where nobody runs the croupier): a room owner
 *     starts one from its service panel, and this page operates the machines
 *     it started.
 * Machines whose bankroll another player owns wait until that player's
 * session holds the lease. World ticks the room every frame on every client
 * (tickSlotMachineRoom); there is no per-machine lease to fight over. A
 * session with no machine left to operate reports no need, and the lease goes
 * once no game needs it. A round's settle and refunds write only while this
 * session still holds the lease in the take they began under (stillOperates,
 * after their last await and just before the transaction), so a lease let go,
 * lost or lapsed mid-settle is never written behind: the round stays on its
 * machine for the next operator.
 *
 * WIND-DOWN: a round this session accepted on a machine it no longer operates
 * (the bankroll changed hands, or its run by hand ended) can't wait for that
 * machine's next operator, who can't operate while this session holds the
 * lease. This session keeps the lease until it has refunded the round.
 *
 * TERMINAL WRITES: a round's stake and its spin go out together. Accepting
 * locks the stake and publishes the spin in one transaction, and a settle, a
 * refund or a teardown returns the stake and ends the spin (or removes the
 * machine) in one transaction, so a peer never sees one without the other.
 * A spin with no stake locked was settled or refunded by an operator whose
 * state never followed (an earlier build sends the two as separate updates):
 * the next operator ends it without moving chips, and a teardown removes the
 * machine without a refund.
 *
 * TEARDOWN: a removed machine can still hold chips (a round's stake in escrow,
 * its own bankroll), and paying them out rewrites balances. So every session
 * that may manage the room queues the teardown (closeSlotMachine), and only
 * the room's operator, past its settling wait, pays the chips out and deletes
 * the machine's keys, in one transaction and in the take it began under: a
 * teardown never races a settle on another machine for the same player. A
 * session with a teardown queued takes the lease if nobody holds it, as for a
 * machine to operate, so a removal is torn down with nobody else present. A
 * removed machine holding no chips (paid out already, or never funded) is torn
 * down at once by whoever queued it: deleting its keys writes no balance.
 *
 * SPLITS, CLOCKS, EARLIER BUILDS: casinoOperator.ts. What the slots live
 * with: a settle can't be made split-safe, so another device's lease seen to
 * lapse is taken over only OPERATOR_UNCLEAN_TAKEOVER_MS later; another
 * device's record is judged by the renewals this page sees, never by the
 * expiry it claims; and while an earlier build renews a `slot-operator:<mid>`
 * record, nothing here operates, a removed machine keeps its keys (that
 * record is among them), and every write reads those records afresh
 * (stillOperates). This build never writes such records.
 */
import {
  casinoDocEpoch,
  clearSlotMachineKeys,
  clearSlotPlayRequest,
  clearSlotReveal,
  drainSlotMachineFunding,
  hasSlotEscrow,
  slotMachineHoldsChips,
  readSlotFundingConfig,
  readSlotMachineState,
  readSlotOddsConfig,
  readSlotPlayRequests,
  readSlotReveal,
  readSlotSharedBankrollLease,
  releaseSlotSharedBankrollLease,
  refundSlotWager,
  reserveSlotWager,
  settleSlotWager,
  transactCasino,
  writeSlotMachineState,
} from './casinoDoc';
import {
  casinoLeaseObserved,
  casinoOperatorSession,
  earlierBuildLeasesWatched,
  electCasinoOperator,
  forgetEarlierBuildLease,
  isLeavingCasinoRoom,
  leaveCasinoRoom,
  ownsCasinoOperatorLease,
  registerOperatorGame,
  releaseCasinoOperatorLease,
  reportOperatorNeed,
  stillOperates,
  takeCasinoOperatorLease,
} from './casinoOperator';
import { canRunCroupier } from './croupier';
import {
  commitSlotSeed,
  DEFAULT_PAYTABLE,
  deriveReelStops,
  hashSlotPaytable,
  initialSlotMachineState,
  maxSlotPayout,
  randomSlotSeed,
  resolveSlot,
  SLOT_REQUEST_TTL_MS,
  SLOT_SPIN_MS,
  spinReels,
} from './games/slots';
import type {
  SlotFundingConfig,
  SlotMachineState,
  SlotPayEntry,
} from './games/slots';
import { getPlayerId } from './identity';

/** How much longer than a lapse a session on another device waits before
 *  taking over (casinoOperator.ts, SPLITS); the tests pin it from here. */
export { OPERATOR_UNCLEAN_TAKEOVER_MS } from './casinoOperator';

interface AcceptedSlotRound {
  docEpoch: number;
  requestId: string;
  player: string;
  playerCommit: string;
  houseSeed: string;
  houseCommit: string;
  round: number;
  acceptedAt: number;
  bet: number;
  funding: SlotFundingConfig;
  sharedLeaseToken: string | null;
  paytable: SlotPayEntry[];
}

const settling = new Set<string>();
const accepting = new Set<string>();
const acceptedRounds = new Map<string, AcceptedSlotRound>();
/** Removed machines waiting for their teardown (TEARDOWN above), by the doc
 *  epoch of the room they were removed from. */
const pendingTeardowns = new Map<string, number>();
/** Machines this page runs by hand (a venture room): started from their
 *  service panel by `playerId`, in the room whose doc epoch is `docEpoch`. */
const manualMachines = new Map<string, { docEpoch: number; playerId: string }>();
const requestPolls = new Map<string, { docEpoch: number; checkedAt: number }>();
const requestFirstSeen = new Map<string, {
  docEpoch: number;
  requestId: string;
  seenAt: number;
}>();
const REVEAL_TIMEOUT_MS = 30_000;
const REQUEST_POLL_MS = 250;

/** This page's operator session id (`<device>:<page load>`): the one the
 *  room's lease names, for every game (casinoOperator.ts). */
export function slotOperatorSession(): string {
  return casinoOperatorSession();
}

/** The machines the last room tick found this session operating, not merely
 *  winding down, in the doc it ran in. An accept checks it after each await:
 *  a machine whose run has ended meanwhile (the croupier gate closed, the run
 *  by hand stopped, the bankroll changed hands) takes no new wager. */
let operatedNow: { docEpoch: number; ids: ReadonlySet<string> } | null = null;

function isOperatedNow(machineId: string, docEpoch: number): boolean {
  return operatedNow?.docEpoch === docEpoch && operatedNow.ids.has(machineId);
}

// The slots as one of the room's games (casinoOperator.ts): what this page
// forgets when its take of the lease ends, whichever call ended it, and when
// it leaves the room.
registerOperatorGame('slots', {
  onStop(reason) {
    operatedNow = null;
    requestPolls.clear();
    // Machines run by hand are kept across a lapse of this page's own lease
    // (they are its need, so the next frame takes the lease afresh) and
    // forgotten once another session holds the lease, an earlier build
    // operates, or the lease is released or left. RUN starts them again.
    if (reason !== 'lost-own') manualMachines.clear();
  },
  onLeave() {
    pendingTeardowns.clear();
    manualMachines.clear();
    operatedNow = null;
    requestPolls.clear();
  },
});

/** True while this browser session operates the room's slot machines: it
 *  holds the room's lease in its current take (casinoOperator.ts). */
export function isSlotOperator(now = Date.now()): boolean {
  return ownsCasinoOperatorLease(getPlayerId(), now);
}

/** A round this session accepted is still on the machine: its spin is the
 *  machine's current one. */
function isRoundSpinning(machineId: string, accepted: AcceptedSlotRound): boolean {
  const state = readSlotMachineState(machineId);
  return state?.phase === 'spinning'
    && state.requestId === accepted.requestId
    && state.player === accepted.player
    && state.fairness?.commits?.[1] === accepted.houseCommit;
}

/**
 * World calls this every frame, on every client, with the room's slot
 * machines, and whether this client may run machines by hand (a room owner
 * where nobody runs the croupier). It reports whether the slots need the room
 * and runs the room's election (casinoOperator.ts), which watches the room's
 * records and takes, renews or lets go of the lease for every game; then, as
 * the room's operator past its settling wait, it runs the work on each
 * machine, the refund of any round it is winding down, and the teardowns
 * queued here.
 */
export function tickSlotMachineRoom(
  machineIds: readonly string[],
  manualAuthorized: boolean,
  now = Date.now(),
): void {
  // A room this session is leaving isn't operated again: its released lease
  // stays released while the release is being sent (leaveSlotMachineRoom).
  if (isLeavingCasinoRoom()) return;
  const auto = canRunCroupier();
  const docEpoch = casinoDocEpoch();
  const playerId = getPlayerId();
  // A teardown belongs to the room it was queued in, and a machine put back
  // before it ran is no longer to be torn down (TEARDOWN). A session that may
  // no longer manage the room tears nothing down: those that may queued the
  // same removals.
  for (const [machineId, removedIn] of [...pendingTeardowns]) {
    if (removedIn !== docEpoch || machineIds.includes(machineId)
      || !(auto || manualAuthorized)) pendingTeardowns.delete(machineId);
  }
  for (const [machineId, manual] of manualMachines) {
    // Machines are run by hand only where nobody runs the croupier, by a room
    // owner, in the room and for the player they were started in and for.
    if (auto || !manualAuthorized
      || manual.docEpoch !== docEpoch
      || manual.playerId !== playerId
      || !machineIds.includes(machineId)) manualMachines.delete(machineId);
  }
  // A round of a machine that has left the room is done with here: nobody
  // operates that machine again. (A teardown refunds its stake from the
  // machine's own record.)
  for (const machineId of [...acceptedRounds.keys()]) {
    if (!machineIds.includes(machineId)
      && !settling.has(machineId) && !accepting.has(machineId)) acceptedRounds.delete(machineId);
  }
  // A removed machine holding chips waits for the room's operator (TEARDOWN),
  // and is the slots' need for the room. One holding no chips is torn down at
  // once by whoever queued it, lease or no lease, since deleting its keys
  // writes no balance — but only once the election has found no earlier build
  // operating (below): its per-machine record is among those keys.
  const teardowns: string[] = [];
  const chipless: string[] = [];
  for (const machineId of pendingTeardowns.keys()) {
    (slotMachineHoldsChips(machineId) ? teardowns : chipless).push(machineId);
  }
  const operated = machineIds.filter((machineId) =>
    (auto || manualMachines.has(machineId))
    && readSlotFundingConfig(machineId)?.ownerId === playerId);
  const windingDown: string[] = [];
  for (const machineId of machineIds) {
    if (operated.includes(machineId)) continue;
    if (settling.has(machineId) || accepting.has(machineId)) {
      windingDown.push(machineId); // still at work on it: keep the lease
      continue;
    }
    const accepted = currentAcceptedRound(machineId);
    if (!accepted) continue;
    if (isRoundSpinning(machineId, accepted)) windingDown.push(machineId);
    // Refunded or settled meanwhile by another operator: nothing left here.
    else acceptedRounds.delete(machineId);
  }
  // The slots' need for the room this frame. The election takes the lease
  // when some game needs it and no other session may hold it, renews it, and
  // lets it go once no game needs it (casinoOperator.ts, ELECTION), so
  // another player's machines needn't wait it out. With nothing to operate or
  // tear down, machines run by hand are forgotten too.
  const need = operated.length > 0 || windingDown.length > 0 || teardowns.length > 0;
  if (!need) manualMachines.clear();
  reportOperatorNeed('slots', need);
  const outcome = electCasinoOperator(now, auto || manualAuthorized);
  if (outcome.kind === 'legacy-build') {
    // An earlier build is operating a machine here: it doesn't read the
    // room's lease, so any work here could settle alongside it, and nothing
    // of its is deleted, a removed machine's keys included (EARLIER BUILDS in
    // casinoOperator.ts).
    manualMachines.clear();
    operatedNow = null;
    return;
  }
  for (const machineId of chipless) {
    clearSlotMachineKeys(machineId);
    pendingTeardowns.delete(machineId);
  }
  if (outcome.kind === 'held-elsewhere') {
    // Another session holds the lease: machines run by hand here, kept across
    // a lapse of this page's own lease, are forgotten, as when the lease is
    // taken from a take still running. RUN starts them again.
    manualMachines.clear();
  }
  if (outcome.kind !== 'ready') {
    operatedNow = null;
    return;
  }
  operatedNow = { docEpoch, ids: new Set(operated) };
  // Work started now belongs to this take of the lease (stillOperates).
  const { playerId: operatorId, tenure } = outcome;
  for (const machineId of operated) tickSlotMachine(machineId, operatorId, tenure);
  for (const machineId of windingDown) {
    const accepted = currentAcceptedRound(machineId);
    if (!accepted || accepting.has(machineId)) continue;
    runTerminal(machineId, 'operator-change refund', () => windDownRound(machineId, accepted, tenure));
  }
  for (const machineId of teardowns) {
    if (accepting.has(machineId)) continue;
    runTerminal(machineId, 'close', () => closeSlotMachineManaged(machineId, tenure));
  }
}

/** Refund a round this session accepted on a machine it no longer operates
 *  (WIND-DOWN above). One attempt: a round whose refund can't be made (its
 *  escrow is already gone) isn't held here, and the machine's next operator
 *  finds its spin like any other it didn't accept. */
async function windDownRound(
  machineId: string,
  accepted: AcceptedSlotRound,
  tenure: string,
): Promise<void> {
  try {
    await cancelForHouseCommit(machineId, readSlotMachineState(machineId), tenure);
  } finally {
    if (acceptedRounds.get(machineId) === accepted) acceptedRounds.delete(machineId);
  }
}

/**
 * Start or stop running a machine by hand (its service panel, in a venture
 * room). Starting needs its bankroll to be this player's, and the room's
 * lease to be free or this page's, as the doc reads now (takeCasinoOperatorLease
 * refuses while this session is leaving the room, while an earlier build is
 * operating, and while another session's record is live under any of the
 * room's keys); this session then holds the room's lease at once, with the
 * slots' need recorded so no other game's election lets it go before the
 * next room tick. Stopping waits for the machine's round to finish; the room
 * tick reports no need once this page runs no machine, and the lease goes
 * once no game needs it.
 */
export function setManualSlotMachineRunning(
  machineId: string,
  playerId: string,
  running: boolean,
  now = Date.now(),
): boolean {
  if (!running) {
    if (accepting.has(machineId)
      || currentAcceptedRound(machineId)
      || readSlotMachineState(machineId)?.phase === 'spinning') return false;
    manualMachines.delete(machineId);
    return true;
  }
  if (readSlotFundingConfig(machineId)?.ownerId !== playerId) return false;
  if (!takeCasinoOperatorLease('slots', playerId, now)) return false;
  manualMachines.set(machineId, { docEpoch: casinoDocEpoch(), playerId });
  return true;
}

export function isManualSlotMachineRunning(machineId: string, playerId: string): boolean {
  const manual = manualMachines.get(machineId);
  return manual?.docEpoch === casinoDocEpoch()
    && manual.playerId === playerId
    && ownsCasinoOperatorLease(playerId)
    && readSlotFundingConfig(machineId)?.ownerId === playerId;
}

function currentAcceptedRound(machineId: string): AcceptedSlotRound | undefined {
  const accepted = acceptedRounds.get(machineId);
  if (accepted?.docEpoch === casinoDocEpoch()) return accepted;
  if (accepted) acceptedRounds.delete(machineId);
  return undefined;
}

function releaseAcceptedFundingLease(
  machineId: string,
  accepted: AcceptedSlotRound | undefined,
): void {
  if (accepted?.sharedLeaseToken) {
    releaseSlotSharedBankrollLease(machineId, accepted.sharedLeaseToken);
  }
}

function sharedFundingLeaseToken(
  machineId: string,
  funding: SlotFundingConfig | undefined,
  accepted?: AcceptedSlotRound,
  stateToken?: string | null,
): string | undefined {
  if (funding?.mode !== 'shared') return undefined;
  if (accepted?.sharedLeaseToken) return accepted.sharedLeaseToken;
  if (stateToken) return stateToken;
  const lease = readSlotSharedBankrollLease();
  return lease?.machineId === machineId
    ? lease.token
    : undefined;
}

async function ensureTerminalFundingLease(
  machineId: string,
  funding: SlotFundingConfig,
  token: string | undefined,
): Promise<boolean> {
  void machineId;
  void token;
  // Shared wagering is disabled. Never mutate a legacy shared escrow under
  // the old LWW lease; recovery requires an authoritative migration path.
  return funding.mode !== 'shared';
}

function runTerminal(
  machineId: string,
  label: string,
  action: () => Promise<void>,
): void {
  if (settling.has(machineId)) return;
  settling.add(machineId);
  action()
    .catch((err) => console.error(`[slots] ${label} failed:`, err))
    .finally(() => settling.delete(machineId));
}

function tickSlotMachine(machineId: string, operatorId: string, tenure: string): void {
  if (settling.has(machineId) || accepting.has(machineId)) return;
  const state = readSlotMachineState(machineId);
  let activeAccepted = currentAcceptedRound(machineId);
  if (activeAccepted
    && (state?.phase !== 'spinning'
      || state.requestId !== activeAccepted.requestId
      || state.player !== activeAccepted.player)) {
    if (state?.phase === 'spinning' || !hasSlotEscrow(machineId)) {
      // Resolved without this session (a lease it lost for a while): another
      // round is spinning here, whose escrow this is, or nothing is locked.
      // Nothing of this round is left to refund.
      acceptedRounds.delete(machineId);
      activeAccepted = undefined;
    } else {
      // No spin shown, and a stake still locked. An operator locks a stake and
      // publishes its spin in one transaction (accept), so this stake is this
      // round's own, and its spin was overwritten while the stake was locked.
      runTerminal(machineId, 'state-change refund', () =>
        cancelForHouseCommit(machineId, state, tenure));
      return;
    }
  }
  if (readSlotFundingConfig(machineId)?.ownerId !== operatorId) return;
  if (state?.phase === 'spinning' && state.funding?.ownerId !== operatorId) {
    runTerminal(machineId, 'funding-owner transfer refund', () =>
      cancelForHouseCommit(machineId, state, tenure));
    return;
  }
  if (state?.phase === 'spinning') {
    const player = state.player;
    const houseCommit = state.fairness?.commits?.[1];
    const accepted = activeAccepted;
    // A spin this session didn't accept is refunded, and so is one with no
    // stake locked, which ends without moving chips (TERMINAL WRITES above).
    if (!player || !state.requestId || !houseCommit
      || !accepted
      || accepted.requestId !== state.requestId
      || accepted.player !== player
      || accepted.houseCommit !== houseCommit
      || !hasSlotEscrow(machineId)) {
      runTerminal(machineId, 'house-commit refund', () =>
        cancelForHouseCommit(machineId, state, tenure));
      return;
    }
    let reveal = readSlotReveal(machineId, player);
    if (reveal?.requestId === state.requestId && reveal.houseCommit !== houseCommit) {
      clearSlotReveal(machineId, player);
      reveal = null;
    }
    if (!reveal || reveal.requestId !== state.requestId) {
      if (Date.now() - accepted.acceptedAt >= REVEAL_TIMEOUT_MS) {
        runTerminal(machineId, 'reveal timeout', () =>
          settleRevealTimeout(machineId, state, accepted, tenure));
      }
      return;
    }
    if (Date.now() - accepted.acceptedAt < SLOT_SPIN_MS) return;
    runTerminal(machineId, 'settle', () =>
      settle(machineId, state, reveal.seed, accepted, tenure));
    return;
  }

  const now = Date.now();
  const docEpoch = casinoDocEpoch();
  const lastPoll = requestPolls.get(machineId);
  if (lastPoll?.docEpoch === docEpoch && now - lastPoll.checkedAt < REQUEST_POLL_MS) return;
  requestPolls.set(machineId, { docEpoch, checkedAt: now });
  const request = readSlotPlayRequests(machineId)[0];
  if (!request) {
    requestFirstSeen.delete(machineId);
    return;
  }
  let firstSeen = requestFirstSeen.get(machineId);
  if (firstSeen?.docEpoch !== docEpoch || firstSeen.requestId !== request.requestId) {
    firstSeen = { docEpoch, requestId: request.requestId, seenAt: now };
    requestFirstSeen.set(machineId, firstSeen);
  }
  if (now - firstSeen.seenAt > SLOT_REQUEST_TTL_MS) {
    clearSlotPlayRequest(machineId, request.player);
    requestFirstSeen.delete(machineId);
    writeSlotMachineState(machineId, {
      ...initialSlotMachineState(),
      phase: 'settled',
      round: (state?.round ?? 0) + 1,
      player: request.player,
      bet: request.bet,
      requestId: request.requestId,
      credited: 0,
      settledAt: now,
      failure: 'request-expired',
    });
    return;
  }
  accepting.add(machineId);
  accept(machineId, state, request, operatorId, tenure)
    .catch((err) => console.error('[slots] accept failed:', err))
    .finally(() => accepting.delete(machineId));
}

async function settleRevealTimeout(
  machineId: string,
  state: SlotMachineState,
  accepted: AcceptedSlotRound,
  tenure: string,
): Promise<void> {
  const token = accepted.sharedLeaseToken ?? undefined;
  if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return;
  if (!stillOperates(accepted.docEpoch, tenure)) return;
  const refunded = transactCasino(() => {
    if (!refundSlotWager(
      machineId,
      accepted.player,
      accepted.bet,
      accepted.funding,
      token,
    )) return false;
    clearSlotReveal(machineId, accepted.player);
    writeSlotMachineState(machineId, {
      ...state,
      bet: accepted.bet,
      funding: accepted.funding,
      paytable: accepted.paytable,
      sharedLeaseToken: null,
      phase: 'settled',
      credited: 0,
      settledAt: Date.now(),
      failure: 'reveal-timeout',
    });
    return true;
  });
  if (!refunded) return;
  releaseAcceptedFundingLease(machineId, accepted);
  acceptedRounds.delete(machineId);
}

async function cancelForHouseCommit(
  machineId: string,
  state: SlotMachineState | null,
  tenure: string,
): Promise<void> {
  const docEpoch = casinoDocEpoch();
  const accepted = currentAcceptedRound(machineId);
  const player = accepted?.player ?? state?.player;
  const bet = accepted?.bet ?? state?.bet;
  const funding = accepted?.funding ?? state?.funding;
  const sharedLeaseToken = sharedFundingLeaseToken(
    machineId,
    funding,
    accepted,
    state?.sharedLeaseToken,
  );
  const refund = player && bet && funding ? { player, bet, funding } : null;
  const fundingReady = !refund
    || await ensureTerminalFundingLease(machineId, refund.funding, sharedLeaseToken);
  // Nothing is written once this session no longer operates the room.
  if (!stillOperates(docEpoch, tenure)) return;
  // The refund and the settled state go out in one transaction (TERMINAL
  // WRITES above).
  const ended = transactCasino(() => {
    if (state?.player) clearSlotReveal(machineId, state.player);
    if (!fundingReady) return false;
    // No stake locked: the round was settled or refunded already, and only
    // its spin is left to end.
    if (refund && hasSlotEscrow(machineId) && !refundSlotWager(
      machineId,
      refund.player,
      refund.bet,
      refund.funding,
      sharedLeaseToken,
    )) return false;
    writeSlotMachineState(machineId, {
      ...(state ?? initialSlotMachineState()),
      ...(accepted ? {
        round: accepted.round,
        player: accepted.player,
        bet: accepted.bet,
        requestId: accepted.requestId,
        acceptedAt: accepted.acceptedAt,
        funding: accepted.funding,
        paytable: accepted.paytable,
      } : {}),
      phase: 'settled',
      credited: 0,
      settledAt: Date.now(),
      failure: 'invalid-house-commit',
      sharedLeaseToken: null,
    });
    return true;
  });
  if (!ended) return;
  if (sharedLeaseToken) releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
  acceptedRounds.delete(machineId);
}

async function accept(
  machineId: string,
  state: SlotMachineState | null,
  request: ReturnType<typeof readSlotPlayRequests>[number],
  operatorId: string,
  tenure: string,
): Promise<void> {
  const docEpoch = casinoDocEpoch();
  const houseSeed = randomSlotSeed();
  const houseCommit = await commitSlotSeed(houseSeed);
  if (docEpoch !== casinoDocEpoch()) return;
  const queued = readSlotPlayRequests(machineId)
    .find((candidate) => candidate.player === request.player);
  const current = readSlotMachineState(machineId);
  if (queued?.requestId !== request.requestId
    || current?.phase === 'spinning'
    || !stillOperates(docEpoch, tenure)
    || !isOperatedNow(machineId, docEpoch)
    || readSlotFundingConfig(machineId)?.ownerId !== operatorId) return;
  const funding = readSlotFundingConfig(machineId);
  if (!funding) return;
  if (funding.mode === 'shared') {
    clearSlotPlayRequest(machineId, request.player);
    requestFirstSeen.delete(machineId);
    writeSlotMachineState(machineId, {
      ...initialSlotMachineState(),
      phase: 'settled',
      round: (current?.round ?? state?.round ?? 0) + 1,
      player: request.player,
      bet: request.bet,
      requestId: request.requestId,
      credited: 0,
      settledAt: Date.now(),
      funding,
      failure: 'shared-funding-unavailable',
    });
    return;
  }
  const leaseQueued = readSlotPlayRequests(machineId)
    .find((candidate) => candidate.player === request.player);
  const leaseCurrent = readSlotMachineState(machineId);
  const leaseFunding = readSlotFundingConfig(machineId);
  if (docEpoch !== casinoDocEpoch()
    || leaseQueued?.requestId !== request.requestId
    || leaseCurrent?.phase === 'spinning'
    || leaseFunding?.mode !== funding.mode
    || leaseFunding.ownerId !== funding.ownerId
    || !stillOperates(docEpoch, tenure)
    || !isOperatedNow(machineId, docEpoch)
    || leaseFunding.ownerId !== operatorId) {
    return;
  }
  const paytable = (readSlotOddsConfig(machineId)?.paytable ?? DEFAULT_PAYTABLE)
    .map((entry) => ({ ...entry, symbols: [...entry.symbols] as typeof entry.symbols }));
  const paytableHash = await hashSlotPaytable(paytable);
  const latestPaytable = readSlotOddsConfig(machineId)?.paytable ?? DEFAULT_PAYTABLE;
  const latestPaytableHash = await hashSlotPaytable(latestPaytable);
  const postHashQueued = readSlotPlayRequests(machineId)
    .find((candidate) => candidate.player === request.player);
  const postHashState = readSlotMachineState(machineId);
  const postHashFunding = readSlotFundingConfig(machineId);
  if (docEpoch !== casinoDocEpoch()
    || postHashQueued?.requestId !== request.requestId
    || postHashState?.phase === 'spinning'
    || postHashFunding?.mode !== funding.mode
    || postHashFunding.ownerId !== funding.ownerId
    || !stillOperates(docEpoch, tenure)
    || !isOperatedNow(machineId, docEpoch)
    || postHashFunding.ownerId !== operatorId) {
    return;
  }
  const round = (postHashState?.round ?? state?.round ?? 0) + 1;
  if (paytableHash !== request.paytableHash
    || latestPaytableHash !== paytableHash) {
    clearSlotPlayRequest(machineId, request.player);
    requestFirstSeen.delete(machineId);
    writeSlotMachineState(machineId, {
      ...initialSlotMachineState(),
      phase: 'settled',
      round,
      player: request.player,
      bet: request.bet,
      requestId: request.requestId,
      credited: 0,
      settledAt: Date.now(),
      funding,
      paytable,
      failure: 'odds-changed',
      sharedLeaseToken: null,
    });
    return;
  }
  clearSlotPlayRequest(machineId, request.player);
  requestFirstSeen.delete(machineId);
  const acceptedAt = Date.now();
  const accepted: AcceptedSlotRound = {
    docEpoch,
    requestId: request.requestId,
    player: request.player,
    playerCommit: request.playerCommit,
    houseSeed,
    houseCommit,
    round,
    acceptedAt,
    bet: request.bet,
    funding,
    sharedLeaseToken: null,
    paytable,
  };
  // The stake is locked and the spin published in one transaction, so no peer
  // ever sees this round's escrow without its spin (the stale-round rule in
  // tickSlotMachine reads a lone escrow as the round's own).
  const reserve = transactCasino(() => {
    const locked = reserveSlotWager(
      machineId,
      request.player,
      request.bet,
      funding,
      Math.max(request.bet, maxSlotPayout(request.bet, paytable)),
    );
    if (locked !== 'ok') return locked;
    acceptedRounds.set(machineId, accepted);
    writeSlotMachineState(machineId, {
      ...initialSlotMachineState(),
      phase: 'spinning',
      round,
      player: request.player,
      bet: request.bet,
      requestId: request.requestId,
      houseSeed: null,
      acceptedAt,
      funding,
      paytable,
      sharedLeaseToken: null,
      fairness: { mode: 'commit-reveal', commits: [request.playerCommit, houseCommit] },
    });
    return locked;
  });
  if (reserve !== 'ok') {
    writeSlotMachineState(machineId, {
      ...initialSlotMachineState(),
      phase: 'settled',
      round,
      player: request.player,
      bet: request.bet,
      requestId: request.requestId,
      credited: 0,
      settledAt: Date.now(),
      funding,
      paytable,
      failure: reserve,
      sharedLeaseToken: null,
    });
  }
}

async function settle(
  machineId: string,
  state: SlotMachineState,
  playerSeed: string,
  accepted: AcceptedSlotRound,
  tenure: string,
): Promise<void> {
  const actualPlayerCommit = await commitSlotSeed(playerSeed);
  if (accepted.docEpoch !== casinoDocEpoch()) {
    if (acceptedRounds.get(machineId) === accepted) acceptedRounds.delete(machineId);
    return;
  }
  const current = readSlotMachineState(machineId);
  if (current?.phase !== 'spinning' || current.requestId !== state.requestId) return;
  if (acceptedRounds.get(machineId) !== accepted
    || current.fairness?.commits?.[1] !== accepted.houseCommit) {
    await cancelForHouseCommit(machineId, state, tenure);
    return;
  }
  if (actualPlayerCommit !== accepted.playerCommit) {
    if (stillOperates(accepted.docEpoch, tenure)) clearSlotReveal(machineId, accepted.player);
    return;
  }
  const seeds = await deriveReelStops(
    playerSeed,
    accepted.houseSeed,
    machineId,
    accepted.round,
  );
  if (accepted.docEpoch !== casinoDocEpoch()) {
    if (acceptedRounds.get(machineId) === accepted) acceptedRounds.delete(machineId);
    return;
  }
  if (readSlotMachineState(machineId)?.requestId !== state.requestId) return;
  const result = spinReels(seeds);
  const resolution = resolveSlot(
    result,
    accepted.bet,
    accepted.paytable,
  );
  const latest = readSlotMachineState(machineId);
  if (latest?.phase !== 'spinning' || latest.requestId !== state.requestId) return;
  if (acceptedRounds.get(machineId) !== accepted
    || latest.fairness?.commits?.[1] !== accepted.houseCommit) {
    await cancelForHouseCommit(machineId, state, tenure);
    return;
  }
  const token = accepted.sharedLeaseToken ?? undefined;
  if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return;
  if (!stillOperates(accepted.docEpoch, tenure)) return;
  const terminalState = readSlotMachineState(machineId);
  if (terminalState?.phase !== 'spinning'
    || terminalState.requestId !== state.requestId
    || acceptedRounds.get(machineId) !== accepted
    || terminalState.fairness?.commits?.[1] !== accepted.houseCommit) return;
  // The payout and the settled state go out in one transaction (TERMINAL
  // WRITES above).
  const settled = transactCasino(() => {
    const paid = settleSlotWager(
      machineId,
      accepted.player,
      accepted.funding,
      resolution.credited,
      token,
    );
    if (!paid && !settleSlotWager(
      machineId,
      accepted.player,
      accepted.funding,
      0,
      token,
    )) return false;
    writeSlotMachineState(machineId, {
      ...state,
      player: accepted.player,
      bet: accepted.bet,
      houseSeed: accepted.houseSeed,
      funding: accepted.funding,
      paytable: accepted.paytable,
      phase: 'settled',
      seeds,
      result,
      credited: paid ? resolution.credited : 0,
      settledAt: Date.now(),
      ...(paid ? {} : { failure: 'insufficient-bankroll' as const }),
      sharedLeaseToken: null,
      fairness: {
        mode: 'commit-reveal',
        commits: [accepted.playerCommit, accepted.houseCommit],
        seeds: [playerSeed, accepted.houseSeed],
      },
    });
    clearSlotReveal(machineId, accepted.player);
    return true;
  });
  if (!settled) return;
  releaseAcceptedFundingLease(machineId, accepted);
  acceptedRounds.delete(machineId);
}

/**
 * A removed machine. Every client that sees the removal stops operating it
 * here, and one that may manage the room queues its teardown for this room's
 * doc (TEARDOWN above). The room tick tears it down: at once when it holds no
 * chips, otherwise as the room's operator past its settling wait, so the
 * payout never races a settle. The room's lease isn't this machine's: the room
 * tick reports no need once this session has nothing left to operate or tear
 * down, and the lease goes once no game needs it.
 */
export function closeSlotMachine(
  machineId: string,
  canManage = canRunCroupier(),
): void {
  manualMachines.delete(machineId);
  requestPolls.delete(machineId);
  requestFirstSeen.delete(machineId);
  forgetEarlierBuildLease(machineId);
  // No longer operated here from now on, not just from the next room tick: an
  // accept paused at an await takes no new wager on it (operatedNow).
  if (operatedNow?.ids.has(machineId)) {
    const ids = new Set(operatedNow.ids);
    ids.delete(machineId);
    operatedNow = { docEpoch: operatedNow.docEpoch, ids };
  }
  // A room this session is leaving is left to the sessions still in it.
  if (!canManage || isLeavingCasinoRoom()) {
    pendingTeardowns.delete(machineId);
    return;
  }
  pendingTeardowns.set(machineId, casinoDocEpoch());
}

/** A queued teardown, run by the room's operator (TEARDOWN): refund a round's
 *  stake, return the machine's bankroll to its owner, and delete its keys. One
 *  attempt, in the take it began under. A machine whose chips can't all be
 *  accounted for keeps its keys, chips and all, rather than holding the room's
 *  lease: a stake locked with no round to refund it by (an earlier build's
 *  stake whose spin never arrived, an unreadable spin), a stake that can't be
 *  refunded, or a bankroll its owner can't be credited. */
async function closeSlotMachineManaged(machineId: string, tenure: string): Promise<void> {
  const docEpoch = casinoDocEpoch();
  const forget = (): void => {
    if (pendingTeardowns.get(machineId) === docEpoch) pendingTeardowns.delete(machineId);
  };
  const state = readSlotMachineState(machineId);
  const accepted = currentAcceptedRound(machineId);
  let refund: {
    player: string;
    bet: number;
    funding: SlotFundingConfig;
    token: string | undefined;
  } | null = null;
  if (accepted) {
    const token = accepted.sharedLeaseToken ?? undefined;
    if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return forget();
    refund = { player: accepted.player, bet: accepted.bet, funding: accepted.funding, token };
  } else if (state?.phase === 'spinning' && state.player && state.bet && state.funding) {
    const token = sharedFundingLeaseToken(
      machineId,
      state.funding,
      undefined,
      state.sharedLeaseToken,
    );
    if (!await ensureTerminalFundingLease(machineId, state.funding, token)) return forget();
    refund = { player: state.player, bet: state.bet, funding: state.funding, token };
  }
  // Paying out rewrites balances: only this session's take of the room's
  // lease may, and only while it lasts.
  if (!stillOperates(docEpoch, tenure)) return;
  forget();
  // The refund and the machine's removal go out in one transaction (TERMINAL
  // WRITES above). With no stake locked there is nothing to refund; a stake
  // locked with no round to refund it by stays, and the machine with it.
  const closed = transactCasino(() => {
    if (hasSlotEscrow(machineId) && (!refund || !refundSlotWager(
      machineId,
      refund.player,
      refund.bet,
      refund.funding,
      refund.token,
    ))) return false;
    if (!drainSlotMachineFunding(machineId)) return false;
    clearSlotMachineKeys(machineId);
    return true;
  });
  if (!closed) return;
  if (!accepted && refund?.token) releaseSlotSharedBankrollLease(machineId, refund.token);
  releaseAcceptedFundingLease(machineId, accepted);
  acceptedRounds.delete(machineId);
}

/** Stop operating here and release the room's lease if this session holds
 *  it, so another tab or device needn't wait it out; machines run by hand
 *  are forgotten either way (the stop hook above). A round still settling
 *  here writes nothing more (stillOperates), even on a page restored from the
 *  back/forward cache: whoever takes over finds its spin and refunds it. */
export function releaseSlotOperatorLease(): void {
  releaseCasinoOperatorLease();
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the lease if this session holds it, and operate or watch nothing
 * more in this room, so no frame takes the lease back while the release is
 * being sent — for every game at once (casinoOperator.ts leaveCasinoRoom);
 * the slots' queued teardowns and machines run by hand go with it (the leave
 * hook above). The next room's doc lifts this by its own epoch.
 */
export function leaveSlotMachineRoom(): void {
  leaveCasinoRoom();
}

/** How much this session is watching in the room (another session's room
 *  record, earlier builds' leases, removed machines waiting for their
 *  teardown): tests and debugging. */
export function slotOperatorWatchCount(): number {
  return casinoLeaseObserved() + earlierBuildLeasesWatched() + pendingTeardowns.size;
}

/** Rounds this session accepted in this room's doc and still holds: tests
 *  and debugging. */
export function slotRoundsInHand(): number {
  const docEpoch = casinoDocEpoch();
  let n = 0;
  for (const accepted of acceptedRounds.values()) if (accepted.docEpoch === docEpoch) n += 1;
  return n;
}

// The page's one `pagehide` listener, releasing the lease, is casinoOperator.ts's.
