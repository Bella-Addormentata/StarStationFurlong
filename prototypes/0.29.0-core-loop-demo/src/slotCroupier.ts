import {
  clearSlotMachineKeys,
  clearSlotPlayRequest,
  clearSlotReveal,
  creditChips,
  readSlotMachineState,
  readSlotOddsConfig,
  readSlotPlayRequests,
  readSlotReveal,
  spendChips,
  writeSlotMachineState,
} from './casinoDoc';
import { canRunCroupier } from './croupier';
import {
  commitSlotSeed,
  DEFAULT_PAYTABLE,
  deriveReelStops,
  initialSlotMachineState,
  randomSlotSeed,
  resolveSlot,
  spinReels,
} from './games/slots';

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
        writeSlotMachineState(machineId, {
          ...state,
          phase: 'settled',
          credited: 0,
          settledAt: Date.now(),
        });
      }
      return;
    }
    settling.add(machineId);
    settle(machineId, state, reveal.seed)
      .catch((err) => console.error('[slots] settle failed:', err))
      .finally(() => settling.delete(machineId));
    return;
  }

  const request = readSlotPlayRequests(machineId)[0];
  if (!request) return;
  clearSlotPlayRequest(machineId, request.player);
  if (!spendChips(request.player, request.bet)) return;
  const round = (state?.round ?? 0) + 1;
  writeSlotMachineState(machineId, {
    ...initialSlotMachineState(),
    phase: 'spinning',
    round,
    player: request.player,
    bet: request.bet,
    requestId: request.requestId,
    houseSeed: randomSlotSeed(),
    acceptedAt: Date.now(),
    fairness: { mode: 'commit-reveal', commits: [request.playerCommit] },
  });
}

async function settle(
  machineId: string,
  state: NonNullable<ReturnType<typeof readSlotMachineState>>,
  playerSeed: string,
): Promise<void> {
  const playerCommit = state.fairness?.commits?.[0];
  if (!playerCommit || await commitSlotSeed(playerSeed) !== playerCommit) {
    clearSlotReveal(machineId, state.player!);
    return;
  }
  const houseSeed = state.houseSeed!;
  const seeds = await deriveReelStops(playerSeed, houseSeed, machineId, state.round);
  if (readSlotMachineState(machineId)?.requestId !== state.requestId) return;
  const result = spinReels(seeds);
  const resolution = resolveSlot(
    result,
    state.bet!,
    readSlotOddsConfig(machineId)?.paytable ?? DEFAULT_PAYTABLE,
  );
  const houseCommit = await commitSlotSeed(houseSeed);
  writeSlotMachineState(machineId, {
    ...state,
    phase: 'settled',
    seeds,
    result,
    credited: resolution.credited,
    settledAt: Date.now(),
    fairness: {
      mode: 'commit-reveal',
      commits: [playerCommit, houseCommit],
      seeds: [playerSeed, houseSeed],
    },
  });
  clearSlotReveal(machineId, state.player!);
  if (resolution.credited > 0) creditChips(state.player!, resolution.credited);
}

export function closeSlotMachine(machineId: string): void {
  if (canRunCroupier()) {
    const state = readSlotMachineState(machineId);
    if (state?.phase === 'spinning' && state.player && state.bet) {
      creditChips(state.player, state.bet);
    }
  }
  clearSlotMachineKeys(machineId);
}
