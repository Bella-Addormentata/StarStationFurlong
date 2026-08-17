import {
  acquireSlotSharedBankrollLease,
  casinoDocEpoch,
  clearSlotMachineKeys,
  clearSlotOperatorLease,
  clearSlotPlayRequest,
  clearSlotReveal,
  drainSlotMachineFunding,
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
  SLOT_REQUEST_FUTURE_SKEW_MS,
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
  readyAt: number;
  renewedAt: number;
}

const settling = new Set<string>();
const accepting = new Set<string>();
const acceptedRounds = new Map<string, AcceptedSlotRound>();
const manualOperators = new Map<string, SlotOperatorSession>();
const autoOperators = new Map<string, SlotOperatorSession>();
const requestPolls = new Map<string, { docEpoch: number; checkedAt: number }>();
const REVEAL_TIMEOUT_MS = 30_000;
const REQUEST_POLL_MS = 250;
const OPERATOR_LEASE_MS = 8_000;
const OPERATOR_LEASE_SETTLE_MS = 2_000;
const OPERATOR_LEASE_RENEW_MS = 3_000;
const operatorSessionId = randomSlotSeed();

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
  if (funding.mode !== 'shared') return true;
  return token !== undefined
    && await acquireSlotSharedBankrollLease(machineId, token);
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

function ownsOperatorLease(machineId: string, playerId: string): boolean {
  const lease = readSlotOperatorLease(machineId);
  return lease?.playerId === playerId
    && lease.sessionId === operatorSessionId
    && lease.expiresAt > Date.now();
}

export function stopAutoSlotMachine(machineId: string): void {
  if (!autoOperators.has(machineId)) return;
  autoOperators.delete(machineId);
  const state = readSlotMachineState(machineId);
  const lease = readSlotOperatorLease(machineId);
  if (lease?.sessionId === operatorSessionId
    && state?.phase !== 'spinning'
    && !currentAcceptedRound(machineId)) {
    clearSlotOperatorLease(machineId);
  }
}

/**
 * Auto operation is deed-holder gated by World and independently session-
 * leased here. Two tabs with the same identity converge on one Yjs lease;
 * only its winning browser may reserve or settle this machine.
 */
export function tickAutoSlotMachine(machineId: string): void {
  if (!canRunCroupier()) {
    stopAutoSlotMachine(machineId);
    return;
  }
  const playerId = getPlayerId();
  const now = Date.now();
  const configuredFunding = readSlotFundingConfig(machineId);
  if (configuredFunding?.ownerId !== playerId) {
    stopAutoSlotMachine(machineId);
    return;
  }

  let operator = autoOperators.get(machineId);
  const lease = readSlotOperatorLease(machineId);
  if (!operator
    || operator.docEpoch !== casinoDocEpoch()
    || operator.playerId !== playerId) {
    if (lease && lease.expiresAt > now && lease.sessionId !== operatorSessionId) return;
    writeSlotOperatorLease(machineId, {
      playerId,
      sessionId: operatorSessionId,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator = {
      docEpoch: casinoDocEpoch(),
      playerId,
      readyAt: now + OPERATOR_LEASE_SETTLE_MS,
      renewedAt: now,
    };
    autoOperators.set(machineId, operator);
    return;
  }

  if (lease?.playerId !== playerId
    || lease.sessionId !== operatorSessionId
    || lease.expiresAt <= now) {
    autoOperators.delete(machineId);
    return;
  }
  if (now - operator.renewedAt >= OPERATOR_LEASE_RENEW_MS) {
    writeSlotOperatorLease(machineId, {
      playerId,
      sessionId: operatorSessionId,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  if (now < operator.readyAt) return;
  tickSlotMachine(machineId, playerId);
}

export function setManualSlotMachineRunning(
  machineId: string,
  playerId: string,
  running: boolean,
): boolean {
  if (!running) {
    if (accepting.has(machineId)
      || currentAcceptedRound(machineId)
      || readSlotMachineState(machineId)?.phase === 'spinning') return false;
    if (manualOperators.get(machineId)?.playerId === playerId) {
      manualOperators.delete(machineId);
    }
    const lease = readSlotOperatorLease(machineId);
    if (lease?.sessionId === operatorSessionId) clearSlotOperatorLease(machineId);
    return true;
  }
  if (readSlotFundingConfig(machineId)?.ownerId !== playerId) return false;
  const now = Date.now();
  const lease = readSlotOperatorLease(machineId);
  if (lease && lease.expiresAt > now && lease.sessionId !== operatorSessionId) return false;
  writeSlotOperatorLease(machineId, {
    playerId,
    sessionId: operatorSessionId,
    expiresAt: now + OPERATOR_LEASE_MS,
  });
  manualOperators.set(machineId, {
    docEpoch: casinoDocEpoch(),
    playerId,
    readyAt: now + OPERATOR_LEASE_SETTLE_MS,
    renewedAt: now,
  });
  return true;
}

export function isManualSlotMachineRunning(machineId: string, playerId: string): boolean {
  const operator = manualOperators.get(machineId);
  return operator?.docEpoch === casinoDocEpoch()
    && operator.playerId === playerId
    && ownsOperatorLease(machineId, playerId)
    && readSlotFundingConfig(machineId)?.ownerId === playerId;
}

export function tickManualSlotMachine(machineId: string, authorized: boolean): void {
  const operator = manualOperators.get(machineId);
  if (!operator) return;
  const now = Date.now();
  const lease = readSlotOperatorLease(machineId);
  const state = readSlotMachineState(machineId);
  if (!authorized
    || operator.docEpoch !== casinoDocEpoch()
    || lease?.playerId !== operator.playerId
    || lease.sessionId !== operatorSessionId
    || lease.expiresAt <= now) {
    if (currentAcceptedRound(machineId) || state?.phase === 'spinning') {
      runTerminal(machineId, 'operator-loss refund', () =>
        cancelForHouseCommit(machineId, state));
    }
    manualOperators.delete(machineId);
    return;
  }
  const { playerId } = operator;
  const funding = state?.phase === 'spinning'
    ? state.funding
    : readSlotFundingConfig(machineId);
  if (funding?.ownerId !== playerId) {
    if (state?.phase === 'spinning') {
      runTerminal(machineId, 'funding-change refund', () =>
        cancelForHouseCommit(machineId, state));
    }
    manualOperators.delete(machineId);
    return;
  }
  if (now - operator.renewedAt >= OPERATOR_LEASE_RENEW_MS) {
    writeSlotOperatorLease(machineId, {
      playerId,
      sessionId: operatorSessionId,
      expiresAt: now + OPERATOR_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  if (now < operator.readyAt) return;
  tickSlotMachine(machineId, playerId);
}

function tickSlotMachine(machineId: string, operatorId?: string): void {
  if (settling.has(machineId) || accepting.has(machineId)) return;
  const state = readSlotMachineState(machineId);
  const activeAccepted = currentAcceptedRound(machineId);
  if (activeAccepted
    && (state?.phase !== 'spinning'
      || state.requestId !== activeAccepted.requestId
      || state.player !== activeAccepted.player)) {
    runTerminal(machineId, 'state-change refund', () =>
      cancelForHouseCommit(machineId, state));
    return;
  }
  if (operatorId) {
    const configuredFunding = readSlotFundingConfig(machineId);
    if (configuredFunding?.ownerId !== operatorId) return;
    if (state?.phase === 'spinning' && state.funding?.ownerId !== operatorId) {
      runTerminal(machineId, 'funding-owner transfer refund', () =>
        cancelForHouseCommit(machineId, state));
      return;
    }
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
        cancelForHouseCommit(machineId, state));
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
          settleRevealTimeout(machineId, state, accepted));
      }
      return;
    }
    if (Date.now() - accepted.acceptedAt < SLOT_SPIN_MS) return;
    runTerminal(machineId, 'settle', () =>
      settle(machineId, state, reveal.seed, accepted));
    return;
  }

  const now = Date.now();
  const docEpoch = casinoDocEpoch();
  const lastPoll = requestPolls.get(machineId);
  if (lastPoll?.docEpoch === docEpoch && now - lastPoll.checkedAt < REQUEST_POLL_MS) return;
  requestPolls.set(machineId, { docEpoch, checkedAt: now });
  const request = readSlotPlayRequests(machineId)[0];
  if (!request) return;
  if (request.requestedAt > now + SLOT_REQUEST_FUTURE_SKEW_MS
    || now - request.requestedAt > SLOT_REQUEST_TTL_MS) {
    clearSlotPlayRequest(machineId, request.player);
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
  accept(machineId, state, request, operatorId)
    .catch((err) => console.error('[slots] accept failed:', err))
    .finally(() => accepting.delete(machineId));
}

async function settleRevealTimeout(
  machineId: string,
  state: SlotMachineState,
  accepted: AcceptedSlotRound,
): Promise<void> {
  const token = accepted.sharedLeaseToken ?? undefined;
  if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return;
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
): Promise<void> {
  const accepted = currentAcceptedRound(machineId);
  if (state?.player) clearSlotReveal(machineId, state.player);
  const player = accepted?.player ?? state?.player;
  const bet = accepted?.bet ?? state?.bet;
  const funding = accepted?.funding ?? state?.funding;
  const sharedLeaseToken = sharedFundingLeaseToken(
    machineId,
    funding,
    accepted,
    state?.sharedLeaseToken,
  );
  if (player && bet && funding) {
    if (!await ensureTerminalFundingLease(
      machineId,
      funding,
      sharedLeaseToken,
    )) return;
    if (!refundSlotWager(
      machineId,
      player,
      bet,
      funding,
      sharedLeaseToken,
    )) return;
  }
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
  operatorId?: string,
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
    || (operatorId && (!ownsOperatorLease(machineId, operatorId)
      || readSlotFundingConfig(machineId)?.ownerId !== operatorId))) return;
  const funding = readSlotFundingConfig(machineId);
  if (!funding) return;
  const sharedLeaseToken = funding.mode === 'shared'
    ? `${operatorSessionId}:${machineId}:${request.requestId}`
    : null;
  if (sharedLeaseToken
    && !await acquireSlotSharedBankrollLease(machineId, sharedLeaseToken)) return;
  const leaseQueued = readSlotPlayRequests(machineId)
    .find((candidate) => candidate.player === request.player);
  const leaseCurrent = readSlotMachineState(machineId);
  const leaseFunding = readSlotFundingConfig(machineId);
  if (docEpoch !== casinoDocEpoch()
    || leaseQueued?.requestId !== request.requestId
    || leaseCurrent?.phase === 'spinning'
    || leaseFunding?.mode !== funding.mode
    || leaseFunding.ownerId !== funding.ownerId
    || (operatorId && (!ownsOperatorLease(machineId, operatorId)
      || leaseFunding.ownerId !== operatorId))) {
    if (sharedLeaseToken) releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
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
    || (operatorId && (!ownsOperatorLease(machineId, operatorId)
      || postHashFunding.ownerId !== operatorId))) {
    if (sharedLeaseToken) releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
    return;
  }
  const round = (postHashState?.round ?? state?.round ?? 0) + 1;
  if (paytableHash !== request.paytableHash
    || latestPaytableHash !== paytableHash) {
    clearSlotPlayRequest(machineId, request.player);
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
    if (sharedLeaseToken) releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
    return;
  }
  clearSlotPlayRequest(machineId, request.player);
  const reserve = reserveSlotWager(
    machineId,
    request.player,
    request.bet,
    funding,
    Math.max(request.bet, maxSlotPayout(request.bet, paytable)),
    sharedLeaseToken ?? undefined,
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
    if (sharedLeaseToken) releaseSlotSharedBankrollLease(machineId, sharedLeaseToken);
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
    sharedLeaseToken,
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
    sharedLeaseToken,
    fairness: { mode: 'commit-reveal', commits: [request.playerCommit, houseCommit] },
  });
}

async function settle(
  machineId: string,
  state: SlotMachineState,
  playerSeed: string,
  accepted: AcceptedSlotRound,
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
    await cancelForHouseCommit(machineId, state);
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
    await cancelForHouseCommit(machineId, state);
    return;
  }
  const token = accepted.sharedLeaseToken ?? undefined;
  if (!await ensureTerminalFundingLease(machineId, accepted.funding, token)) return;
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
  manualOperators.delete(machineId);
  autoOperators.delete(machineId);
  requestPolls.delete(machineId);
  const lease = readSlotOperatorLease(machineId);
  if (lease?.sessionId === operatorSessionId) clearSlotOperatorLease(machineId);
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
