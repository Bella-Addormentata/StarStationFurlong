import {
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
  refundSlotWager,
  reserveSlotWager,
  settleSlotWager,
  writeSlotFundingConfig,
  writeSlotMachineState,
  writeSlotOperatorLease,
} from './casinoDoc';
import { canRunCroupier } from './croupier';
import {
  commitSlotSeed,
  DEFAULT_PAYTABLE,
  deriveReelStops,
  initialSlotMachineState,
  maxSlotPayout,
  randomSlotSeed,
  resolveSlot,
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
  paytable: SlotPayEntry[];
}

interface ManualSlotOperator {
  docEpoch: number;
  playerId: string;
  readyAt: number;
  renewedAt: number;
}

const settling = new Set<string>();
const accepting = new Set<string>();
const acceptedRounds = new Map<string, AcceptedSlotRound>();
const manualOperators = new Map<string, ManualSlotOperator>();
const REVEAL_TIMEOUT_MS = 30_000;
const MANUAL_LEASE_MS = 8_000;
const MANUAL_LEASE_SETTLE_MS = 2_000;
const MANUAL_LEASE_RENEW_MS = 3_000;
const manualSessionId = randomSlotSeed();

function currentAcceptedRound(machineId: string): AcceptedSlotRound | undefined {
  const accepted = acceptedRounds.get(machineId);
  if (accepted?.docEpoch === casinoDocEpoch()) return accepted;
  if (accepted) acceptedRounds.delete(machineId);
  return undefined;
}

function ownsManualLease(machineId: string, playerId: string): boolean {
  const lease = readSlotOperatorLease(machineId);
  return lease?.playerId === playerId
    && lease.sessionId === manualSessionId
    && lease.expiresAt > Date.now();
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
    if (lease?.sessionId === manualSessionId) clearSlotOperatorLease(machineId);
    return true;
  }
  if (readSlotFundingConfig(machineId)?.ownerId !== playerId) return false;
  const now = Date.now();
  const lease = readSlotOperatorLease(machineId);
  if (lease && lease.expiresAt > now && lease.sessionId !== manualSessionId) return false;
  writeSlotOperatorLease(machineId, {
    playerId,
    sessionId: manualSessionId,
    expiresAt: now + MANUAL_LEASE_MS,
  });
  manualOperators.set(machineId, {
    docEpoch: casinoDocEpoch(),
    playerId,
    readyAt: now + MANUAL_LEASE_SETTLE_MS,
    renewedAt: now,
  });
  return true;
}

export function isManualSlotMachineRunning(machineId: string, playerId: string): boolean {
  const operator = manualOperators.get(machineId);
  return operator?.docEpoch === casinoDocEpoch()
    && operator.playerId === playerId
    && ownsManualLease(machineId, playerId)
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
    || lease.sessionId !== manualSessionId
    || lease.expiresAt <= now) {
    if (currentAcceptedRound(machineId) || state?.phase === 'spinning') {
      cancelForHouseCommit(machineId, state);
    }
    manualOperators.delete(machineId);
    return;
  }
  const { playerId } = operator;
  const funding = state?.phase === 'spinning'
    ? state.funding
    : readSlotFundingConfig(machineId);
  if (funding?.ownerId !== playerId) {
    if (state?.phase === 'spinning') cancelForHouseCommit(machineId, state);
    manualOperators.delete(machineId);
    return;
  }
  if (now - operator.renewedAt >= MANUAL_LEASE_RENEW_MS) {
    writeSlotOperatorLease(machineId, {
      playerId,
      sessionId: manualSessionId,
      expiresAt: now + MANUAL_LEASE_MS,
    });
    operator.renewedAt = now;
  }
  if (now < operator.readyAt) return;
  tickSlotMachine(machineId, playerId);
}

export function tickSlotMachine(machineId: string, operatorId?: string): void {
  if (settling.has(machineId) || accepting.has(machineId)) return;
  const state = readSlotMachineState(machineId);
  const activeAccepted = currentAcceptedRound(machineId);
  if (activeAccepted
    && (state?.phase !== 'spinning'
      || state.requestId !== activeAccepted.requestId
      || state.player !== activeAccepted.player)) {
    cancelForHouseCommit(machineId, state);
    return;
  }
  if (operatorId) {
    const funding = state?.phase === 'spinning'
      ? state.funding
      : readSlotFundingConfig(machineId);
    if (funding?.ownerId !== operatorId) return;
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
      cancelForHouseCommit(machineId, state);
      return;
    }
    const reveal = readSlotReveal(machineId, player);
    if (reveal?.requestId === state.requestId && reveal.houseCommit !== houseCommit) {
      forfeitInvalidReveal(machineId, state, accepted);
      return;
    }
    if (!reveal || reveal.requestId !== state.requestId) {
      if (Date.now() - accepted.acceptedAt >= REVEAL_TIMEOUT_MS) {
        clearSlotReveal(machineId, player);
        settleSlotWager(machineId, player, accepted.funding, 0);
        writeSlotMachineState(machineId, {
          ...state,
          bet: accepted.bet,
          funding: accepted.funding,
          paytable: accepted.paytable,
          phase: 'settled',
          credited: 0,
          settledAt: Date.now(),
          failure: 'reveal-timeout',
        });
        acceptedRounds.delete(machineId);
      }
      return;
    }
    if (Date.now() - accepted.acceptedAt < SLOT_SPIN_MS) return;
    settling.add(machineId);
    settle(machineId, state, reveal.seed, accepted)
      .catch((err) => console.error('[slots] settle failed:', err))
      .finally(() => settling.delete(machineId));
    return;
  }

  const request = readSlotPlayRequests(machineId)[0];
  if (!request) return;
  accepting.add(machineId);
  accept(machineId, state, request, operatorId)
    .catch((err) => console.error('[slots] accept failed:', err))
    .finally(() => accepting.delete(machineId));
}

function cancelForHouseCommit(
  machineId: string,
  state: SlotMachineState | null,
): void {
  const accepted = currentAcceptedRound(machineId);
  if (state?.player) clearSlotReveal(machineId, state.player);
  const player = accepted?.player ?? state?.player;
  const bet = accepted?.bet ?? state?.bet;
  const funding = accepted?.funding ?? state?.funding;
  if (player && bet && funding) {
    refundSlotWager(machineId, player, bet, funding);
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
  });
  acceptedRounds.delete(machineId);
}

function forfeitInvalidReveal(
  machineId: string,
  state: SlotMachineState,
  accepted: AcceptedSlotRound,
): void {
  clearSlotReveal(machineId, accepted.player);
  settleSlotWager(machineId, accepted.player, accepted.funding, 0);
  writeSlotMachineState(machineId, {
    ...state,
    player: accepted.player,
    bet: accepted.bet,
    funding: accepted.funding,
    paytable: accepted.paytable,
    phase: 'settled',
    credited: 0,
    settledAt: Date.now(),
    failure: 'invalid-reveal',
  });
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
    || (operatorId && (!ownsManualLease(machineId, operatorId)
      || readSlotFundingConfig(machineId)?.ownerId !== operatorId))) return;
  clearSlotPlayRequest(machineId, request.player);
  const round = (current?.round ?? state?.round ?? 0) + 1;
  const ownerId = getPlayerId();
  const funding: SlotFundingConfig =
    readSlotFundingConfig(machineId) ?? { mode: 'owner', ownerId };
  if (!readSlotFundingConfig(machineId)) writeSlotFundingConfig(machineId, funding);
  const paytable = (readSlotOddsConfig(machineId)?.paytable ?? DEFAULT_PAYTABLE)
    .map((entry) => ({ ...entry, symbols: [...entry.symbols] as typeof entry.symbols }));
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
    cancelForHouseCommit(machineId, state);
    return;
  }
  if (actualPlayerCommit !== accepted.playerCommit) {
    forfeitInvalidReveal(machineId, state, accepted);
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
    cancelForHouseCommit(machineId, state);
    return;
  }
  const paid = settleSlotWager(
    machineId,
    accepted.player,
    accepted.funding,
    resolution.credited,
  );
  if (!paid) {
    settleSlotWager(machineId, accepted.player, accepted.funding, 0);
  }
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
    fairness: {
      mode: 'commit-reveal',
      commits: [accepted.playerCommit, accepted.houseCommit],
      seeds: [playerSeed, accepted.houseSeed],
    },
  });
  clearSlotReveal(machineId, accepted.player);
  acceptedRounds.delete(machineId);
}

export function closeSlotMachine(
  machineId: string,
  canManage = canRunCroupier(),
): void {
  manualOperators.delete(machineId);
  const lease = readSlotOperatorLease(machineId);
  if (lease?.sessionId === manualSessionId) clearSlotOperatorLease(machineId);
  if (!canManage) return;
  const state = readSlotMachineState(machineId);
  const accepted = currentAcceptedRound(machineId);
  let refunded = true;
  if (accepted) {
    refunded = refundSlotWager(
      machineId,
      accepted.player,
      accepted.bet,
      accepted.funding,
    );
  } else if (state?.phase === 'spinning' && state.player && state.bet && state.funding) {
    refunded = refundSlotWager(machineId, state.player, state.bet, state.funding);
  }
  if (!refunded) return;
  acceptedRounds.delete(machineId);
  drainSlotMachineFunding(machineId);
  clearSlotMachineKeys(machineId);
}
