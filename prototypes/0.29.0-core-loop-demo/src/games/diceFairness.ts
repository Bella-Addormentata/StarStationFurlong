/**
 * 🎲🔀 Dice FAIRNESS MODES (#69 G5b) — the switchable strategies for producing a
 * craps table's dice, all coexisting in the dev phase so we can flip between them
 * with a variable (`setCrapsFairnessMode` / the per-table casinoDoc pref).
 *
 * FOUR MODES, from fastest/least-proven to slowest/most-trustless:
 *   • rng           — crypto random. Instant, but UNVERIFIABLE (trust the operator).
 *   • commit-reveal — house + the SHOOTER each commit then reveal a seed; dice =
 *                     combine(both). Instant, off-chain, diegetic (the shooter
 *                     really makes the roll). Fair UNLESS house + shooter collude.
 *   • multiparty    — every bettor contributes a committed seed. Collusion-
 *                     resistant (≥1 honest suffices), but liveness-fragile (a
 *                     non-revealer stalls; the last revealer can grief) — needs
 *                     timeouts/bonds when wired for real.
 *   • block-beacon  — house commit + a Chia block hash (games/fairDice.ts). No
 *                     collusion vector, but ~1 block slow (see the plan §latency).
 *
 * This module is the mode LOGIC (pure crypto, browser + node testable). The live
 * wiring lives in crapsBackend.ts. In the dev phase the commit-reveal/multiparty
 * "other party" seeds and the block-beacon block hash are SIMULATED locally when
 * real ones aren't supplied (`simulated:true` in the transcript): the scheme runs
 * and verifies end-to-end, but the TRUST property (independent parties / a real
 * chain beacon) only becomes real once the network/chain half is wired.
 */

import {
  commitToSeed,
  deriveDice,
  diceFromMaterial,
  randomSeedHex,
  verifyRoll,
} from './fairDice';
import type { FairnessMode, FairnessTranscript } from './craps';

export type { FairnessMode, FairnessTranscript };

export interface FairnessModeInfo {
  mode: FairnessMode;
  label: string;
  /** No block wait — resolves as fast as the operator can hash. */
  instant: boolean;
  /** Needs a second party's live entropy (real fairness) — simulated in dev. */
  needsSecondParty: boolean;
  /** Needs chain access for the beacon. */
  needsChain: boolean;
  blurb: string;
}

export const FAIRNESS_MODES: Record<FairnessMode, FairnessModeInfo> = {
  rng: {
    mode: 'rng',
    label: 'RNG (no proof)',
    instant: true,
    needsSecondParty: false,
    needsChain: false,
    blurb: 'crypto random — fast, but unverifiable (trust the operator)',
  },
  'commit-reveal': {
    mode: 'commit-reveal',
    label: 'Commit-reveal · house + shooter',
    instant: true,
    needsSecondParty: true,
    needsChain: false,
    blurb: 'house + shooter each commit then reveal — instant, fair unless they collude',
  },
  multiparty: {
    mode: 'multiparty',
    label: 'Multiparty commit-reveal',
    instant: true,
    needsSecondParty: true,
    needsChain: false,
    blurb: 'every bettor adds entropy — collusion-resistant, but liveness-fragile',
  },
  'block-beacon': {
    mode: 'block-beacon',
    label: 'Block beacon (Chia)',
    instant: false,
    needsSecondParty: false,
    needsChain: true,
    blurb: 'house commit + a Chia block hash — no collusion vector, but ~1 block slow',
  },
};

/** Sync unbiased die 1–6 (the 'rng' mode). */
function rngDie(): number {
  const b = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0] < 4294967292) return (b[0] % 6) + 1;
  }
}

/** Combine N committed-then-revealed seeds into the shared dice. Order-independent
 *  (seeds sorted) so every client derives the same result. commit-reveal = 2 seeds
 *  (house + shooter); multiparty = N. */
export function combineSeeds(
  seeds: string[],
  table: string,
  round: number,
): Promise<[number, number]> {
  const ordered = [...seeds].sort();
  return diceFromMaterial(`ssf-craps-combine-v1|${ordered.join('|')}|${table}|${round}`);
}

export interface ProduceOpts {
  /** commit-reveal / multiparty: the parties' REAL seeds (absent ⇒ dev-simulated). */
  partySeeds?: string[];
  /** multiparty simulated party count (default 3). */
  simulatedParties?: number;
  /** block-beacon: REAL house seed + block hash (absent ⇒ dev-simulated). */
  houseSeed?: string;
  beacon?: string;
}

/** Operator-side roll production for `mode` → dice + (for the proven modes) a
 *  verifiable transcript. Missing real entropy is simulated locally in dev
 *  (`simulated:true`). */
export async function produceRoll(
  mode: FairnessMode,
  table: string,
  round: number,
  opts: ProduceOpts = {},
): Promise<{ dice: [number, number]; transcript?: FairnessTranscript }> {
  if (mode === 'rng') {
    return { dice: [rngDie(), rngDie()] };
  }
  if (mode === 'block-beacon') {
    const seed = opts.houseSeed ?? randomSeedHex();
    const beacon = opts.beacon ?? '00'.repeat(32); // dev placeholder — real header_hash later
    const dice = await deriveDice(seed, beacon, table, round);
    return {
      dice,
      transcript: {
        mode,
        commits: [await commitToSeed(seed)],
        seeds: [seed],
        beacon,
        simulated: opts.beacon == null,
      },
    };
  }
  // commit-reveal (2 parties) / multiparty (N)
  const n = mode === 'multiparty' ? opts.simulatedParties ?? 3 : 2;
  const seeds = opts.partySeeds ?? Array.from({ length: n }, () => randomSeedHex());
  const commits = await Promise.all(seeds.map(commitToSeed));
  const dice = await combineSeeds(seeds, table, round);
  return { dice, transcript: { mode, commits, seeds, simulated: opts.partySeeds == null } };
}

/** Verify a settled roll's dice against its transcript (any mode; 'rng' has no
 *  proof → false). Runnable by anyone from the public settled state. */
export async function verifyTranscript(
  t: FairnessTranscript,
  table: string,
  round: number,
  dice: [number, number],
): Promise<boolean> {
  if (t.mode === 'rng') return false;
  if (t.mode === 'block-beacon') {
    const seed = t.seeds?.[0];
    const commit = t.commits?.[0];
    const beacon = t.beacon;
    if (seed == null || commit == null || beacon == null) return false;
    return verifyRoll(commit, seed, beacon, table, round, dice);
  }
  // commit-reveal / multiparty: every seed must match one commit, dice must combine.
  const { commits, seeds } = t;
  if (!commits || !seeds || commits.length !== seeds.length || seeds.length === 0) {
    return false;
  }
  const need = [...commits];
  for (const s of seeds) {
    const idx = need.indexOf(await commitToSeed(s));
    if (idx < 0) return false;
    need.splice(idx, 1);
  }
  const [d1, d2] = await combineSeeds(seeds, table, round);
  return d1 === dice[0] && d2 === dice[1];
}

// ── The switchable mode variable (dev phase: all modes coexist) ───────────────

/** Global default fairness mode — flip it here, via `setCrapsFairnessMode`, or
 *  per-table (casinoDoc pref). 'rng' preserves today's instant, unproven roll. */
let currentMode: FairnessMode = 'rng';

export function getCrapsFairnessMode(): FairnessMode {
  return currentMode;
}

export function setCrapsFairnessMode(mode: FairnessMode): void {
  currentMode = mode;
}

// Debug/audit handle — flip the mode + verify transcripts from the console.
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfCrapsFairness: unknown }).__ssfCrapsFairness = {
    FAIRNESS_MODES,
    produceRoll,
    verifyTranscript,
    combineSeeds,
    getCrapsFairnessMode,
    setCrapsFairnessMode,
  };
}
