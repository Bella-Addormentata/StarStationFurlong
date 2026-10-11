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

/** Bound a Map/Set by dropping its OLDEST entries (insertion order), never
 *  clearing it wholesale: a clear could drop a round still in play. */
function evictOldest(m: Map<string, unknown> | Set<string>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next().value as string;
    m.delete(first);
  }
}

const SEED_STORE_PREFIX = 'ssf-fair-seed:';
const memSeeds = new Map<string, string>();

function keepSeed(commit: string, seed: string): void {
  memSeeds.set(commit, seed);
  evictOldest(memSeeds, 256);
  try {
    localStorage.setItem(SEED_STORE_PREFIX + commit, seed);
  } catch {
    // No storage (private window, tests): the in-memory copy still reveals.
  }
}

/** The secret behind `commit`, if THIS device made it (checked against the
 *  commitment, so a stale or edited store entry is never revealed). */
function seedFor(commit: string, ctx: TableSeedContext): string | null {
  // Commitments are public, so a peer can copy one from another open round
  // into this one: the seed must open it in THIS context, memory copy too.
  const mem = memSeeds.get(commit);
  if (mem && commitSeedSync(mem, ctx) === commit) return mem;
  try {
    const stored = localStorage.getItem(SEED_STORE_PREFIX + commit);
    if (stored && commitSeedSync(stored, ctx) === commit) return stored;
  } catch {
    // Unreadable storage ⇒ the seed is simply gone.
  }
  return null;
}

/** Drop the secret behind `commit` — only if it belongs to `ctx`, so a
 *  commitment copied in from another open round can't erase that round's. */
function forgetSeed(commit: string, ctx: TableSeedContext): void {
  if (!seedFor(commit, ctx)) return;
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
  // Ids outside 1–128 chars would fail the closing state's shape guard and
  // wedge the table: such a bettor is simply not in the round.
  return new Set(Object.entries(bets)
    .filter(([pid, list]) => list.length > 0 && pid.length > 0 && pid.length <= 128)
    .map(([pid]) => pid));
}

// ── The bettor's side (every client, every frame) ────────────────────────────

const lastTick = new Map<string, number>();

/** Commitments THIS page made as a bettor (public values, not secrets): how
 *  it tells its own record from one someone else wrote under its id. */
const authored = new Set<string>();
/** Rounds (roundKey) THIS page committed a seed in — the own-seed check only
 *  speaks for rounds it took part in on this page. */
const authoredRounds = new Set<string>();

/** The frozen commit set each round showed when THIS page first saw it
 *  closing — before any reveal, so before anyone could know the result. The
 *  check compares the settled record against it: an operator who rewrites the
 *  party set after the reveals (to drop or add a seed) is caught here. */
interface FrozenSnapshot {
  house: string;
  commits: Record<string, string>;
  wagers?: Record<string, string>;
}
/** Per table (epoch:table), its last few rounds' snapshots, oldest first. */
const frozenSeen = new Map<string, Map<string, FrozenSnapshot>>();
const SNAPSHOTS_PER_TABLE = 4;

function seenFor(tableId: string, s: TableState): FrozenSnapshot | undefined {
  return frozenSeen.get(`${casinoDocEpoch()}:${tableId}`)?.get(roundKey(tableId, s.round, s.houseCommit));
}

function snapshot(s: TableState & { wagers?: Record<string, string> }): FrozenSnapshot {
  return {
    house: s.houseCommit ?? '',
    commits: { ...(s.commits ?? {}) },
    ...(s.wagers ? { wagers: { ...s.wagers } } : {}),
  };
}

/** The round's frozen commit set and wagers as THIS page first saw them (the
 *  operator: as it froze them) — anyone can rewrite the shared state after the
 *  reveals, so the settle and the check go by this copy when there is one. */
export function frozenFields(
  tableId: string,
  s: TableState & { wagers?: Record<string, string> },
): { commits?: Record<string, string>; wagers?: Record<string, string> } {
  const seen = seenFor(tableId, s);
  if (!seen) return { ...(s.commits ? { commits: s.commits } : {}), ...(s.wagers ? { wagers: s.wagers } : {}) };
  return { commits: seen.commits, ...(seen.wagers ? { wagers: seen.wagers } : {}) };
}

function noteFrozen(tableId: string, s: TableState & { wagers?: Record<string, string> }, overwrite: boolean): void {
  const k = roundKey(tableId, s.round, s.houseCommit);
  const tk = `${casinoDocEpoch()}:${tableId}`;
  let rounds = frozenSeen.get(tk);
  if (rounds?.has(k) && !overwrite) return;
  if (!rounds) {
    rounds = new Map();
    frozenSeen.set(tk, rounds);
    evictOldest(frozenSeen, 256);
  }
  rounds.delete(k); // re-insert as newest
  rounds.set(k, snapshot(s));
  // Only this table's older rounds make way: other tables keep theirs.
  evictOldest(rounds, SNAPSHOTS_PER_TABLE);
}

function roundKey(tableId: string, round: number, house: string | undefined): string {
  return `${casinoDocEpoch()}:${tableId}:${round}:${house ?? ''}`;
}

function sameCommits(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Commit while the window is open and this player has chips down; reveal once
 * "no more bets" froze a commit set that includes us. Cheap and idempotent:
 * writes only on a real change, looks at most every 200 ms per table.
 */
export function tickFairSeeds(tableId: string, game: TableGame, me: string, now = Date.now(), force = false): void {
  const tickKey = `${tableId}:${me}`;
  if (!force && now - (lastTick.get(tickKey) ?? 0) < 200) return;
  lastTick.delete(tickKey);
  lastTick.set(tickKey, now);
  evictOldest(lastTick, 256);
  const s = readState(tableId, game);
  if (!s?.houseCommit) return;
  if (s.phase === 'closing') {
    noteFrozen(tableId, s, false);
  }
  const rec = readSeedRecord(tableId, me);
  if (s.phase === 'betting') {
    // A record under my id that I didn't write is replaced with my own.
    if (rec && rec.round === s.round && rec.house === s.houseCommit && authored.has(rec.commit)) return;
    // O(1) look at my own bets: this runs for every table, several times a second.
    const mine = game === 'craps' ? readMyCrapsBets(tableId, me) : readMyBets(tableId, me, s.round);
    if (mine.length === 0) return;
    const seed = randomSeedHex();
    const commit = commitSeedSync(seed, bettorCtx(tableId, s, me));
    keepSeed(commit, seed);
    authored.add(commit);
    authoredRounds.add(roundKey(tableId, s.round, s.houseCommit));
    evictOldest(authored, 512);
    evictOldest(authoredRounds, 512);
    writeMySeedRecord(tableId, me, { round: s.round, house: s.houseCommit, commit });
  } else if (s.phase === 'closing') {
    const frozen = s.commits?.[me];
    if (!frozen || !rec || rec.commit !== frozen || rec.round !== s.round || rec.seed) return;
    const seed = seedFor(frozen, bettorCtx(tableId, s, me));
    if (seed) writeMySeedRecord(tableId, me, { ...rec, seed });
  } else {
    // Settled: this round's secrets are public or moot now — mine (revealed
    // or not) and the house's, if this page opened the round.
    // (First note my frozen commitment as mine if I hold its seed — a page
    // reloaded mid-round still knows its own part for the card's check.)
    const myFrozen = s.commits?.[me];
    if (myFrozen && seedFor(myFrozen, bettorCtx(tableId, s, me))) {
      authored.add(myFrozen);
      authoredRounds.add(roundKey(tableId, s.round, s.houseCommit));
      evictOldest(authored, 512);
      evictOldest(authoredRounds, 512);
    }
    if (rec && rec.round === s.round) forgetSeed(rec.commit, { table: tableId, round: rec.round, party: me, house: rec.house });
    if (myFrozen) forgetSeed(myFrozen, bettorCtx(tableId, s, me));
    forgetSeed(s.houseCommit, houseCtx(tableId, s.round));
  }
}

// ── The operator's side ───────────────────────────────────────────────────────

/** "No more bets": the commitments that roll — staked players whose record
 *  answers this round's house commit. Spread into the closing write. */
export function freezeCommits(
  tableId: string,
  game: TableGame,
  s: TableState,
): { commits?: Record<string, string>; unseeded?: string[]; wagers?: Record<string, string> } {
  if (!s.houseCommit) return {};
  const staked = stakedPlayers(tableId, game, s.round);
  const commits: Record<string, string> = {};
  // Read only the staked players' records: anyone can add fseed keys, so a
  // scan of every key on the table would let a peer stall the close.
  for (const pid of [...staked].sort()) {
    if (Object.keys(commits).length >= MAX_BETTOR_PARTIES) break;
    const r = readSeedRecord(tableId, pid);
    if (r && r.round === s.round && r.house === s.houseCommit) commits[pid] = r.commit;
  }
  // Staked but no seed (offline with standing bets, too quick a close, or
  // past the cap — a table's stands keep it far below 15): on the record, so
  // the card can say who the result didn't take a seed from.
  const unseeded = [...staked].filter((pid) => !(pid in commits)).sort().slice(0, MAX_BETTOR_PARTIES + 1);
  // The wagers freeze too: the reveals make the result computable before the
  // settle, so a bet rewritten after "no more bets" must not be paid.
  const wagers: Record<string, string> = {};
  for (const pid of [...Object.keys(commits), ...unseeded]) {
    wagers[pid] = wagerFingerprint(game === 'craps' ? readMyCrapsBets(tableId, pid) : readMyBets(tableId, pid, s.round));
  }
  // The operator's own copy of what it froze: its settle goes by this.
  noteFrozen(tableId, { ...s, commits, wagers }, true);
  return unseeded.length > 0 ? { commits, unseeded, wagers } : { commits, wagers };
}

/** A bettor's wager list, hashed: what "no more bets" froze for them. */
export function wagerFingerprint(bets: readonly unknown[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(`ssf-wagers-v1|${JSON.stringify(bets)}`)));
}

/** The settle's bets on a round that froze its wagers: only the frozen
 *  bettors, and only lists unchanged since the close. A list rewritten after
 *  "no more bets" is `voided` (its bets are not paid — the settle clears them).
 *  A round without frozen wagers (RNG) settles the bets as they stand. */
export function frozenWagers<T>(
  tableId: string,
  s: TableState & { wagers?: Record<string, string> },
  bets: Record<string, T[]>,
): { bets: Record<string, T[]>; voided: string[] } {
  const { wagers } = frozenFields(tableId, s);
  if (!wagers) return { bets, voided: [] };
  const out: Record<string, T[]> = {};
  const voided: string[] = [];
  for (const [pid, list] of Object.entries(bets)) {
    const want = wagers[pid];
    if (want === undefined) continue; // not in the round: untouched
    if (wagerFingerprint(list) === want) out[pid] = list;
    else voided.push(pid);
  }
  return { bets: out, voided: voided.sort() };
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
  const key = roundKey(tableId, s.round, s.houseCommit);
  if (!settleDueAt.has(key)) {
    settleDueAt.set(key, now);
    evictOldest(settleDueAt, 256);
  }
  const graceOver = now - settleDueAt.get(key)! >= REVEAL_GRACE_MS;
  const houseCommit = s.houseCommit ?? '';
  const parties: RoundParty[] = [{
    id: HOUSE_PARTY,
    commit: houseCommit,
    seed: houseCommit ? seedFor(houseCommit, houseCtx(tableId, s.round)) : null,
  }];
  const forfeited: string[] = [];
  for (const [pid, commit] of Object.entries(frozenFields(tableId, s).commits ?? {})) {
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
  settleDueAt.delete(roundKey(tableId, s.round, s.houseCommit));
  if (s.houseCommit) forgetSeed(s.houseCommit, houseCtx(tableId, s.round));
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
    /** The viewer's own seed: in the mix, left out, or replaced by a
     *  commitment it never made (undefined: the viewer had no part). */
    mine?: 'in' | 'left-out' | 'replaced';
    /** False when this page never saw the round close, so it could not
     *  compare the party set with the one frozen before the reveals. */
    watchedClose: boolean;
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
  me?: string,
): Promise<RoundVerdict> {
  const t: FairnessTranscript | undefined = s.fairness;
  if (!t?.parties || !t.commits || !t.seeds) return { kind: 'unproven' };
  const frozen = s.commits ?? {};
  // The party set must be the one this page saw frozen before the reveals.
  const seen = seenFor(tableId, s);
  if (seen && (seen.house !== s.houseCommit || !sameCommits(seen.commits, frozen)
    || (seen.wagers && !sameCommits(seen.wagers, s.wagers ?? {})))) return { kind: 'failed' };
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
  let mine: 'in' | 'left-out' | 'replaced' | undefined;
  if (me && me in frozen && authoredRounds.has(roundKey(tableId, s.round, s.houseCommit))) {
    const i = bettors.indexOf(me);
    mine = !authored.has(frozen[me]) ? 'replaced' : i >= 0 && t.seeds[i + 1] !== '' ? 'in' : 'left-out';
  }
  return {
    kind: 'verified',
    forfeited,
    houseMissing: t.seeds[0] === '',
    droppedReveal,
    unseeded: s.unseeded ?? [],
    bettorSeeds: bettors.length - forfeited.length,
    mine,
    watchedClose: !!seen,
  };
}
