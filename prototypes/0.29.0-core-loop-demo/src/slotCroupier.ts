/**
 * 🎰 Slot-machine operator (#109) — accepts spin requests, holds each round's
 * house seed, and settles or refunds the round.
 *
 * ELECTION: ONE browser session operates every slot machine in the room. It
 * takes the room's `slot-operator` lease, waits OPERATOR_LEASE_SETTLE_MS for
 * the doc to converge, then works while it keeps the lease (renewed every
 * OPERATOR_LEASE_RENEW_MS, lapsing after OPERATOR_LEASE_MS). One operator for
 * the room, not one per machine: a player's `bal:` is a whole value, so two
 * sessions settling that player's spins on two machines at once would each
 * write it, and the merge would keep only one of the two writes (a debit or a
 * payout would vanish). The session operates the machines whose bankroll its
 * player owns:
 *   • AUTO: the room's deed holder (canRunCroupier) operates every one.
 *   • BY HAND (a venture room, where nobody runs the croupier): a room owner
 *     starts one from its service panel, and this page operates the machines
 *     it started.
 * Machines whose bankroll another player owns wait until that player's
 * session holds the lease. World ticks the room every frame on every client
 * (tickSlotMachineRoom); there is no per-machine lease to fight over. A
 * session with no machine left to operate lets the lease go. A round's settle
 * and refunds write only while this session still holds the lease
 * (stillOperates), so a lease let go, lost or lapsed mid-settle is never
 * written behind: the round stays on its machine for the next operator.
 *
 * WIND-DOWN: a round this session accepted on a machine it no longer operates
 * (the bankroll changed hands, or its run by hand ended) can't wait for that
 * machine's next operator, who can't operate while this session holds the
 * lease. This session keeps the lease until it has refunded the round.
 *
 * SPLITS: a Y.Map lease is not a mutex. Two sessions cut off from each other
 * could each take it and settle spins; when the docs merge, only one of each
 * balance write survives. Settling can't be made split-safe without an
 * authoritative ledger (the Registry-anchored chips), so a second operator
 * never starts while the first may only be cut off: a session on ANOTHER
 * device takes over a lapsed lease only OPERATOR_UNCLEAN_TAKEOVER_MS later.
 * Tabs on one device share its local node, so they take over as soon as the
 * lease lapses (a reload, a closed tab). A session that stops operating
 * releases its lease, so a successor needn't wait; so does one leaving the
 * room, or the page (best effort on close). Only a split outlasting that
 * window can still put two operators in one room.
 *
 * CLOCKS: devices' clocks aren't synchronised, so a lease written on another
 * device is never judged by the expiry it claims: it lapses one
 * OPERATOR_LEASE_MS after this page last saw it renewed (leaseLapsesAt). Only
 * a tab on this device, which shares the clock, is also held to its own
 * expiry. The record is peer-writable: one claiming a far-future expiry holds
 * the room for one lease term, not forever.
 *
 * EARLIER BUILDS took a lease per machine (`slot-operator:<mid>`) and don't
 * read the room's. This build never writes those. While one is being renewed,
 * an earlier build is operating that machine, so this build operates nothing
 * in the room until the record lapses; a session that could operate then
 * deletes it, so it never holds up a later page.
 */
import {
  casinoDocEpoch,
  clearLegacySlotOperatorLease,
  clearSlotMachineKeys,
  clearSlotOperatorLease,
  clearSlotPlayRequest,
  clearSlotReveal,
  drainSlotMachineFunding,
  hasSlotEscrow,
  readLegacySlotOperatorLease,
  readSlotFundingConfig,
  readSlotMachineState,
  readSlotOddsConfig,
  readSlotOperatorLease,
  readSlotPlayRequests,
  readSlotReveal,
  readSlotSharedBankrollLease,
  releaseSlotSharedBankrollLease,
  refundSlotWager,
  reserveSlotWager,
  settleSlotWager,
  writeSlotMachineState,
  writeSlotOperatorLease,
} from './casinoDoc';
import type { SlotOperatorLease } from './casinoDoc';
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

interface SlotOperatorSession {
  docEpoch: number;
  playerId: string;
  /** This turn's token in the lease record, fresh for every take and kept
   *  across its renewals (SlotOperatorLease.tenure). */
  tenure: string;
  readyAt: number;
  renewedAt: number;
}

const settling = new Set<string>();
const accepting = new Set<string>();
const acceptedRounds = new Map<string, AcceptedSlotRound>();
/** This session's turn as the room's operator, if it has one. */
let operator: SlotOperatorSession | null = null;
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
const OPERATOR_LEASE_MS = 8_000;
const OPERATOR_LEASE_SETTLE_MS = 2_000;
const OPERATOR_LEASE_RENEW_MS = 3_000;
/** How much longer than a lapse a session on another device waits before
 *  taking over (see SPLITS above). */
export const OPERATOR_UNCLEAN_TAKEOVER_MS = 60_000;
const DEVICE_KEY = 'ssf-slot-operator-device';

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
export function slotOperatorSession(): string {
  return operatorSessionId;
}

/** The room's lease as this page saw it in this room's doc: when it first
 *  saw the current record (`at` — the operator rewrites its record at every
 *  renewal, so this is when this page last saw the lease renewed). */
let leaseSeen: { id: string; at: number } | null = null;

/** Earlier builds' per-machine leases as this page saw them in this room's
 *  doc (EARLIER BUILDS above), by machine: when it first saw each record. */
const earlierBuildLeasesSeen = new Map<string, { id: string; at: number }>();

/** The room's slot machines as the last room tick was given them, in the doc
 *  it ran in: RUN reads their earlier builds' leases afresh. */
let roomMachines: { docEpoch: number; ids: readonly string[] } | null = null;

/** The doc epoch of the room this session is leaving (leaveSlotMachineRoom):
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
 * counts too, though never past that.
 */
function leaseLapsesAt(lease: SlotOperatorLease, now: number): number {
  const heldUntil = seeLease(lease, now).at + OPERATOR_LEASE_MS;
  return isThisDevice(lease) ? Math.min(lease.expiresAt, heldUntil) : heldUntil;
}

/** Note the room's lease as this page sees it now (leaseSeen). Each take
 *  carries a new tenure, so a release and retake this page never saw the gap
 *  between still starts a full term. */
function seeLease(lease: SlotOperatorLease, now: number): { id: string; at: number } {
  // Scoped to the bound doc: another room's same record starts afresh.
  const id = `${casinoDocEpoch()}|${lease.playerId}|${lease.sessionId}|${lease.tenure ?? ''}|${lease.expiresAt}`;
  if (leaseSeen?.id !== id) leaseSeen = { id, at: now };
  return leaseSeen;
}

/** Whether a lease was written by a session on this device (its tabs share
 *  the clock and the local node). */
function isThisDevice(lease: SlotOperatorLease): boolean {
  return lease.sessionId.startsWith(`${deviceId}:`);
}

/** Earliest time this session may take `lease` over: when it lapses, plus
 *  the split window when it is another device's (SPLITS). */
function takeoverAt(lease: SlotOperatorLease, now: number): number {
  const lapsesAt = leaseLapsesAt(lease, now);
  return isThisDevice(lease) ? lapsesAt : lapsesAt + OPERATOR_UNCLEAN_TAKEOVER_MS;
}

/** Whether another session may still be operating the room's slot machines:
 *  until then, this session neither takes the lease nor starts a machine. */
function heldElsewhere(lease: SlotOperatorLease | null, now: number): boolean {
  return lease !== null
    && lease.sessionId !== operatorSessionId
    && now < takeoverAt(lease, now);
}

/**
 * Watch the earlier builds' per-machine leases in the room (EARLIER BUILDS),
 * and say whether one is operating a machine: a record this page saw written
 * or renewed within the last OPERATOR_LEASE_MS. A session that could operate
 * (`tidy`) deletes a lapsed one.
 */
function watchEarlierBuilds(machineIds: readonly string[], tidy: boolean, now: number): boolean {
  const docEpoch = casinoDocEpoch();
  for (const machineId of [...earlierBuildLeasesSeen.keys()]) {
    if (!machineIds.includes(machineId)) earlierBuildLeasesSeen.delete(machineId);
  }
  let until = 0;
  for (const machineId of machineIds) {
    const lease = readLegacySlotOperatorLease(machineId);
    if (!lease) {
      earlierBuildLeasesSeen.delete(machineId);
      continue;
    }
    const id = `${docEpoch}|${lease.playerId}|${lease.sessionId}|${lease.expiresAt}`;
    let seen = earlierBuildLeasesSeen.get(machineId);
    if (seen?.id !== id) {
      seen = { id, at: now };
      earlierBuildLeasesSeen.set(machineId, seen);
    }
    const lapsesAt = seen.at + OPERATOR_LEASE_MS;
    if (now < lapsesAt) {
      until = Math.max(until, lapsesAt);
    } else if (tidy) {
      clearLegacySlotOperatorLease(machineId);
      earlierBuildLeasesSeen.delete(machineId);
    }
  }
  return now < until;
}

/** Whether an earlier build is operating a machine in this room now, read
 *  afresh from the doc for the room's machines and `machineId`, so a renewal
 *  that arrived since the last room tick counts. Reads only: the room tick
 *  tidies lapsed records. */
function isEarlierBuildOperatingNow(machineId: string, now: number): boolean {
  const ids = roomMachines?.docEpoch === casinoDocEpoch() ? roomMachines.ids : [];
  return watchEarlierBuilds(ids.includes(machineId) ? ids : [...ids, machineId], false, now);
}

/** True while this session is the room's operator and holds a live lease. */
function ownsOperatorLease(playerId: string, now = Date.now()): boolean {
  const lease = readSlotOperatorLease();
  return operator?.docEpoch === casinoDocEpoch()
    && operator.playerId === playerId
    && lease?.playerId === playerId
    && lease.sessionId === operatorSessionId
    && lease.expiresAt > now;
}

/** True while this browser session operates the room's slot machines. */
export function isSlotOperator(now = Date.now()): boolean {
  return ownsOperatorLease(getPlayerId(), now);
}

/**
 * Whether this session still operates the room in the same take of the lease
 * (`tenure`) as when a piece of work began, in the doc of `docEpoch`. A
 * round's accept, settle and refunds check it after their awaits, just before
 * they write: a session that has let the lease go (a room it is leaving, a
 * page put away in the back/forward cache, a lease lost or lapsed) never
 * writes behind whoever took over, and work begun under one take never writes
 * under a later one, which may still be in its settling wait. The round stays
 * on its machine, and that machine's next operator finishes it.
 */
function stillOperates(docEpoch: number, tenure: string): boolean {
  return operator !== null
    && operator.docEpoch === docEpoch
    && docEpoch === casinoDocEpoch()
    && operator.tenure === tenure
    && readSlotOperatorLease()?.tenure === tenure
    && ownsOperatorLease(operator.playerId);
}

function takeOperatorLease(playerId: string, now: number): void {
  const tenure = crypto.randomUUID();
  writeSlotOperatorLease({
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
}

/** Stop operating the room's slot machines here and, unless told to keep
 *  them, forget the machines this page runs by hand. The lease record goes
 *  too, so a successor needn't wait it out: a round still settling here
 *  writes nothing once this session no longer operates (stillOperates). */
function stopSlotOperator(forgetManualMachines = true): void {
  if (forgetManualMachines) manualMachines.clear();
  if (!operator) return;
  operator = null;
  requestPolls.clear();
  if (readSlotOperatorLease()?.sessionId === operatorSessionId) clearSlotOperatorLease();
}

/**
 * The room's election, once a frame (ELECTION above), for a session that has
 * machines to operate: take the lease when no other session may hold it,
 * renew it, or give it up once lost or lapsed. Returns the operator's player
 * id once it is past its settling wait, else null.
 */
function electSlotOperator(lease: SlotOperatorLease | null, playerId: string, now: number): string | null {
  if (!operator
    || operator.docEpoch !== casinoDocEpoch()
    || operator.playerId !== playerId) {
    if (heldElsewhere(lease, now)) return null;
    takeOperatorLease(playerId, now);
    return null;
  }
  if (lease?.playerId !== playerId
    || lease.sessionId !== operatorSessionId
    || lease.expiresAt <= now) {
    // Lost, or lapsed (a tab that got no frames for a while). A lapsed record
    // of this session's own goes now, and the next frame takes the lease
    // afresh if nobody else has: machines run by hand are forgotten only once
    // another session holds the lease.
    stopSlotOperator(lease !== null && lease.sessionId !== operatorSessionId);
    return null;
  }
  if (now - operator.renewedAt >= OPERATOR_LEASE_RENEW_MS) {
    writeSlotOperatorLease({
      playerId,
      sessionId: operatorSessionId,
      tenure: operator.tenure,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  return now < operator.readyAt ? null : playerId;
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
 * where nobody runs the croupier). It watches the room's lease, runs the
 * election for a session with machines to operate, then the operator's work
 * on each machine and the refund of any round it is winding down.
 */
export function tickSlotMachineRoom(
  machineIds: readonly string[],
  manualAuthorized: boolean,
  now = Date.now(),
): void {
  // A room this session is leaving isn't operated again: its released lease
  // stays released while the release is being sent (leaveSlotMachineRoom).
  if (isLeavingRoom()) return;
  roomMachines = { docEpoch: casinoDocEpoch(), ids: machineIds };
  // Every client watches the lease's renewals, a frame at a time: that is how
  // it tells a live operator from a lapsed one (CLOCKS above).
  const lease = readSlotOperatorLease();
  if (!lease) leaseSeen = null;
  else if (lease.sessionId !== operatorSessionId) seeLease(lease, now);

  const auto = canRunCroupier();
  const docEpoch = casinoDocEpoch();
  const playerId = getPlayerId();
  for (const [machineId, manual] of manualMachines) {
    // Machines are run by hand only where nobody runs the croupier, by a room
    // owner, in the room and for the player they were started in and for.
    if (auto || !manualAuthorized
      || manual.docEpoch !== docEpoch
      || manual.playerId !== playerId
      || !machineIds.includes(machineId)) manualMachines.delete(machineId);
  }
  const earlierBuild = watchEarlierBuilds(machineIds, auto || manualAuthorized, now);
  if (earlierBuild) {
    // An earlier build is operating a machine here: it doesn't read this
    // lease, so any work here could settle alongside it (EARLIER BUILDS).
    stopSlotOperator();
    return;
  }
  // A round of a machine that has left the room (removed by a peer, and not
  // torn down here) is done with here: nobody operates that machine again.
  for (const machineId of [...acceptedRounds.keys()]) {
    if (!machineIds.includes(machineId)
      && !settling.has(machineId) && !accepting.has(machineId)) acceptedRounds.delete(machineId);
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
  if (operated.length === 0 && windingDown.length === 0) {
    // Nothing to operate: let the lease go, so another player's machines
    // needn't wait it out.
    stopSlotOperator();
    return;
  }
  const operatorId = electSlotOperator(lease, playerId, now);
  if (operatorId === null || !operator) return;
  // Work started now belongs to this take of the lease (stillOperates).
  const { tenure } = operator;
  for (const machineId of operated) tickSlotMachine(machineId, operatorId, tenure);
  for (const machineId of windingDown) {
    const accepted = currentAcceptedRound(machineId);
    if (!accepted || accepting.has(machineId)) continue;
    runTerminal(machineId, 'operator-change refund', () => windDownRound(machineId, accepted, tenure));
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
 * room). Starting needs its bankroll to be this player's, and neither another
 * session nor an earlier build to be operating the room's slots, as the doc
 * reads now; this session then takes the room's lease at once. Stopping waits
 * for the machine's round to finish; the room tick lets the lease go once this
 * page runs no machine.
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
  if (isLeavingRoom()
    || readSlotFundingConfig(machineId)?.ownerId !== playerId
    || isEarlierBuildOperatingNow(machineId, now)
    || heldElsewhere(readSlotOperatorLease(), now)) return false;
  manualMachines.set(machineId, { docEpoch: casinoDocEpoch(), playerId });
  if (!ownsOperatorLease(playerId, now)) takeOperatorLease(playerId, now);
  return true;
}

export function isManualSlotMachineRunning(machineId: string, playerId: string): boolean {
  const manual = manualMachines.get(machineId);
  return manual?.docEpoch === casinoDocEpoch()
    && manual.playerId === playerId
    && ownsOperatorLease(playerId)
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
    if (!player || !state.requestId || !houseCommit
      || !accepted
      || accepted.requestId !== state.requestId
      || accepted.player !== player
      || accepted.houseCommit !== houseCommit) {
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
  if (!refundSlotWager(
    machineId,
    accepted.player,
    accepted.bet,
    accepted.funding,
    token,
  )) return;
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
  if (state?.player) clearSlotReveal(machineId, state.player);
  if (!fundingReady) return;
  if (refund && !refundSlotWager(
    machineId,
    refund.player,
    refund.bet,
    refund.funding,
    sharedLeaseToken,
  )) return;
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
  const reserve = reserveSlotWager(
    machineId,
    request.player,
    request.bet,
    funding,
    Math.max(request.bet, maxSlotPayout(request.bet, paytable)),
  );
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
    return;
  }
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
    clearSlotReveal(machineId, accepted.player);
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
  const paid = settleSlotWager(
    machineId,
    accepted.player,
    accepted.funding,
    resolution.credited,
    token,
  );
  let escrowSettled = paid;
  if (!paid) {
    escrowSettled = settleSlotWager(
      machineId,
      accepted.player,
      accepted.funding,
      0,
      token,
    );
  }
  if (!escrowSettled) return;
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
  releaseAcceptedFundingLease(machineId, accepted);
  acceptedRounds.delete(machineId);
}

export function closeSlotMachine(
  machineId: string,
  canManage = canRunCroupier(),
): void {
  // The room's lease isn't this machine's: the room tick lets it go once this
  // session has no machine left to operate.
  manualMachines.delete(machineId);
  requestPolls.delete(machineId);
  requestFirstSeen.delete(machineId);
  earlierBuildLeasesSeen.delete(machineId);
  if (!canManage) return;
  runTerminal(machineId, 'close', () => closeSlotMachineManaged(machineId));
}

async function closeSlotMachineManaged(machineId: string): Promise<void> {
  const state = readSlotMachineState(machineId);
  const accepted = currentAcceptedRound(machineId);
  let refunded = true;
  if (accepted) {
    const token = accepted.sharedLeaseToken ?? undefined;
    if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return;
    refunded = refundSlotWager(
      machineId,
      accepted.player,
      accepted.bet,
      accepted.funding,
      token,
    );
  } else if (state?.phase === 'spinning' && state.player && state.bet && state.funding) {
    const sharedLeaseToken = sharedFundingLeaseToken(
      machineId,
      state.funding,
      undefined,
      state.sharedLeaseToken,
    );
    if (!await ensureTerminalFundingLease(
      machineId,
      state.funding,
      sharedLeaseToken,
    )) return;
    refunded = refundSlotWager(
      machineId,
      state.player,
      state.bet,
      state.funding,
      sharedLeaseToken,
    );
    if (refunded && sharedLeaseToken) {
      releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
    }
  }
  if (!refunded) return;
  releaseAcceptedFundingLease(machineId, accepted);
  acceptedRounds.delete(machineId);
  drainSlotMachineFunding(machineId);
  clearSlotMachineKeys(machineId);
}

/** Stop operating here and release the room's lease if this session holds
 *  it, so another tab or device needn't wait it out. A round still settling
 *  here writes nothing more (stillOperates), even on a page restored from the
 *  back/forward cache: whoever takes over finds its spin and refunds it. */
export function releaseSlotOperatorLease(): void {
  operator = null;
  requestPolls.clear();
  manualMachines.clear();
  if (readSlotOperatorLease()?.sessionId === operatorSessionId) clearSlotOperatorLease();
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the lease if this session holds it, and operate or watch nothing
 * more in this room, so no frame takes the lease back while the release is
 * being sent. The next room's doc lifts this by its own epoch.
 */
export function leaveSlotMachineRoom(): void {
  leavingDocEpoch = casinoDocEpoch();
  releaseSlotOperatorLease();
  leaseSeen = null;
  earlierBuildLeasesSeen.clear();
  roomMachines = null;
}

/** How much this session is watching in the room (the room's lease, earlier
 *  builds' leases): tests and debugging. */
export function slotOperatorWatchCount(): number {
  return (leaseSeen ? 1 : 0) + earlierBuildLeasesSeen.size;
}

/** Rounds this session accepted in this room's doc and still holds: tests
 *  and debugging. */
export function slotRoundsInHand(): number {
  const docEpoch = casinoDocEpoch();
  let n = 0;
  for (const accepted of acceptedRounds.values()) if (accepted.docEpoch === docEpoch) n += 1;
  return n;
}

// Best effort on page close: the write may not flush. (A page restored from
// the back/forward cache simply takes the lease again.)
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseSlotOperatorLease);
