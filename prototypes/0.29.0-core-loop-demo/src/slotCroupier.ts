import {
  clearSlotMachineKeys,
  clearSlotPlayRequest,
  clearSlotReveal,
  drainSlotMachineFunding,
  readSlotFundingConfig,
  readSlotMachineState,
  readSlotOddsConfig,
  readSlotPlayRequests,
  readSlotReveal,
  refundSlotWager,
  reserveSlotWager,
  settleSlotWager,
  writeSlotFundingConfig,
  writeSlotMachineState,
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
import type { SlotFundingConfig, SlotMachineState } from './games/slots';
import { getPlayerId } from './identity';

const settling = new Set<string>();
const REVEAL_TIMEOUT_MS = 30_000;

export function tickSlotMachine(machineId: string): void {
  if (settling.has(machineId)) return;
  const state = readSlotMachineState(machineId);
  if (state?.phase === 'spinning') {
    const player = state.player;
    if (!player || !state.requestId || !state.houseSeed) return;
    const reveal = readSlotReveal(machineId, player);
    if (!reveal || reveal.requestId !== state.requestId) {
      if (Date.now() - state.acceptedAt >= REVEAL_TIMEOUT_MS) {
        clearSlotReveal(machineId, player);
        if (state.funding) settleSlotWager(machineId, player, state.funding, 0);
        writeSlotMachineState(machineId, {
          ...state,
          phase: 'settled',
          credited: 0,
          settledAt: Date.now(),
          failure: 'reveal-timeout',
        });
      }
      return;
    }
    if (Date.now() - state.acceptedAt < SLOT_SPIN_MS) return;
    settling.add(machineId);
    settle(machineId, state, reveal.seed)
      .catch((err) => console.error('[slots] settle failed:', err))
      .finally(() => settling.delete(machineId));
    return;
  }

  const request = readSlotPlayRequests(machineId)[0];
  if (!request) return;
  clearSlotPlayRequest(machineId, request.player);
  const round = (state?.round ?? 0) + 1;
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
    maxSlotPayout(request.bet, paytable),
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
  writeSlotMachineState(machineId, {
    ...initialSlotMachineState(),
    phase: 'spinning',
    round,
    player: request.player,
    bet: request.bet,
    requestId: request.requestId,
    houseSeed: randomSlotSeed(),
    acceptedAt: Date.now(),
    funding,
    paytable,
    fairness: { mode: 'commit-reveal', commits: [request.playerCommit] },
  });
}

async function settle(
  machineId: string,
  state: SlotMachineState,
  playerSeed: string,
): Promise<void> {
  const playerCommit = state.fairness?.commits?.[0];
  if (!playerCommit || await commitSlotSeed(playerSeed) !== playerCommit) {
    clearSlotReveal(machineId, state.player!);
    if (state.funding) settleSlotWager(machineId, state.player!, state.funding, 0);
    writeSlotMachineState(machineId, {
      ...state,
      phase: 'settled',
      credited: 0,
      settledAt: Date.now(),
      failure: 'invalid-reveal',
    });
    return;
  }
  const houseSeed = state.houseSeed!;
  const seeds = await deriveReelStops(playerSeed, houseSeed, machineId, state.round);
  if (readSlotMachineState(machineId)?.requestId !== state.requestId) return;
  const result = spinReels(seeds);
  const resolution = resolveSlot(
    result,
    state.bet!,
    state.paytable ?? DEFAULT_PAYTABLE,
  );
  const houseCommit = await commitSlotSeed(houseSeed);
  const current = readSlotMachineState(machineId);
  if (current?.phase !== 'spinning' || current.requestId !== state.requestId) return;
  const paid = state.funding
    ? settleSlotWager(machineId, state.player!, state.funding, resolution.credited)
    : false;
  if (!paid && state.funding) {
    settleSlotWager(machineId, state.player!, state.funding, 0);
  }
  writeSlotMachineState(machineId, {
    ...state,
    phase: 'settled',
    seeds,
    result,
    credited: paid ? resolution.credited : 0,
    settledAt: Date.now(),
    ...(paid ? {} : { failure: 'insufficient-bankroll' as const }),
    fairness: {
      mode: 'commit-reveal',
      commits: [playerCommit, houseCommit],
      seeds: [playerSeed, houseSeed],
    },
  });
  clearSlotReveal(machineId, state.player!);
}

export function closeSlotMachine(machineId: string): void {
  if (canRunCroupier()) {
    const state = readSlotMachineState(machineId);
    if (state?.phase === 'spinning' && state.player && state.bet && state.funding) {
      refundSlotWager(machineId, state.player, state.bet, state.funding);
    }
    drainSlotMachineFunding(machineId);
  }
  clearSlotMachineKeys(machineId);
}
