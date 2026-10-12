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
 *                     resistant (≥1 honest suffices). ⚖️ The DEFAULT, and LIVE:
 *                     the house + bettors' real seeds (fairTableSeeds.ts); a
 *                     non-revealer is timed out and forfeits their bets.
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
  pocketFromMaterial,
  randomSeedHex,
  verifyRoll,
} from './fairDice';
import { HOUSE_PARTY } from './craps';
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
    label: 'Fair · everyone adds a seed',
    instant: true,
    needsSecondParty: true,
    needsChain: false,
    blurb: 'the house and every bettor commit a secret seed; the result mixes them all, so nobody can steer it alone',
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
  room = '',
): Promise<boolean> {
  if (t.mode === 'rng') return false;
  if (t.parties) return verifyParties(t, 'craps', table, round, { dice }, room);
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

// ── ⚖️ LIVE multiparty: the Fair-by-default craps + roulette settle ─────────
//
// The house commits a seed when a betting window opens; each bettor's client
// commits its own seed alongside its chips; "no more bets" freezes the commit
// set; everyone reveals; the result mixes every revealed seed. A party that
// committed but never revealed keeps an EMPTY seed in the transcript (their
// bets are forfeited by the settle, so withholding costs them their stake) and
// the result comes from the rest. The live wiring is fairTableSeeds.ts.

export type TableGame = 'craps' | 'roulette';

/** One party's contribution to a round: its commit, and its seed once
 *  revealed (null = never revealed). */
export interface RoundParty {
  id: string;
  commit: string;
  seed: string | null;
}

/** Order-independent roulette counterpart of `combineSeeds`. */
export function combinePocketSeeds(seeds: string[], table: string, round: number): Promise<number> {
  const ordered = [...seeds].sort();
  return pocketFromMaterial(`ssf-roulette-combine-v1|${ordered.join('|')}|${table}|${round}`);
}

/** Who a table-seed commitment belongs to, and where: the room, the table, the round,
 *  the party ('house' or a player id) and — for a bettor — the house commit
 *  it answers ('' for the house's own). Hashed into the commitment, so a seed
 *  revealed in one round can never be replayed as fresh entropy in another,
 *  by another party, or against another house commit. */
export interface TableSeedContext {
  /** The room's stable id (furniture ids are only room-local, so a table id
   *  and round can recur in another room). '' offline. */
  room?: string;
  table: string;
  round: number;
  party: string;
  house: string;
}

/** The exact message a table-seed commitment hashes. */
export function tableCommitMessage(seed: string, ctx: TableSeedContext): string {
  return `ssf-table-commit-v3|${ctx.room ?? ''}|${ctx.table}|${ctx.round}|${ctx.party}|${ctx.house}|${seed}`;
}

/** A table seed's commitment (async SubtleCrypto; fairTableSeeds has the
 *  sync twin for the live exchange). */
export async function commitTableSeed(seed: string, ctx: TableSeedContext): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tableCommitMessage(seed, ctx)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mix the revealed seeds of `parties` into the round's outcome and its public
 *  transcript. null when NOBODY revealed (no verifiable material at all — the
 *  caller falls back to an unproven roll). */
export async function settleParties(
  game: TableGame,
  parties: RoundParty[],
  table: string,
  round: number,
): Promise<{ dice?: [number, number]; pocket?: number; transcript: FairnessTranscript } | null> {
  const seeds = parties.flatMap((p) => (p.seed ? [p.seed] : []));
  if (seeds.length === 0) return null;
  const transcript: FairnessTranscript = {
    mode: 'multiparty',
    parties: parties.map((p) => p.id),
    commits: parties.map((p) => p.commit),
    seeds: parties.map((p) => p.seed ?? ''),
  };
  return game === 'craps'
    ? { dice: await combineSeeds(seeds, table, round), transcript }
    : { pocket: await combinePocketSeeds(seeds, table, round), transcript };
}

/** Check a live multiparty transcript: every revealed seed opens its commit,
 *  and the outcome is the mix of exactly those seeds. Says nothing about
 *  WHICH commits belonged in the round — the caller compares the parties
 *  against the table's frozen commit set (fairTableSeeds.verifySettledRound). */
export async function verifyParties(
  t: FairnessTranscript,
  game: TableGame,
  table: string,
  round: number,
  outcome: { dice?: [number, number]; pocket?: number },
  room = '',
): Promise<boolean> {
  const { parties, commits, seeds } = t;
  if (t.mode !== 'multiparty' || !parties || !commits || !seeds) return false;
  if (parties.length !== commits.length || parties.length !== seeds.length) return false;
  if (parties[0] !== HOUSE_PARTY || new Set(parties).size !== parties.length) return false;
  const revealed: string[] = [];
  for (let i = 0; i < parties.length; i++) {
    if (seeds[i] === '') continue;
    const ctx = { room, table, round, party: parties[i], house: i === 0 ? '' : commits[0] };
    if ((await commitTableSeed(seeds[i], ctx)) !== commits[i]) return false;
    revealed.push(seeds[i]);
  }
  if (revealed.length === 0) return false;
  if (game === 'craps') {
    if (!outcome.dice) return false;
    const [d1, d2] = await combineSeeds(revealed, table, round);
    return d1 === outcome.dice[0] && d2 === outcome.dice[1];
  }
  return outcome.pocket === await combinePocketSeeds(revealed, table, round);
}

// ── The switchable mode variable (dev phase: all modes coexist) ───────────────

/** Global default fairness mode — flip it here, via `setCrapsFairnessMode`, or
 *  per-table (casinoDoc pref). ⚖️ 'multiparty' = Fair by default: the house and
 *  the bettors' real seeds settle every craps roll and roulette spin. */
let currentMode: FairnessMode = 'multiparty';

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
