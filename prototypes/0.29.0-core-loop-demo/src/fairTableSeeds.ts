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
 * SIGNED: each bettor's record carries a signature over its commitment by
 * that player's identity key (keypair.ts; the key players[pid].keyB64 names,
 * pinned the first time this page sees it). The close freezes only records
 * whose signature checks, and the signatures ride on the round, so nobody can
 * put a seed in under another player's name — not even the operator.
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
  betsHeld,
  casinoDocEpoch,
  casinoRoomId,
  readAllBets,
  readAllCrapsBets,
  readCrapsFairnessPref,
  readMyBets,
  readMyCrapsBets,
  readCrapsTableState,
  readPlayerKey,
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
import { getPlayerId } from './identity';
import { getIdentityPub, signIdentity, verifyIdentity } from './keypair';

/** How long the settle waits for frozen parties' reveals once it is due. */
export const REVEAL_GRACE_MS = 4_000;
/** At most this many bettors per round (the transcript bound is 16 with the
 *  house). More than that and the extras simply aren't parties that roll. */
const MAX_BETTOR_PARTIES = 15;
/** Most distinct bettors a Fair round can carry (15 seeded + 16 unseeded, the
 *  transcript's bounds): the table refuses a new bettor past it. */
export const MAX_TABLE_BETTORS = 2 * MAX_BETTOR_PARTIES + 1;

type TableState = CrapsTableState | RouletteTableState;

// ── Mode ──────────────────────────────────────────────────────────────────────

/** Is the round on this table right now Fair? The mode locks in when the
 *  window opens (a house commit), so this reads the round itself, and the
 *  owner's setting only before any round exists. */
export function roundIsFair(tableId: string, game: TableGame): boolean {
  const s = readState(tableId, game);
  // A house commit this page froze keeps the round Fair even if the live
  // field is erased after the close.
  return s ? !!(s.houseCommit || frozenFields(tableId, s).houseCommit) : isFairTable(tableId);
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
/** The stored commitments, oldest first: a round abandoned mid-way (left the
 *  room, table removed) never settles, so the store is capped by this index. */
const SEED_INDEX_KEY = 'ssf-fair-seed-index';
const MAX_STORED_SEEDS = 256;
const memSeeds = new Map<string, string>();

function readSeedIndex(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SEED_INDEX_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function keepSeed(commit: string, seed: string): void {
  memSeeds.set(commit, seed);
  evictOldest(memSeeds, 256);
  try {
    const index = readSeedIndex().filter((c) => c !== commit);
    index.push(commit);
    while (index.length > MAX_STORED_SEEDS) localStorage.removeItem(SEED_STORE_PREFIX + index.shift()!);
    localStorage.setItem(SEED_STORE_PREFIX + commit, seed);
    localStorage.setItem(SEED_INDEX_KEY, JSON.stringify(index));
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
    localStorage.setItem(SEED_INDEX_KEY, JSON.stringify(readSeedIndex().filter((c) => c !== commit)));
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
  return { room: casinoRoomId(), table, round, party: HOUSE_PARTY, house: '' };
}

function bettorCtx(table: string, s: TableState, pid: string): TableSeedContext {
  return { room: casinoRoomId(), table, round: s.round, party: pid, house: s.houseCommit ?? '' };
}

// ── Signatures ───────────────────────────────────────────────────────────────

/** What a bettor signs: its commitment in full context, domain-tagged. */
export function seedSigBytes(ctx: TableSeedContext, commit: string): Uint8Array {
  return new TextEncoder().encode(
    `ssf-seed-sig-v1|${ctx.room ?? ''}|${ctx.table}|${ctx.round}|${ctx.party}|${ctx.house}|${commit}`,
  );
}

/** The identity key a player's records must be signed with: this page's own
 *  key for its own player, else the key pinned when this page first saw the
 *  player in the room (casinoDoc.readPlayerKey). */
export function keyFor(pid: string): string | undefined {
  return pid === getPlayerId() ? getIdentityPub() : readPlayerKey(pid);
}

const sigChecks = new Map<string, boolean>();

/** Does `sig` sign `commit` for `pid` in this round, under pid's key? */
function signedBy(tableId: string, s: TableState, pid: string, commit: string, sig: string | undefined): boolean {
  const key = keyFor(pid);
  if (!key || !sig) return false;
  const ctx = bettorCtx(tableId, s, pid);
  const ck = `${key}|${sig}|${ctx.room}|${tableId}|${s.round}|${pid}|${ctx.house}|${commit}`;
  let ok = sigChecks.get(ck);
  if (ok === undefined) {
    ok = verifyIdentity(key, seedSigBytes(ctx, commit), sig);
    sigChecks.set(ck, ok);
    evictOldest(sigChecks, 512);
  }
  return ok;
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

/** Commitments THIS page made as a bettor, keyed by the round they were made
 *  for (public values, not secrets): how
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
  sigs?: Record<string, string>;
  stakes?: Record<string, number>;
}
/** Per table (epoch:table), its last few rounds' snapshots, oldest first. */
const frozenSeen = new Map<string, Map<string, FrozenSnapshot>>();
const SNAPSHOTS_PER_TABLE = 4;

// Keyed by round alone, NOT the house commit: that field is peer-writable
// too, and a rewritten one must hit the snapshot (and fail the house
// comparison) rather than miss it and read as merely unwitnessed.
function seenFor(tableId: string, s: TableState): FrozenSnapshot | undefined {
  return frozenSeen.get(`${casinoDocEpoch()}:${tableId}`)?.get(String(s.round));
}

function snapshot(s: TableState): FrozenSnapshot {
  return {
    house: s.houseCommit ?? '',
    commits: { ...(s.commits ?? {}) },
    ...(s.wagers ? { wagers: { ...s.wagers } } : {}),
    ...(s.sigs ? { sigs: { ...s.sigs } } : {}),
    ...(s.stakes ? { stakes: { ...s.stakes } } : {}),
  };
}

/** The round's frozen commit set and wagers as THIS page first saw them (the
 *  operator: as it froze them) — anyone can rewrite the shared state after the
 *  reveals, so the settle and the check go by this copy when there is one. */
export function frozenFields(
  tableId: string,
  s: TableState,
): {
  houseCommit?: string; commits?: Record<string, string>; wagers?: Record<string, string>;
  sigs?: Record<string, string>; stakes?: Record<string, number>;
} {
  const seen = seenFor(tableId, s);
  if (!seen) {
    return {
      ...(s.commits ? { commits: s.commits } : {}),
      ...(s.wagers ? { wagers: s.wagers } : {}),
      ...(s.sigs ? { sigs: s.sigs } : {}),
      ...(s.stakes ? { stakes: s.stakes } : {}),
    };
  }
  return {
    ...(seen.house ? { houseCommit: seen.house } : {}),
    commits: seen.commits,
    ...(seen.wagers ? { wagers: seen.wagers } : {}),
    ...(seen.sigs ? { sigs: seen.sigs } : {}),
    ...(seen.stakes ? { stakes: seen.stakes } : {}),
  };
}

/** The chips a bettor's list held on the felt as round `s` closed: what the
 *  freeze recorded, so a list rewritten since can't change what the round
 *  takes, or on a round that froze none (RNG, or a bettor who missed the
 *  freeze) what it holds now. 0 for an earlier build's list, whose chips were
 *  taken when it went down (casinoDoc STAKES ON THE FELT). */
export function heldAtClose(tableId: string, s: TableState, pid: string, staked: number): number {
  const frozen = frozenFields(tableId, s).stakes;
  if (frozen && Object.prototype.hasOwnProperty.call(frozen, pid)) return frozen[pid];
  return betsHeld(tableId, pid) ? staked : 0;
}

/** Forget the snapshots of every table no longer in the room (`live` is the
 *  room's current table ids): a table removed and recreated under the same id
 *  starts over at round 1, and a stale snapshot would fail its rounds. Every
 *  client calls this each frame (world.ts), not just the page that removed it. */
export function forgetMissingTables(live: ReadonlySet<string>): void {
  if (frozenSeen.size === 0) return;
  const prefix = `${casinoDocEpoch()}:`;
  for (const tk of [...frozenSeen.keys()]) {
    if (!tk.startsWith(prefix) || !live.has(tk.slice(prefix.length))) frozenSeen.delete(tk);
  }
}

function noteFrozen(tableId: string, s: TableState, overwrite: boolean): void {
  const k = String(s.round);
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

/** A commitment this page authored, bound to the round it was made for. */
function authoredKey(tableId: string, s: TableState, commit: string): string {
  return `${roundKey(tableId, s.round, s.houseCommit)}|${commit}`;
}

/** Whether THIS page holds the round's (frozen) house seed — without it a
 *  Fair round is void, decided before any dice are thrown. */
export function houseSeedHeld(tableId: string, s: TableState): boolean {
  const house = frozenFields(tableId, s).houseCommit ?? s.houseCommit;
  return !!house && !!seedFor(house, houseCtx(tableId, s.round));
}

/** Whether every frozen bettor's commitment carries its own signature (the
 *  frozen `sigs`, under the player's pinned key). A page that didn't freeze
 *  the round itself (a reload) reads the peer-written closing fields, so a
 *  forged party could slip in there: such a round is void, never settled. */
export function frozenPartiesSigned(tableId: string, s: TableState): boolean {
  const fz = frozenFields(tableId, s);
  const ctxState: TableState = fz.houseCommit ? { ...s, houseCommit: fz.houseCommit } : s;
  return Object.entries(fz.commits ?? {}).every(([pid, commit]) => signedBy(tableId, ctxState, pid, commit, fz.sigs?.[pid]));
}

/** Can this page settle the Fair round? It must hold the house seed, and every
 *  frozen party must be signed — otherwise the round is void. */
export function roundSettleable(tableId: string, s: TableState): boolean {
  return houseSeedHeld(tableId, s) && frozenPartiesSigned(tableId, s);
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
  const tickKey = `${casinoDocEpoch()}:${tableId}:${me}`;
  if (!force && now - (lastTick.get(tickKey) ?? 0) < 200) return;
  lastTick.delete(tickKey);
  lastTick.set(tickKey, now);
  evictOldest(lastTick, 256);
  const live = readState(tableId, game);
  // A removed table forgets its snapshots: one recreated under the same id
  // starts again at round 1 with a new house commit.
  if (!live) frozenSeen.delete(`${casinoDocEpoch()}:${tableId}`);
  if (!live) return;
  const rec = readSeedRecord(tableId, me);
  // Past the close, the house commit comes from what this page froze, or
  // from my own commitment for this round: erasing the live field mustn't
  // stop my reveal (the operator settles by its frozen copy and would
  // forfeit me).
  let house = live.houseCommit;
  if (live.phase !== 'betting') {
    // Mine: authored on this page, or (after a reload) opened by a seed this
    // device kept for exactly that commitment.
    const mineRec = rec && rec.round === live.round
      && (authored.has(authoredKey(tableId, { ...live, houseCommit: rec.house }, rec.commit))
        || seedFor(rec.commit, bettorCtx(tableId, { ...live, houseCommit: rec.house }, me))) ? rec.house : undefined;
    house = frozenFields(tableId, live).houseCommit ?? house ?? mineRec;
  }
  if (!house) return;
  const s: TableState = { ...live, houseCommit: house, ...(live.phase === 'closing' ? frozenFields(tableId, live) : {}) };
  if (s.phase === 'closing') {
    noteFrozen(tableId, s, false);
  }
  if (s.phase === 'betting') {
    // A record under my id that I didn't write is replaced with my own.
    // "Mine" is per round: a commitment of mine copied in from an earlier
    // round can't be revealed here, and would only get my bets forfeited.
    if (rec && rec.round === s.round && rec.house === s.houseCommit && authored.has(authoredKey(tableId, s, rec.commit))
      && seedFor(rec.commit, bettorCtx(tableId, s, me))) return;
    // O(1) look at my own bets: this runs for every table, several times a second.
    const mine = game === 'craps' ? readMyCrapsBets(tableId, me) : readMyBets(tableId, me, s.round);
    if (mine.length === 0) return;
    const seed = randomSeedHex();
    const commit = commitSeedSync(seed, bettorCtx(tableId, s, me));
    keepSeed(commit, seed);
    const sig = signIdentity(seedSigBytes(bettorCtx(tableId, s, me), commit));
    authored.add(authoredKey(tableId, s, commit));
    authoredRounds.add(roundKey(tableId, s.round, s.houseCommit));
    evictOldest(authored, 512);
    evictOldest(authoredRounds, 512);
    writeMySeedRecord(tableId, me, { round: s.round, house, commit, sig });
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
      authored.add(authoredKey(tableId, s, myFrozen));
      authoredRounds.add(roundKey(tableId, s.round, s.houseCommit));
      evictOldest(authored, 512);
      evictOldest(authoredRounds, 512);
    }
    if (rec && rec.round === s.round) forgetSeed(rec.commit, { room: casinoRoomId(), table: tableId, round: rec.round, party: me, house: rec.house });
    if (myFrozen) forgetSeed(myFrozen, bettorCtx(tableId, s, me));
    forgetSeed(house, houseCtx(tableId, s.round));
  }
}

// ── The operator's side ───────────────────────────────────────────────────────

/** "No more bets": the commitments that roll — staked players whose record
 *  answers this round's house commit. Spread into the closing write. */
export function freezeCommits(
  tableId: string,
  game: TableGame,
  s: TableState,
): {
  commits?: Record<string, string>; unseeded?: string[]; wagers?: Record<string, string>;
  sigs?: Record<string, string>; stakes?: Record<string, number>;
} {
  if (!s.houseCommit) return {};
  const staked = stakedPlayers(tableId, game, s.round);
  const commits: Record<string, string> = {};
  const sigs: Record<string, string> = {};
  // Read only the staked players' records: anyone can add fseed keys, so a
  // scan of every key on the table would let a peer stall the close.
  for (const pid of [...staked].sort()) {
    if (Object.keys(commits).length >= MAX_BETTOR_PARTIES) break;
    const r = readSeedRecord(tableId, pid);
    // Only a record signed by the player's own key: anyone can write under
    // their id, nobody else can sign for them.
    if (r && r.round === s.round && r.house === s.houseCommit && signedBy(tableId, s, pid, r.commit, r.sig)) {
      commits[pid] = r.commit;
      sigs[pid] = r.sig!;
    }
  }
  // Staked but no seed (offline with standing bets, too quick a close, or
  // past the cap — a table's stands keep it far below 15): on the record, so
  // the card can say who the result didn't take a seed from.
  const unseeded = [...staked].filter((pid) => !(pid in commits)).sort().slice(0, MAX_BETTOR_PARTIES + 1);
  // The wagers freeze too: the reveals make the result computable before the
  // settle, so a bet rewritten after "no more bets" must not be paid.
  // And what each list holds on the felt, so a rewrite can't shrink what the
  // round takes (casinoDoc STAKES ON THE FELT).
  const wagers: Record<string, string> = {};
  const stakes: Record<string, number> = {};
  for (const pid of [...Object.keys(commits), ...unseeded]) {
    const list = game === 'craps' ? readMyCrapsBets(tableId, pid) : readMyBets(tableId, pid, s.round);
    wagers[pid] = wagerFingerprint(list);
    stakes[pid] = betsHeld(tableId, pid) ? list.reduce((n, b) => n + b.amount, 0) : 0;
  }
  // The operator's own copy of what it froze: its settle goes by this.
  noteFrozen(tableId, { ...s, commits, wagers, sigs, stakes }, true);
  return unseeded.length > 0 ? { commits, unseeded, wagers, sigs, stakes } : { commits, wagers, sigs, stakes };
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
  s: TableState,
  bets: Record<string, T[]>,
): { bets: Record<string, T[]>; voided: string[]; omitted: string[] } {
  const { wagers } = frozenFields(tableId, s);
  if (!wagers) return { bets, voided: [], omitted: [] };
  const out: Record<string, T[]> = {};
  const voided: string[] = [];
  const omitted: string[] = [];
  for (const [pid, list] of Object.entries(bets)) {
    const want = wagers[pid];
    if (want === undefined) { // missed the freeze: the caller returns it (roulette) or lets it ride (craps)
      omitted.push(pid);
      continue;
    }
    if (wagerFingerprint(list) === want) out[pid] = list;
    else voided.push(pid);
  }
  return { bets: out, voided: voided.sort(), omitted: omitted.sort() };
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
export function gatherRound(tableId: string, live: TableState, now = Date.now()): GatheredRound | null {
  // The house commit and commit set as this page froze them (see frozenFields).
  const fz = frozenFields(tableId, live);
  const s: TableState = { ...live, ...(fz.houseCommit ? { houseCommit: fz.houseCommit } : {}) };
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
  for (const [pid, commit] of Object.entries(fz.commits ?? {})) {
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
  // By the house commit this page froze: the live one may have been erased.
  const house = frozenFields(tableId, s).houseCommit ?? s.houseCommit;
  settleDueAt.delete(roundKey(tableId, s.round, house));
  if (house) forgetSeed(house, houseCtx(tableId, s.round));
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
    || (seen.wagers && !sameCommits(seen.wagers, s.wagers ?? {}))
    || (seen.sigs && !sameCommits(seen.sigs, s.sigs ?? {})))) return { kind: 'failed' };
  const bettors = t.parties.slice(1);
  if (t.commits[0] !== (s.houseCommit ?? '')
    || bettors.length !== Object.keys(frozen).length
    || bettors.some((pid, i) => frozen[pid] !== t.commits![i + 1])) {
    return { kind: 'failed' };
  }
  // Settling without the house seed lets the house pick between outcomes
  // after seeing every reveal: the operator voids such a round instead, so a
  // published one fails.
  if (t.seeds[0] === '') return { kind: 'failed' };
  // Every bettor's commitment must carry its own signature: an operator can
  // leave a player out (their card says so), but not seed in their name.
  const fzSigs = frozenFields(tableId, s).sigs ?? {};
  if (bettors.some((pid) => !signedBy(tableId, s, pid, frozen[pid], fzSigs[pid]))) return { kind: 'failed' };
  if (!(await verifyParties(t, game, tableId, s.round, outcome, casinoRoomId()))) return { kind: 'failed' };
  const forfeited = bettors.filter((_, i) => t.seeds![i + 1] === '');
  const droppedReveal = forfeited.some((pid) => {
    const r = readSeedRecord(tableId, pid);
    return !!r?.seed && r.round === s.round && commitSeedSync(r.seed, bettorCtx(tableId, s, pid)) === frozen[pid];
  });
  let mine: 'in' | 'left-out' | 'replaced' | undefined;
  if (me && authoredRounds.has(roundKey(tableId, s.round, s.houseCommit))) {
    const i = bettors.indexOf(me);
    // A seed I committed that the close left out of the party set entirely
    // is as much LEFT OUT as one forfeited after it.
    mine = !(me in frozen) ? 'left-out' : !authored.has(authoredKey(tableId, s, frozen[me])) ? 'replaced' : i >= 0 && t.seeds[i + 1] !== '' ? 'in' : 'left-out';
  }
  // Who had chips down but added no seed: the frozen wager keys minus the
  // frozen commit keys — not the peer-writable `unseeded` list, which an
  // operator could clear to hide a house-only result.
  const fz = frozenFields(tableId, s);
  const unseeded = fz.wagers
    ? Object.keys(fz.wagers).filter((pid) => !(pid in (fz.commits ?? {}))).sort()
    : s.unseeded ?? [];
  return {
    kind: 'verified',
    forfeited,
    houseMissing: t.seeds[0] === '',
    droppedReveal,
    unseeded,
    bettorSeeds: bettors.length - forfeited.length,
    mine,
    watchedClose: !!seen,
  };
}
