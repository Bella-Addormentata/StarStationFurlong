/**
 * 🎲🔗 Craps SETTLEMENT BACKENDS (#69 G5 seam) — the on/off seam that lets a
 * craps table settle EITHER locally (crypto RNG + room-doc chips, the default)
 * OR on an optional Chia gaming backend (per-player↔house state channels sharing
 * one fair beacon-anchored dice), with NO change to gameplay or in-world things.
 *
 * WHY THIS EXISTS (see brainstorming/craps-chia-backend-plan.md):
 *   Bank craps is N independent player-vs-house wagers that share ONE dice draw.
 *   The presentation (felt, dice, chips, stands, robot stickman, narration) only
 *   ever reads the SYNCED TABLE STATE (dice + point + payouts). Both backends
 *   produce that same state, so swapping them changes only WHERE the roll comes
 *   from and HOW the wager settles — the in-world game is identical. That is the
 *   whole point: the seam sits BELOW the presentation.
 *
 * WHAT'S BUILT NOW vs LATER:
 *   • LocalCrapsBackend — the shipped behaviour, verbatim. The default; always
 *     available. This is the golden payout spec (resolveCrapsRound).
 *   • ChiaCrapsBackend — a STUB. isAvailable() is false until the node wallet
 *     (spike B-7) + chia-gaming are wired, so the selector transparently falls
 *     back to local. Its rollAndSettle documents the eventual flow but throws if
 *     ever reached, so a half-wired build fails loud instead of silently
 *     mis-settling real wagers.
 *
 * The selector reads the owner-set per-table preference (casinoDoc
 * `cfg:backend:<tableId>`); a table is safe to flip to 'chia' today — it simply
 * keeps playing on local until the stub is filled in.
 */

import {
  creditChips,
  readAllCrapsBets,
  readCrapsBackendPref,
  writeCrapsTableState,
  writeMyCrapsBets,
} from './casinoDoc';
import type { CrapsBackendKind } from './casinoDoc';
import { nextPoint, resolveCrapsRound } from './games/craps';

export type { CrapsBackendKind };

export interface CrapsBackend {
  readonly kind: CrapsBackendKind;
  /** Human label for the settlement toggle. */
  readonly label: string;
  /** Usable right now? Local: always. Chia: false until the node wallet +
   *  chia-gaming are wired — the selector falls back to local when false. */
  isAvailable(): boolean;
  /**
   * Produce the roll, resolve every player's wagers, publish the settled table
   * state, credit winners, and prune each felt. Same contract as the shipped
   * rollAndSettleCraps: `autoShowMs` set ⇒ auto-open the next window on a timer;
   * absent ⇒ the manual house clicks NEXT ROLL. Returns the two dice.
   */
  rollAndSettle(
    tableId: string,
    round: number,
    pointBefore: number | null,
    autoShowMs?: number,
  ): [number, number];
}

// ── Local backend — crypto RNG + room-doc chips (the shipped behaviour) ───────

/** One fair die 1–6 via rejection sampling (no modulo bias). */
function rollDie(): number {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294967292) return (buf[0] % 6) + 1; // floor(2^32/6)*6
  }
}

class LocalCrapsBackend implements CrapsBackend {
  readonly kind = 'local' as const;
  readonly label = 'Local (play chips)';

  isAvailable(): boolean {
    return true;
  }

  rollAndSettle(
    tableId: string,
    round: number,
    pointBefore: number | null,
    autoShowMs?: number,
  ): [number, number] {
    const d1 = rollDie();
    const d2 = rollDie();
    const sum = d1 + d2;
    const { payouts, remaining } = resolveCrapsRound(
      readAllCrapsBets(tableId),
      d1,
      d2,
      pointBefore,
    );
    const now = Date.now();
    writeCrapsTableState(tableId, {
      kind: 'craps',
      phase: 'settled',
      round,
      point: nextPoint(pointBefore, sum),
      dice: [d1, d2],
      result: sum,
      resultAt: now,
      payouts,
      ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
    });
    for (const [pid, amount] of Object.entries(payouts)) creditChips(pid, amount);
    // Prune the felt: rewrite each player's list to only the bets that survived
    // (standing pass/place). Empty ⇒ their felt clears.
    for (const [pid, bets] of Object.entries(remaining)) {
      writeMyCrapsBets(tableId, pid, bets);
    }
    return [d1, d2];
  }
}

// ── Chia backend — per-player↔house channels + shared beacon dice (STUB) ──────

/** Wired later: the node exposes a chia-gaming bridge here once B-7 lands. Until
 *  then it is absent, so ChiaCrapsBackend.isAvailable() is false. */
interface ChiaGamingBridge {
  ready: boolean;
}
function chiaBridge(): ChiaGamingBridge | null {
  const b = (window as unknown as { __ssfChiaGaming?: ChiaGamingBridge })
    .__ssfChiaGaming;
  return b && b.ready === true ? b : null;
}

class ChiaCrapsBackend implements CrapsBackend {
  readonly kind = 'chia' as const;
  readonly label = 'Chia (testnet · coming soon)';

  isAvailable(): boolean {
    return chiaBridge() !== null;
  }

  rollAndSettle(): [number, number] {
    // Eventual flow (brainstorming/craps-chia-backend-plan.md §3–§4):
    //   1. Reveal the house seed committed at roll-open; combine with the target
    //      block hash beacon → the shared dice (identical for every channel).
    //   2. For each funded player↔house channel, apply the craps payout
    //      (resolveCrapsBet — the SAME math the referee puzzle enforces) as a
    //      signed off-chain state update; disputes/timeouts resolve on-chain.
    //   3. Publish the settled table state (dice/point/payouts) so the UNCHANGED
    //      presentation renders it exactly like the local backend.
    // Guarded by isAvailable() in the selector, so this never runs half-wired —
    // fail loud rather than silently mis-settle real wagers.
    throw new Error(
      '[craps] chia backend not wired yet (#69 G6) — this call should have ' +
        'fallen back to local via selectCrapsBackend; see ' +
        'brainstorming/craps-chia-backend-plan.md',
    );
  }
}

// ── Registry + selector ───────────────────────────────────────────────────────

const REGISTRY: Record<CrapsBackendKind, CrapsBackend> = {
  local: new LocalCrapsBackend(),
  chia: new ChiaCrapsBackend(),
};

/** Every registered backend (for the settlement toggle UI). */
export function crapsBackends(): CrapsBackend[] {
  return [REGISTRY.local, REGISTRY.chia];
}

export function crapsBackend(kind: CrapsBackendKind): CrapsBackend {
  return REGISTRY[kind] ?? REGISTRY.local;
}

/**
 * The backend that settles THIS table right now: the owner-set per-table
 * preference, or local if that backend is unavailable (e.g. 'chia' before the
 * node wallet is wired). Callers never see an unavailable backend — a table set
 * to 'chia' keeps playing on local, safely, until the stub is filled in.
 */
export function selectCrapsBackend(tableId: string): CrapsBackend {
  const pref = readCrapsBackendPref(tableId);
  const chosen = REGISTRY[pref] ?? REGISTRY.local;
  if (chosen.isAvailable()) return chosen;
  if (pref !== 'local') {
    console.warn(
      `[craps] settlement backend '${pref}' unavailable on table ${tableId} — ` +
        'falling back to local',
    );
  }
  return REGISTRY.local;
}

// Debug handle (the __ssfCasino precedent): inspect/select backends from the
// console without UI plumbing.
(window as unknown as { __ssfCrapsBackend: unknown }).__ssfCrapsBackend = {
  crapsBackends,
  selectCrapsBackend,
};
