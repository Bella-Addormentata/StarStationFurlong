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
  casinoDocEpoch,
  creditChips,
  readAllCrapsBets,
  readCrapsBackendPref,
  readCrapsFairnessPref,
  readCrapsTableState,
  writeCrapsTableState,
  writeMyCrapsBets,
} from './casinoDoc';
import type { CrapsBackendKind } from './casinoDoc';
import { nextPoint, resolveCrapsRound, shooterHandOver } from './games/craps';
// 🎲🔀 The dice-fairness mode drives HOW the roll is produced (rng / commit-reveal
// / multiparty / block-beacon) — switchable per table; see games/diceFairness.ts.
import { getCrapsFairnessMode, produceRoll, settleParties } from './games/diceFairness';
import type { FairnessTranscript } from './games/craps';
// ⚖️ Fair by default: the live multiparty seed exchange (house + bettors).
import { frozenFields, frozenWagers, gatherRound, settledRound } from './fairTableSeeds';

export type { CrapsBackendKind };

export interface CrapsBackend {
  readonly kind: CrapsBackendKind;
  /** Human label for the settlement toggle. */
  readonly label: string;
  /** Usable right now? Local: always. Chia: false until the node wallet +
   *  chia-gaming are wired — the selector falls back to local when false. */
  isAvailable(): boolean;
  /**
   * Produce the roll (via the table's fairness mode), resolve every player's
   * wagers, publish the settled table state, credit winners, and prune each felt.
   * `autoShowMs` set ⇒ auto-open the next window on a timer; absent ⇒ the manual
   * house clicks NEXT ROLL. ASYNC — the fairness modes hash (SubtleCrypto); the
   * dispatcher (crapsCroupier.rollAndSettleCraps) guards against re-entry.
   * Resolves null when nothing settled yet — a Fair table still waiting on its
   * bettors' reveals (the operator's tick simply calls again).
   */
  rollAndSettle(
    tableId: string,
    round: number,
    pointBefore: number | null,
    autoShowMs?: number,
  ): Promise<[number, number] | null>;
}

// ── Local backend — the selected fairness mode + room-doc chips ───────────────

class LocalCrapsBackend implements CrapsBackend {
  readonly kind = 'local' as const;
  readonly label = 'Local (play chips)';

  isAvailable(): boolean {
    return true;
  }

  async rollAndSettle(
    tableId: string,
    round: number,
    pointBefore: number | null,
    autoShowMs?: number,
  ): Promise<[number, number] | null> {
    // HOW the dice are produced is the table's fairness mode (rng / commit-reveal
    // / multiparty / block-beacon), per-table override or the global default.
    const closing = readCrapsTableState(tableId);
    // The mode locked in when this window opened (older records: the setting).
    const mode = closing?.fairMode ?? readCrapsFairnessPref(tableId) ?? getCrapsFairnessMode();
    const epoch = casinoDocEpoch();
    let dice: [number, number];
    let transcript: FairnessTranscript | undefined;
    let forfeited: string[] = [];
    // A roll opened Fair (it carries a house commit) settles Fair, whatever the
    // owner switched the table to since; the switch takes effect next window.
    if (closing?.houseCommit && closing.phase === 'closing' && closing.round === round) {
      // ⚖️ The live Fair roll: the house seed + every frozen bettor's reveal.
      const gathered = gatherRound(tableId, closing);
      if (!gathered) return null; // reveals still due
      forfeited = gathered.forfeited;
      if (!gathered.parties[0].seed) {
        // ⚖️ No house seed to reveal (this page lost it): having seen every
        // bettor's reveal, the house could pick between outcomes by settling
        // without its seed. The roll is void: no dice, every bet stands.
        const before = readCrapsTableState(tableId);
        if (casinoDocEpoch() !== epoch || before?.phase !== 'closing' || before.round !== round) return null;
        const now = Date.now();
        writeCrapsTableState(tableId, {
          kind: 'craps', phase: 'settled', round, point: pointBefore, dice: null, result: null,
          resultAt: now, payouts: {}, voided: true,
          ...(before.shooter !== undefined ? { shooter: before.shooter } : {}),
          ...(before.lastShooter !== undefined ? { lastShooter: before.lastShooter } : {}),
          ...(before.houseCommit !== undefined ? { houseCommit: before.houseCommit } : {}),
          ...frozenFields(tableId, before),
          ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
        });
        settledRound(tableId, before);
        return null;
      }
      const mixed = await settleParties('craps', gathered.parties, tableId, round);
      // Nobody revealed anything (no house seed on this device, no bettors):
      // an unproven roll, shown as such on the table card.
      ({ dice, transcript } = mixed?.dice
        ? { dice: mixed.dice, transcript: mixed.transcript }
        : await produceRoll('rng', tableId, round));
    } else {
      // Switched to Fair mid-window: no house commit to settle against, so
      // this one roll is plain RNG (and shows unproven).
      ({ dice, transcript } = await produceRoll(mode === 'multiparty' ? 'rng' : mode, tableId, round));
    }
    // The hashing yielded — the table may have been REMOVED meanwhile
    // (closeCrapsTable refunded every felt and wiped the table keys, #87
    // review). Writing now would resurrect the dead table's state and pay
    // out bets that were already refunded — abort instead.
    const before = readCrapsTableState(tableId);
    if (before == null) return dice;
    // 🎲 #226: or the room doc rebound / the table was recreated under the
    // same id: only settle the very roll this call was started for. Every
    // caller closes the table first, so a table back in 'betting' at the same
    // round is a recreated one, not this roll's.
    if (casinoDocEpoch() !== epoch || before.round !== round || before.phase !== 'closing') return dice;
    const [d1, d2] = dice;
    const sum = d1 + d2;
    // ⚖️ A bettor who committed but never revealed forfeits every bet on the
    // felt this roll — withholding a seed to dodge a result must cost them.
    // Only wagers frozen at "no more bets" settle: the reveals made the dice
    // computable, so a list rewritten since is void and cleared like a forfeit.
    const { bets: allBets, voided } = frozenWagers(tableId, before, readAllCrapsBets(tableId));
    forfeited = [...forfeited, ...voided];
    for (const pid of forfeited) delete allBets[pid];
    const { payouts, remaining } = resolveCrapsRound(
      allBets,
      d1,
      d2,
      pointBefore,
    );
    for (const pid of forfeited) remaining[pid] = [];
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
      sevenOut: shooterHandOver(pointBefore, sum),
      // 🎲 #226: the hand's shooter rides through the settle (the operator
      // passes the dice on when it opens the next window after a seven-out).
      ...(before.shooter !== undefined ? { shooter: before.shooter } : {}),
      ...(before.lastShooter !== undefined ? { lastShooter: before.lastShooter } : {}),
      ...(transcript ? { fairness: transcript } : {}),
      // ⚖️ The round's commitments stay on the settled record so anyone can
      // check the transcript against them.
      ...(before.houseCommit !== undefined ? { houseCommit: before.houseCommit } : {}),
      // The commits and wagers as this page froze them, not as the shared
      // state reads now (anyone can rewrite it after the reveals).
      ...frozenFields(tableId, before),
      ...(before.unseeded !== undefined ? { unseeded: before.unseeded } : {}),
      ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
    });
    settledRound(tableId, before);
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

  async rollAndSettle(
    _tableId: string,
    _round: number,
    _pointBefore: number | null,
    _autoShowMs?: number,
  ): Promise<[number, number] | null> {
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
