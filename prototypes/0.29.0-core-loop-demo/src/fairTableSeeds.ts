/**
 * ⚖️ Fair tables — the LIVE seed exchange behind Fair-by-default craps and
 * roulette (multiparty commit-reveal, games/diceFairness.ts).
 *
 * ONE ROUND, START TO FINISH:
 *   1. OPEN. The house (whoever opens the betting window — the elected
 *      operator, or the house's NEXT ROLL / NEW ROUND press) picks a secret
 *      seed and writes only its commitment, `houseCommit`, on the table state.
 *   2. BET. Every client with chips on the felt this round commits a secret
 *      seed of its own (`fseed:<table>:<pid>`, bound to the round and the house
 *      commit). Players never see or type any of this.
 *   3. NO MORE BETS. The closing write FREEZES the commit set (`commits` on the
 *      table state): only those parties count, so nobody can join after seeing
 *      someone else's seed.
 *   4. REVEAL. Each frozen party's client writes its seed back into its record.
 *   5. SETTLE. The operator waits for the reveals (up to REVEAL_GRACE_MS),
 *      reveals the house seed, and mixes every revealed seed into the dice /
 *      pocket. The transcript rides on the settled state, so anyone can re-check
 *      it (verifySettledRound).
 *
 * WHAT IT GUARANTEES: the house committed before seeing any bettor's seed, and
 * each bettor committed before seeing anyone else's, so no single party — the
 * room owner included — can steer the result. The one lever left is to
 * withhold a reveal after seeing the others (the last revealer can pick between
 * two outcomes). A bettor who withholds FORFEITS every bet on the table that
 * roll; the house withholding (or losing its seed to a reload on another
 * device) is flagged on the table card. A forfeited party whose reveal IS in
 * the room doc is flagged too — the operator must not drop a seed it saw.
 *
 * Seeds survive a reload in localStorage (keyed by commitment), so a refreshed
 * page can still reveal. Each commitment is bound to its table, round, party
 * and (for a bettor) the house commit (diceFairness.tableCommitMessage), so a
 * revealed seed can't be replayed into another round. SHA-256 here is
 * @noble/hashes (sync), the same bytes as diceFairness.commitTableSeed.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  casinoDocEpoch,
  readAllBets,
  readAllCrapsBets,
  readAllSeedRecords,
  readCrapsFairnessPref,
  readMyBets,
  readMyCrapsBets,
  readCrapsTableState,
  readSeedRecord,
  readTableState,
  writeMySeedRecord,
} from './casinoDoc';
import { HOUSE_PARTY } from './games/craps';
import type { CrapsTableState, FairnessTranscript } from './games/craps';
import type { RouletteTableState } from './games/roulette';
import { getCrapsFairnessMode, tableCommitMessage, verifyParties } from './games/diceFairness';
import type { RoundParty, TableGame, TableSeedContext } from './games/diceFairness';
import { randomSeedHex } from './games/fairDice';

/** How long the settle waits for frozen parties' reveals once it is due. */
export const REVEAL_GRACE_MS = 4_000;
/** At most this many bettors per round (the transcript bound is 16 with the
 *  house). More than that and the extras simply aren't parties that roll. */
const MAX_BETTOR_PARTIES = 15;

type TableState = CrapsTableState | RouletteTableState;

// ── Mode ──────────────────────────────────────────────────────────────────────

/** Is the round on this table right now Fair? The mode locks in when the
 *  window opens (a house commit), so this reads the round itself, and the
 *  owner's setting only before any round exists. */
export function roundIsFair(tableId: string, game: TableGame): boolean {
  const s = readState(tableId, game);
  return s ? !!s.houseCommit : isFairTable(tableId);
}

/** Is this table settled by the live multiparty scheme (Fair)? The owner's
 *  fairness setting, else the global default (multiparty). Roulette knows only
 *  Fair and plain RNG; craps' other two modes are still dev-simulated, so they
 *  read as Friendly. */
export function isFairTable(tableId: string): boolean {
  return (readCrapsFairnessPref(tableId) ?? getCrapsFairnessMode()) === 'multiparty';
}

// ── Commitments + local seed keeping ─────────────────────────────────────────

/** Same bytes as diceFairness.commitTableSeed, synchronously. */
export function commitSeedSync(seed: string, ctx: TableSeedContext): string {
  return bytesToHex(sha256(new TextEncoder().encode(tableCommitMessage(seed, ctx))));
}

const SEED_STORE_PREFIX = 'ssf-fair-seed:';
const memSeeds = new Map<string, string>();

function keepSeed(commit: string, seed: string): void {
  if (memSeeds.size > 256) memSeeds.clear();
  memSeeds.set(commit, seed);
  try {
    localStorage.setItem(SEED_STORE_PREFIX + commit, seed);
  } catch {
    // No storage (private window, tests): the in-memory copy still reveals.
  }
}

/** The secret behind `commit`, if THIS device made it (checked against the
 *  commitment, so a stale or edited store entry is never revealed). */
function seedFor(commit: string, ctx: TableSeedContext): string | null {
  const mem = memSeeds.get(commit);
  if (mem) return mem;
  try {
    const stored = localStorage.getItem(SEED_STORE_PREFIX + commit);
    if (stored && commitSeedSync(stored, ctx) === commit) return stored;
  } catch {
    // Unreadable storage ⇒ the seed is simply gone.
  }
  return null;
}

function forgetSeed(commit: string): void {
  memSeeds.delete(commit);
  try {
    localStorage.removeItem(SEED_STORE_PREFIX + commit);
  } catch {
    // Nothing stored.
  }
}

/** A fresh house seed for `round` about to open: kept on this device, its
 *  commitment returned for the table state. */
export function newHouseCommit(tableId: string, round: number): string {
  const seed = randomSeedHex();
  const commit = commitSeedSync(seed, houseCtx(tableId, round));
  keepSeed(commit, seed);
  return commit;
}

function houseCtx(table: string, round: number): TableSeedContext {
  return { table, round, party: HOUSE_PARTY, house: '' };
}

function bettorCtx(table: string, s: TableState, pid: string): TableSeedContext {
  return { table, round: s.round, party: pid, house: s.houseCommit ?? '' };
}

// ── Who has a stake ──────────────────────────────────────────────────────────

function readState(tableId: string, game: TableGame): TableState | null {
  return game === 'craps' ? readCrapsTableState(tableId) : readTableState(tableId);
}

/** Players with chips riding on this round: any bet on a craps felt (standing
 *  bets ride from roll to roll), or a bet for this very round on roulette. */
function stakedPlayers(tableId: string, game: TableGame, round: number): Set<string> {
  const bets = game === 'craps' ? readAllCrapsBets(tableId) : readAllBets(tableId, round);
  return new Set(Object.entries(bets).filter(([, list]) => list.length > 0).map(([pid]) => pid));
}

// ── The bettor's side (every client, every frame) ────────────────────────────

const lastTick = new Map<string, number>();

/**
 * Commit while the window is open and this player has chips down; reveal once
 * "no more bets" froze a commit set that includes us. Cheap and idempotent:
 * writes only on a real change, looks at most every 200 ms per table.
 */
export function tickFairSeeds(tableId: string, game: TableGame, me: string, now = Date.now(), force = false): void {
  const tickKey = `${tableId}:${me}`;
  if (!force && now - (lastTick.get(tickKey) ?? 0) < 200) return;
  if (lastTick.size > 256) lastTick.clear();
  lastTick.set(tickKey, now);
  const s = readState(tableId, game);
  if (!s?.houseCommit) return;
  const rec = readSeedRecord(tableId, me);
  if (s.phase === 'betting') {
    if (rec && rec.round === s.round && rec.house === s.houseCommit) return;
    // O(1) look at my own bets: this runs for every table, several times a second.
    const mine = game === 'craps' ? readMyCrapsBets(tableId, me) : readMyBets(tableId, me, s.round);
    if (mine.length === 0) return;
    const seed = randomSeedHex();
    const commit = commitSeedSync(seed, bettorCtx(tableId, s, me));
    keepSeed(commit, seed);
    writeMySeedRecord(tableId, me, { round: s.round, house: s.houseCommit, commit });
  } else if (s.phase === 'closing') {
    const frozen = s.commits?.[me];
    if (!frozen || !rec || rec.commit !== frozen || rec.round !== s.round || rec.seed) return;
    const seed = seedFor(frozen, bettorCtx(tableId, s, me));
    if (seed) writeMySeedRecord(tableId, me, { ...rec, seed });
  } else if (rec?.seed && rec.round === s.round) {
    // Settled: the seed is public now — no need to keep it.
    forgetSeed(rec.commit);
  }
}

// ── The operator's side ───────────────────────────────────────────────────────

/** "No more bets": the commitments that roll — staked players whose record
 *  answers this round's house commit. Spread into the closing write. */
export function freezeCommits(
  tableId: string,
  game: TableGame,
  s: TableState,
): { commits?: Record<string, string>; unseeded?: string[] } {
  if (!s.houseCommit) return {};
  const staked = stakedPlayers(tableId, game, s.round);
  const commits: Record<string, string> = {};
  const recs = readAllSeedRecords(tableId);
  for (const pid of Object.keys(recs).sort()) {
    const r = recs[pid];
    if (Object.keys(commits).length >= MAX_BETTOR_PARTIES) break;
    if (staked.has(pid) && r.round === s.round && r.house === s.houseCommit) commits[pid] = r.commit;
  }
  // Staked but no seed (offline with standing bets, too quick a close, or
  // past the cap — a table's stands keep it far below 15): on the record, so
  // the card can say who the result didn't take a seed from.
  const unseeded = [...staked].filter((pid) => !(pid in commits)).sort().slice(0, MAX_BETTOR_PARTIES + 1);
  return unseeded.length > 0 ? { commits, unseeded } : { commits };
}

/** When this page first tried to settle each round (its own clock). */
const settleDueAt = new Map<string, number>();

export interface GatheredRound {
  parties: RoundParty[];
  /** Frozen bettors who never revealed — their bets are forfeited. */
  forfeited: string[];
}

/**
 * The parties of a closing round, or null while frozen bettors are still due
 * to reveal (inside REVEAL_GRACE_MS of the first try). After the grace, the
 * missing ones are forfeited. A reveal that doesn't open its commitment
 * counts as missing.
 */
export function gatherRound(tableId: string, s: TableState, now = Date.now()): GatheredRound | null {
  const key = `${casinoDocEpoch()}:${tableId}:${s.round}`;
  if (!settleDueAt.has(key)) {
    if (settleDueAt.size > 64) settleDueAt.clear();
    settleDueAt.set(key, now);
  }
  const graceOver = now - settleDueAt.get(key)! >= REVEAL_GRACE_MS;
  const houseCommit = s.houseCommit ?? '';
  const parties: RoundParty[] = [{
    id: HOUSE_PARTY,
    commit: houseCommit,
    seed: houseCommit ? seedFor(houseCommit, houseCtx(tableId, s.round)) : null,
  }];
  const forfeited: string[] = [];
  for (const [pid, commit] of Object.entries(s.commits ?? {})) {
    const r = readSeedRecord(tableId, pid);
    const seed = r && r.round === s.round && r.commit === commit && r.seed
      && commitSeedSync(r.seed, bettorCtx(tableId, s, pid)) === commit ? r.seed : null;
    if (!seed) {
      if (!graceOver) return null;
      forfeited.push(pid);
    }
    parties.push({ id: pid, commit, seed });
  }
  return { parties, forfeited };
}

/** The round settled: the house seed is public now. */
export function settledRound(tableId: string, s: TableState): void {
  settleDueAt.delete(`${casinoDocEpoch()}:${tableId}:${s.round}`);
  if (s.houseCommit) forgetSeed(s.houseCommit);
}

// ── Anyone's check ────────────────────────────────────────────────────────────

export type RoundVerdict =
  | {
    kind: 'verified';
    forfeited: string[];
    houseMissing: boolean;
    droppedReveal: boolean;
    /** Staked players who added no seed at all (see SeedRoundFields). */
    unseeded: string[];
    /** Bettors whose revealed seed went into the mix. */
    bettorSeeds: number;
  }
  | { kind: 'failed' }
  | { kind: 'unproven' };

/**
 * Re-check a settled Fair round from the public room doc: the transcript's
 * parties are exactly the table's frozen commit set (house first), every
 * revealed seed opens its commitment, and the outcome is their mix. Flags a
 * missing house seed, and any forfeited bettor whose reveal is actually in
 * the doc (the operator left out a seed it could see).
 */
export async function verifySettledRound(
  game: TableGame,
  tableId: string,
  s: TableState,
  outcome: { dice?: [number, number]; pocket?: number },
): Promise<RoundVerdict> {
  const t: FairnessTranscript | undefined = s.fairness;
  if (!t?.parties || !t.commits || !t.seeds) return { kind: 'unproven' };
  const frozen = s.commits ?? {};
  const bettors = t.parties.slice(1);
  if (t.commits[0] !== (s.houseCommit ?? '')
    || bettors.length !== Object.keys(frozen).length
    || bettors.some((pid, i) => frozen[pid] !== t.commits![i + 1])) {
    return { kind: 'failed' };
  }
  if (!(await verifyParties(t, game, tableId, s.round, outcome))) return { kind: 'failed' };
  const forfeited = bettors.filter((_, i) => t.seeds![i + 1] === '');
  const droppedReveal = forfeited.some((pid) => {
    const r = readSeedRecord(tableId, pid);
    return !!r?.seed && r.round === s.round && commitSeedSync(r.seed, bettorCtx(tableId, s, pid)) === frozen[pid];
  });
  return {
    kind: 'verified',
    forfeited,
    houseMissing: t.seeds[0] === '',
    droppedReveal,
    unseeded: s.unseeded ?? [],
    bettorSeeds: bettors.length - forfeited.length,
  };
}
