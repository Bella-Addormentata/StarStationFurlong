/**
 * 🧮 Computed casino tables — the fold (PR 2 of "Computed casino tables").
 *
 * PURE: no Yjs, no Date, no Math.random, no casinoDoc state, no localStorage.
 * Nothing here may depend on Map/Y.Map iteration order: every output is the
 * same for the same SET of records, whatever order they arrived in.
 *
 * A computed table's live session is one nested map of write-once records,
 * each keyed by its own hash. Every page feeds the same records into a
 * TableFold and reads back the same rounds, nets and held stakes. Nobody
 * writes a balance: casinoDoc adds `nets` and subtracts `held` (PR 1's chip
 * sum gains two derived terms).
 *
 * KEYS (inside the session map `ses:<t>:<inc>:<sid>` of `casinoComputed`):
 *   s:<r>:<pid>:<h>   slip     {r, p, v, b, c, k, g}; at craps {r, p, v, b, o, t?, l?, c, k, g}
 *   c:<r>:<h>         close    {r, q, f, k, g}
 *   x:<r>:<pid>:<h>   reveal   {r, p, s}          (unsigned)
 *   f:<r>:<h>         forfeit  {r, x, n, k, g}
 *   z:<r>:<h>         abandon  {r, x, k, g}
 *   h:…               reserved for the house record (PR 5) — ignored here
 * `<h>` = recHash(body). A key whose round, pid or hash doesn't match its
 * body, or a body with a float, an unknown field or a wrong type, is junk and
 * is never indexed. Keys parse from both ends: r and h hold no ':', pid may.
 *
 * Checkpoint `sum:<t>:<inc>` (top level of casinoComputed, LWW):
 *   {v: 1, b, u, l, n, e?, k, g}; a live craps table's also holds `s`, the
 *   state its next roll plays from. Counted on shape alone on Friendly tables.
 *
 * THE GAME comes from the incarnation's name (gameOfInc): `c…` is roulette,
 * `k…` craps. Slips and checkpoints are read by that game's shapes, so a
 * record written for one game is junk at the other.
 *
 * ONE ROUND, AS THE FOLD SEES IT:
 *   1. Players write slips: each version is the player's whole felt, and the
 *      latest verified one per player is what the felt holds (`held`) —
 *      given a keyOf, only a version signed by the key the page pinned for
 *      that player, so no page can hold chips on someone else's felt.
 *   2. A close freezes one slip version per player. Rival closes are all
 *      kept; the chain rule below picks one. A version the chosen close left
 *      out holds nothing.
 *   3. Frozen players reveal the seeds behind their slips' commitments.
 *   4. The round is DECIDED, by the first of: the best-ranked valid forfeit
 *      (its seeds count, the other frozen players forfeit); every reveal in;
 *      an abandon (void: every stake back). Otherwise it is still open.
 *   5. The pocket mixes the counted seeds; each frozen player's delta is
 *      what the felt returned minus its stake. This step is the game's
 *      (FoldGame: roulette here; a game may carry state, such as a craps
 *      point and the bets riding on it, from one round into the next).
 *
 * THE CHAIN: each close names its parent (the session id for the first
 * round, else a decided close of the round before). The longest decided
 * chain from the session base wins; ties go to the closer's dutyRank, then
 * the hash. This is what lets honest rival closes settle themselves on the
 * next round, and also what lets a modified client rewrite any round since
 * the last checkpoint by outgrowing the honest chain (a documented Friendly
 * lever; trims make history final).
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { basisOf, CARRY_POINTS, diceOf, EMPTY_CARRY, isCanonFelt, MAX_RIDERS, MAX_SHOOTER_PID, nullProtoCopy, playRoll, standingOf } from './computedCraps';
import type { CrapsCarry, RollFate, RollSlip } from './computedCraps';
import type { CrapsBet } from './games/craps';
import { isRouletteBet, resolveRound } from './games/roulette';
import type { RouletteBet } from './games/roulette';
import { tableCommitMessage } from './games/diceFairness';
import { pocketFromMaterialSync } from './games/fairDice';

// ── Limits ───────────────────────────────────────────────────────────────────

/** Bettors one close may freeze (casinoDoc MAX_TABLE_BETTORS). */
export const MAX_FROZEN = 31;
/** Chips (bet entries) one slip may carry (casinoTableSession MAX_BETS_DRAWN_PER_PLAYER). */
export const MAX_SLIP_BETS = 400;
/** Closes per round the fold considers (by claimed closeRank, then hash).
 *  A close already known to be invalid (its signature, or its signer's
 *  slip, failed) takes no place, so records nobody signed can't fill it. */
export const MAX_CLOSES_PER_ROUND = 32;
/** Forfeits, and separately abandons, per close the fold considers (by
 *  claimed rank, then hash); one whose signature failed takes no place. */
export const MAX_FORFEITS_PER_CLOSE = 32;
/** Rounds past the base a session may reach. */
export const MAX_SESSION_ROUNDS = 500;
/** Players a checkpoint may carry. */
export const MAX_CHECKPOINT_PIDS = 4_096;

// ── Records ──────────────────────────────────────────────────────────────────

export interface FoldCtx {
  /** casinoRoomId() — '' offline. Signed, never stored. */
  room: string;
  /** The table's furniture id. */
  t: string;
  /** The computed incarnation, /^[ck][0-9a-f]{24}$/: `c` roulette, `k` craps. */
  inc: string;
}

export interface SlipRec {
  /** Round. */ r: number;
  /** Player id (isPlayerKey: 1–256 chars, not '__proto__'). */ p: string;
  /** Version ≥ 1: orders one player's versions within a round; ties → hash. */ v: number;
  /** The player's WHOLE felt this round: 0–MAX_SLIP_BETS entries, each isRouletteBet.
   *  An empty felt is a valid version (everything taken down) that holds nothing
   *  and that a close may not freeze. */ b: RouletteBet[];
  /** commitSeedSync(seed, {room, table: `ct:<t>:<inc>`, round: r, party: p, house: ''}) — 64 hex. */ c: string;
  /** Signer's identity pub, base64url (43 chars). */ k: string;
  /** Signature over signBytes('slip', ctx, body), base64url (86 chars). */ g: string;
}

/** A slip at a craps table (a `k` incarnation): the same keys, commitment and
 *  signature, with a craps felt and three fields of its own. */
export interface CrapsSlipRec extends Omit<SlipRec, 'b'> {
  /** The player's WHOLE felt this roll, canonical (computedCraps isCanonFelt):
   *  one entry per spot, 0–MAX_CRAPS_SPOTS of them. An empty felt is a valid
   *  version (everything that may come down taken down), and a close may
   *  freeze one, though never sign over one. */ b: CrapsBet[];
  /** computedCraps basisOf the carry the felt was BUILT on, 32 hex: a slip
   *  built before an earlier roll changed has none of its changes applied. */ o: string;
  /** The stand (1–7) the player stood at on the page that wrote it; absent
   *  when that page had no table session at this table. */ t?: number;
  /** 1 on the goodbye version a page writes as it leaves. The fold never reads it. */ l?: 1;
}

/** A slip of either game, as the fold indexes it. */
export type AnySlipRec = SlipRec | CrapsSlipRec;

export interface CloseRec {
  r: number;
  /** Parent: the session id when r = base+1, else the hash of a close of round r−1. */ q: string;
  /** pid → hash of the slip version frozen; 1–MAX_FROZEN entries. */ f: Record<string, string>;
  /** Must be the `k` of a present, valid slip this close freezes. */ k: string;
  g: string;
}

export interface RevealRec {
  r: number;
  p: string;
  /** The seed, 64 lowercase hex. Counts iff it opens the frozen slip's `c`. */ s: string;
}

export interface ForfeitRec {
  r: number;
  /** The close it decides. */ x: string;
  /** Sorted, unique, non-empty pids whose seeds count. */ n: string[];
  /** A frozen bettor's pub whose pid is in `n`. */ k: string;
  g: string;
}

export interface AbandonRec { r: number; x: string; k: string; g: string }

export interface Checkpoint {
  v: 1;
  /** The sid of the session it closed. */ b: string;
  /** The last round it covers (≥ 1). */ u: number;
  /** recHash of round u's chosen close (32 hex). */ l: string;
  /** pid → cumulative net over the incarnation, decimal bigint string
   *  (/^-?(0|[1-9]\d{0,39})$/, never "0"); ≤ MAX_CHECKPOINT_PIDS entries. */ n: Record<string, string>;
  /** 1 = the incarnation has ended. */ e?: 1;
  /** Craps only, and only while live: the state the next roll plays from
   *  (required then; asCrapsCheckpoint). */ s?: CrapsCarry;
  k: string;
  g: string;
}

export type SignedKind = 'slip' | 'close' | 'forfeit' | 'abandon' | 'sum';

// ── Encoding ─────────────────────────────────────────────────────────────────

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A plain object (an object literal or JSON, prototype Object or none) —
 *  never an array, Map, Date, typed array or class instance. */
function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Sorted-key JSON of strings, SAFE INTEGERS, arrays and plain objects.
 *  Returns null for anything else (a float, NaN, a boolean, null, undefined
 *  inside an array, a bigint…): such a record is junk. Undefined object
 *  fields are skipped (so `e` may be absent). */
export function canon(v: unknown): string | null {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    // By index, not map(): map skips the holes of a sparse array.
    for (let i = 0; i < v.length; i++) {
      const c = canon(v[i]);
      if (c === null) return null;
      parts.push(c);
    }
    return `[${parts.join(',')}]`;
  }
  if (isPlain(v)) {
    const parts: string[] = [];
    for (const k of Object.keys(v).sort()) {
      const x = v[k];
      if (x === undefined) continue;
      const c = canon(x);
      if (c === null) return null;
      parts.push(`${JSON.stringify(k)}:${c}`);
    }
    return `{${parts.join(',')}}`;
  }
  return null;
}

const hashOfCanon = (c: string): string => bytesToHex(sha256(utf8ToBytes(`ssf-ct-rec-v1|${c}`))).slice(0, 32);

/** First 32 hex of sha256(utf8('ssf-ct-rec-v1|' + canon(rec))), signature included.
 *  Null when canon is null. */
export function recHash(rec: unknown): string | null {
  const c = canon(rec);
  return c === null ? null : hashOfCanon(c);
}

/** sha256(utf8(`ssf-ct-v1|<kind>|<room>|<t>|<inc>|` + canon(body without g))).
 *  The room, table and incarnation are signed but never stored, so a record
 *  copied into another room, table or incarnation fails verification there.
 *  Throws on a body canon can't encode: nothing should sign junk. */
export function signBytes(kind: SignedKind, ctx: FoldCtx, body: object): Uint8Array {
  // A null-prototype copy: a '__proto__' key stays a key instead of becoming
  // the copy's prototype.
  const rest: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(body)) if (k !== 'g') rest[k] = (body as Record<string, unknown>)[k];
  const c = canon(rest);
  if (c === null) throw new TypeError(`signBytes: a ${kind} body must be canonical`);
  return sha256(utf8ToBytes(`ssf-ct-v1|${kind}|${ctx.room}|${ctx.t}|${ctx.inc}|${c}`));
}

/** `ct:<t>:<inc>` — the table id inside seed commitments and the pocket draw. */
export function seedTable(ctx: FoldCtx): string {
  return `ct:${ctx.t}:${ctx.inc}`;
}

/** The commitment context a slip's seed opens under (fairTableSeeds.commitSeedSync's
 *  ctx; the fold hashes diceFairness.tableCommitMessage itself). */
export function slipCommit(ctx: FoldCtx, r: number, pid: string, seed: string): string {
  const msg = tableCommitMessage(seed, { room: ctx.room, table: seedTable(ctx), round: r, party: pid, house: '' });
  return bytesToHex(sha256(utf8ToBytes(msg)));
}

/** Session id after `cp`: first 24 hex of sha256(utf8('ssf-ct-sid-v1|' +
 *  canon({t, inc, b, u, l, n, e, s}))) — `k` and `g` left out, so two pages
 *  that trim the same history open the same session. 'g' when cp is null.
 *  `s` is a game's carried state (craps): absent, canon skips it, so a
 *  roulette sid is what it always was. */
export function nextSid(ctx: FoldCtx, cp: Pick<Checkpoint, 'b' | 'u' | 'l' | 'n' | 'e' | 's'> | null): string {
  if (!cp) return 'g';
  const c = canon({ t: ctx.t, inc: ctx.inc, b: cp.b, u: cp.u, l: cp.l, n: cp.n, e: cp.e, s: cp.s });
  if (c === null) throw new TypeError('nextSid: the checkpoint must be canonical');
  return bytesToHex(sha256(utf8ToBytes(`ssf-ct-sid-v1|${c}`))).slice(0, 24);
}

/** Turn order for a duty: sha256 hex of `ssf-ct-rank-v1|<duty>|<room>|<t>|<inc>|<round>|<pub>`.
 *  Lower goes first. */
export function dutyRank(duty: 'close' | 'forfeit' | 'abandon' | 'trim', ctx: FoldCtx, round: number, pub: string): string {
  return bytesToHex(sha256(utf8ToBytes(`ssf-ct-rank-v1|${duty}|${ctx.room}|${ctx.t}|${ctx.inc}|${round}|${pub}`)));
}

/** The unbiased pocket (0–36) from the counted seeds: the same bytes as
 *  diceFairness.combinePocketSeeds(seeds, seedTable(ctx), r) with fairDice's
 *  byte-≥-222 rejection, synchronously (fairDice.pocketFromMaterialSync). */
export function pocketOf(ctx: FoldCtx, r: number, seeds: readonly string[]): number {
  const ordered = [...seeds].sort();
  return pocketFromMaterialSync(`ssf-roulette-combine-v1|${ordered.join('|')}|${seedTable(ctx)}|${r}`);
}

// ── Shape guards ─────────────────────────────────────────────────────────────

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A session id: 'g' (the incarnation's first) or nextSid's 24 hex. */
const SID = /^(?:g|[0-9a-f]{24})$/;
/** A close's parent: a session id or a close hash. */
const PARENT = /^(?:g|[0-9a-f]{24}|[0-9a-f]{32})$/;
/** base64url of 32 and of 64 bytes, unpadded (keypair's encoding). Only the
 *  alphabet and length are checked here; verifyIdentityStrict checks that
 *  the spelling is the one canonical one. */
const PUB = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
/** casinoDoc's BOOK_TOTAL without its zeros ("0", "-0"): a zero net is dropped. */
const NET = /^-?[1-9]\d{0,39}$/;

/** casinoDoc isPlayerKey. */
function isPid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && v !== '__proto__';
}

const isRound = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isStr = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v);
const isHex32 = isStr(HEX32);
const isHex64 = isStr(HEX64);
const isSid = isStr(SID);
const isParent = isStr(PARENT);
const isNet = isStr(NET);
const isPub = isStr(PUB);
const isSig = isStr(SIG);

/** Exactly these fields (an undefined field counts as absent, as in canon). */
function hasFields(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  for (const k of Object.keys(o)) {
    if (o[k] !== undefined && !required.includes(k) && !optional.includes(k)) return false;
  }
  return required.every((k) => hasOwn(o, k) && o[k] !== undefined);
}

/** The bet types that carry a `pick` (games/roulette.ts). */
const PICKED: ReadonlySet<string> = new Set(['straight', 'dozen', 'column']);

/** One felt entry, exactly as the table writes it: {type, amount}, plus
 *  `pick` for the bets that have one (isRouletteBet would let a stray pick or
 *  field ride along, and a stray field changes the record's hash). */
function isExactBet(v: unknown): v is RouletteBet {
  if (!isPlain(v) || !isRouletteBet(v)) return false;
  return PICKED.has(v.type) ? hasFields(v, ['type', 'amount', 'pick']) : hasFields(v, ['type', 'amount']);
}

function isFelt(v: unknown): v is RouletteBet[] {
  if (!Array.isArray(v) || v.length > MAX_SLIP_BETS) return false;
  for (let i = 0; i < v.length; i++) if (!isExactBet(v[i])) return false;
  return true;
}

/** Shape guards — each returns the typed record or null (junk). */
export function asSlip(v: unknown): SlipRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'p', 'v', 'b', 'c', 'k', 'g'])) return null;
  return isRound(v.r) && isPid(v.p) && isRound(v.v) && isFelt(v.b) && isHex64(v.c) && isPub(v.k) && isSig(v.g)
    ? (v as unknown as SlipRec) : null;
}

export function asClose(v: unknown): CloseRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'q', 'f', 'k', 'g'])) return null;
  if (!isRound(v.r) || !isParent(v.q) || !isPub(v.k) || !isSig(v.g) || !isPlain(v.f)) return null;
  const pids = Object.keys(v.f);
  if (pids.length < 1 || pids.length > MAX_FROZEN) return null;
  const f = v.f;
  return pids.every((pid) => isPid(pid) && isHex32(f[pid])) ? (v as unknown as CloseRec) : null;
}

export function asReveal(v: unknown): RevealRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'p', 's'])) return null;
  return isRound(v.r) && isPid(v.p) && isHex64(v.s) ? (v as unknown as RevealRec) : null;
}

export function asForfeit(v: unknown): ForfeitRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'x', 'n', 'k', 'g'])) return null;
  if (!isRound(v.r) || !isHex32(v.x) || !isPub(v.k) || !isSig(v.g)) return null;
  const n = v.n;
  if (!Array.isArray(n) || n.length < 1 || n.length > MAX_FROZEN) return null;
  for (let i = 0; i < n.length; i++) {
    // Sorted and unique: one spelling per set, so one hash per forfeit.
    if (!isPid(n[i]) || (i > 0 && !(n[i - 1] < n[i]))) return null;
  }
  return v as unknown as ForfeitRec;
}

export function asAbandon(v: unknown): AbandonRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'x', 'k', 'g'])) return null;
  return isRound(v.r) && isHex32(v.x) && isPub(v.k) && isSig(v.g) ? (v as unknown as AbandonRec) : null;
}

export function asCheckpoint(v: unknown): Checkpoint | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'b', 'u', 'l', 'n', 'k', 'g'], ['e'])) return null;
  return checkpointBody(v);
}

/** The checks every checkpoint shares, once its fields are known. */
function checkpointBody(v: Record<string, unknown>): Checkpoint | null {
  if (v.v !== 1 || !isSid(v.b) || !isRound(v.u) || !isHex32(v.l) || !isPub(v.k) || !isSig(v.g)) return null;
  if (v.e !== undefined && v.e !== 1) return null;
  if (!isPlain(v.n)) return null;
  const n = v.n;
  const pids = Object.keys(n);
  if (pids.length > MAX_CHECKPOINT_PIDS) return null;
  return pids.every((pid) => isPid(pid) && isNet(n[pid])) ? (v as unknown as Checkpoint) : null;
}

/** A stand on a craps slip: one of the table's seven player stands. */
const isStand = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 7;

/** A craps table's slip: the roulette slip's checks, with a canonical craps
 *  felt in `b`, the stamp `o`, and the optional stand `t` and goodbye `l`. */
export function asCrapsSlip(v: unknown): CrapsSlipRec | null {
  if (!isPlain(v) || !hasFields(v, ['r', 'p', 'v', 'b', 'o', 'c', 'k', 'g'], ['t', 'l'])) return null;
  if ((v.t !== undefined && !isStand(v.t)) || (v.l !== undefined && v.l !== 1)) return null;
  return isRound(v.r) && isPid(v.p) && isRound(v.v) && isCanonFelt(v.b) && isHex32(v.o) && isHex64(v.c) && isPub(v.k) && isSig(v.g)
    ? (v as unknown as CrapsSlipRec) : null;
}

/** A carry as a checkpoint stores it, held to every rule CrapsCarry states:
 *  the point one of CARRY_POINTS; at most MAX_RIDERS riders, each a player id
 *  with a canonical felt that has chips on it; a shooter and a last shooter
 *  that are player ids short enough to hold the dice; `i` only with a
 *  shooter. Every carry a roll makes passes it. */
function isCarry(v: unknown): v is CrapsCarry {
  if (!isPlain(v) || !hasFields(v, ['p', 'w'], ['h', 'a', 'i'])) return false;
  if (typeof v.p !== 'number' || !CARRY_POINTS.has(v.p) || !isPlain(v.w)) return false;
  const w = v.w;
  const riders = Object.keys(w);
  if (riders.length > MAX_RIDERS) return false;
  for (const pid of riders) {
    const f = w[pid];
    if (!isPid(pid) || !isCanonFelt(f) || f.length === 0) return false;
  }
  const shooter = (x: unknown): boolean => x === undefined || (isPid(x) && x.length <= MAX_SHOOTER_PID);
  if (!shooter(v.h) || !shooter(v.a)) return false;
  return v.i === undefined || (v.i === 1 && v.h !== undefined);
}

/** A craps table's checkpoint: a live one carries the state its next roll
 *  plays from (`s`, required); an ended one carries none. */
export function asCrapsCheckpoint(v: unknown): Checkpoint | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'b', 'u', 'l', 'n', 'k', 'g'], ['e', 's'])) return null;
  if (v.e === 1 ? v.s !== undefined : !isCarry(v.s)) return null;
  return checkpointBody(v);
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export type RecKind = 's' | 'c' | 'x' | 'f' | 'z';

/** A session key's parts, parsed from both ends (r and h hold no ':', a pid
 *  may), or null for a key no record could be stored under. Only the key:
 *  the fold still checks it against the key computed from the body. */
export function parseKey(key: string): { kind: RecKind; r: number; pid?: string; h: string } | null {
  if (typeof key !== 'string' || key[1] !== ':') return null;
  const kind = key[0];
  if (kind !== 's' && kind !== 'c' && kind !== 'x' && kind !== 'f' && kind !== 'z') return null;
  const last = key.lastIndexOf(':');
  const second = key.indexOf(':', 2);
  if (second < 0) return null;
  const h = key.slice(last + 1);
  const rText = key.slice(2, second);
  const r = Number(rText);
  if (!HEX32.test(h) || !/^[1-9]\d*$/.test(rText) || !Number.isSafeInteger(r)) return null;
  if (kind === 's' || kind === 'x') {
    const pid = key.slice(second + 1, last);
    return second < last && isPid(pid) ? { kind, r, pid, h } : null;
  }
  return second === last ? { kind, r, h } : null;
}

/** The key a record must be stored under (null for junk). */
export function slipKey(rec: SlipRec): string | null {
  const s = asSlip(rec);
  const h = s && recHash(s);
  return s && h ? `s:${s.r}:${s.p}:${h}` : null;
}
export function closeKey(rec: CloseRec): string | null {
  const c = asClose(rec);
  const h = c && recHash(c);
  return c && h ? `c:${c.r}:${h}` : null;
}
export function revealKey(rec: RevealRec): string | null {
  const x = asReveal(rec);
  const h = x && recHash(x);
  return x && h ? `x:${x.r}:${x.p}:${h}` : null;
}
export function forfeitKey(rec: ForfeitRec): string | null {
  const f = asForfeit(rec);
  const h = f && recHash(f);
  return f && h ? `f:${f.r}:${h}` : null;
}
export function abandonKey(rec: AbandonRec): string | null {
  const z = asAbandon(rec);
  const h = z && recHash(z);
  return z && h ? `z:${z.r}:${h}` : null;
}

// ── Verification (injected) ──────────────────────────────────────────────────

/**
 * The key a page pinned for a player (casinoDoc readPlayerKey, or its own),
 * undefined while none has shown up. The caller's: it may change as keys
 * show up (TableFold.keysChanged).
 */
export type KeyOf = (pid: string) => string | undefined;

/**
 * The verdict for one signed record, by its recHash. true/false = checked;
 * undefined = not checked yet (the caller ran out of this pass's time budget
 * and will re-run the fold once it has). The caller owns caching and the
 * budget; for one (hash) it must always give the same final verdict.
 * The real one is keypair.verifyIdentityStrict(k, signBytes(kind, ctx, body), g).
 */
export type SigCheck = (hash: string, kind: SignedKind, pub: string, bytes: () => Uint8Array, sig: string) => boolean | undefined;

// ── Output ───────────────────────────────────────────────────────────────────

export interface SlipInfo { key: string; hash: string; rec: AnySlipRec }

export type Decision = 'reveals' | 'forfeit' | 'void';

export interface RoundView {
  r: number;
  /** recHash of the chosen close. */ close: string;
  closeRec: CloseRec;
  /** pid → slip hash, as the close froze them. */ frozen: Record<string, string>;
  /** P: frozen pids whose slip is present, verified and valid for (r, pid). Sorted. */ present: string[];
  /** M: frozen pids whose slip is absent, pending, invalid, or (at roulette) empty. Sorted. Never staked. */ missing: string[];
  /** Pids in P with a reveal that opens their slip's `c`. Sorted. */ revealed: string[];
  /** null while undecided. */ decided: Decision | null;
  /** Pids whose seeds made the pocket (sorted); [] when undecided or void. */ counted: string[];
  /** The deciding forfeit, when decided === 'forfeit'. */ forfeit?: { hash: string; rec: ForfeitRec };
  /** The deciding abandon, when decided === 'void'. */ abandon?: { hash: string; rec: AbandonRec };
  /** 0–36 when decided by reveals or forfeit; null otherwise. */ pocket: number | null;
  /** pid (P) → stake, payout and delta (payout − stake; 0 when void).
   *  While undecided only `stakes` is filled; on a void every payout is 0
   *  (nobody is counted) and so is every delta. Read-only: the fold reuses them. */
  stakes: Map<string, bigint>;
  payouts: Map<string, bigint>;
  deltas: Map<string, bigint>;
  /** At craps: the roll as the game played it (absent at roulette). */ craps?: CrapsRoll;
}

/** One craps roll as the fold played it. At craps a RoundView's stakes,
 *  payouts and deltas cover every rider as well as P: riding bets play
 *  whether or not their player wrote a slip. `payouts` is `credited`. */
export interface CrapsRoll {
  /** When decided by reveals or a forfeit; null otherwise. */ dice: [number, number] | null;
  pointBefore: number | null;
  /** The point after the roll (as before while undecided or on a void). */ pointAfter: number | null;
  sevenOut: boolean;
  /** pid → how its slip was taken (computedCraps RollFate). */ fates: Map<string, RollFate>;
  /** Decided only: pid → chips returned to it. */ credited: Map<string, bigint>;
  /** Decided only: pid → chips it added this roll and lost to a late seed. */ lost: Map<string, bigint>;
  /** Decided only: pid → won or lost this roll, for pids with a bet decided on it. */ amounts: Map<string, bigint>;
  /** Pids whose only bets decided this roll were pushes. */ pushes: Set<string>;
  /** The carry it played from, and the one it hands the next roll (sIn while undecided). */
  sIn: CrapsCarry;
  sOut: CrapsCarry;
}

export interface FoldBase {
  /** The live session's id. */ sid: string;
  /** Last round the checkpoint covers (0 with no checkpoint). */ u: number;
  /** Close hash of round u (null with no checkpoint). */ l: string | null;
  /** Checkpoint nets (empty with no checkpoint). */ n: Map<string, bigint>;
  /** The checkpoint says the incarnation ended: the session counts nothing
   *  (no rounds, no felts, nothing held; the nets are the checkpoint's). */ ended: boolean;
  /** The game's carried state at the base (FoldGame.start): null at roulette. */ state: unknown;
}

export interface FoldResult {
  base: FoldBase;
  /** The chosen chain since the base: every decided round, then — if the walk
   *  stopped on one — the undecided chosen close (also in `tip`). */
  rounds: RoundView[];
  /** The undecided chosen close of the open round, or null. */ tip: RoundView | null;
  /** The open round: tip.r, else (last decided round, or base.u) + 1. */ open: number;
  /** Hash a close for `open` must name as `q` (base.sid, or the last decided close). */ parent: string;
  /** Every indexed close for `open` naming `parent`, with its standing
   *  (by dutyRank('close'), then hash). */
  openCloses: { hash: string; rec: CloseRec; state: 'valid' | 'pending' | 'invalid' }[];
  /** pid → latest verified slip version on `open` by (v, hash), including empty
   *  ones; given a keyOf, only versions signed by keyOf(pid) (none while it is
   *  undefined). */
  felts: Map<string, SlipInfo>;
  /** base.n + Σ deltas of the decided rounds. Zero entries dropped. */ nets: Map<string, bigint>;
  /** pid → chips on the felt now: P's stakes if `tip`, else what the game
   *  says the felts hold (FoldGame.standing: at roulette each felt's stake).
   *  Zero entries dropped. (casinoDoc counts it only while the incarnation is live.) */
  held: Map<string, bigint>;
  /** The game's carried state after the last decided round on the chain
   *  (the base's with none): what the open round plays from. Null at roulette. */
  carry: unknown;
  /** Commitments a reveal in this session has opened (any slip, any round). */ revealedCommits: Set<string>;
  /** Some verdict was undefined: run again once the caller has checked more. */ pending: boolean;
  /** Σ (key.length + canon(value).length) over indexed records. */ bytes: number;
  /** Σ (key.length + an estimate of the value's size) over EVERY key of the
   *  live session, junk included (rawSize): what the session weighs in the
   *  doc, which junk grows as much as records do. */ rawBytes: number;
  /** Indexed record count. */ records: number;
}

// ── Games ────────────────────────────────────────────────────────────────────

/** A frozen or felt slip as the fold indexed it. */
export interface SlipEntry extends EntryBase<'s', AnySlipRec>, Signed {
  /** Σ amounts — at most 400 × MAX_BET_AMOUNT, so exact as a number first. */
  stake: bigint;
}

/** How one close was decided, before the game plays it: a RoundView's
 *  decision fields, plus the seeds that opened P's slips. */
export type Outcome = Pick<RoundView, 'present' | 'missing' | 'revealed' | 'decided' | 'counted' | 'forfeit' | 'abandon'> & {
  /** pid (P) → the seed its reveal gave, for every revealed pid. */
  seeds: ReadonlyMap<string, string>;
};

/** What a game made of one decided (or undecided) close. */
export interface Play<S> {
  /** 0–36 at roulette when decided by reveals or a forfeit; else null. */ pocket: number | null;
  /** As RoundView's: while undecided only `stakes` is filled. */
  stakes: Map<string, bigint>;
  payouts: Map<string, bigint>;
  deltas: Map<string, bigint>;
  /** The carried state the next round plays from (unused while undecided). */ sOut: S;
  /** A craps roll's detail, for the round's view. */ craps?: CrapsRoll;
}

/**
 * The rules one game plays a round by. Everything else in the fold — which
 * closes count, how a round is decided, which chain wins — is the same for
 * every game and never reads the carried state, so a round is decided the
 * same way whatever came before it; only what it pays can depend on that.
 * Pure, like the fold.
 */
export interface FoldGame<S> {
  /** The slip shape this game's records use (the session keys are the same). */
  asSlip(v: unknown): AnySlipRec | null;
  /** The checkpoint shape (a game with carried state stores it as `s`). */
  asCheckpoint(v: unknown): Checkpoint | null;
  /** Whether a close may freeze this slip so that it counts: roulette needs
   *  a felt with something on it. */
  frozenOk(s: SlipEntry): boolean;
  /** The carried state a session starts from (null cp: a new incarnation). */
  start(cp: Checkpoint | null): S;
  /** A short string that changes whenever `s` does (a memo key). */
  key(s: S): string;
  /** Play round r of close `out` (P: the frozen slips present, by pid; M: the
   *  frozen pids missing) from carried state `sIn`. */
  play(ctx: FoldCtx, r: number, out: Outcome, P: ReadonlyMap<string, SlipEntry>, M: readonly string[], sIn: S): Play<S>;
  /** What each player holds on the felt while no close is in (the open
   *  round's latest versions, `felts`), from carried state `sIn`. */
  standing(sIn: S, felts: ReadonlyMap<string, SlipInfo>, stakeOf: (hash: string) => bigint): Map<string, bigint>;
}

/** Roulette: every round stands alone. A counted player is paid what the
 *  pocket pays its felt; nothing carries from one spin to the next. */
export const rouletteGame: FoldGame<null> = {
  asSlip,
  asCheckpoint,
  frozenOk: (s) => s.rec.b.length > 0,
  start: () => null,
  key: () => '',
  play(ctx, r, out, P) {
    const pocket = out.decided === 'reveals' || out.decided === 'forfeit'
      ? pocketOf(ctx, r, out.counted.map((pid) => out.seeds.get(pid)!))
      : null;
    const stakes = new Map<string, bigint>();
    const payouts = new Map<string, bigint>();
    const deltas = new Map<string, bigint>();
    const inPocket = new Set(out.counted);
    for (const [pid, s] of P) {
      stakes.set(pid, s.stake);
      if (!out.decided) continue;
      // Only a counted pid is paid, and nobody is counted on a void. resolveRound
      // under a fixed key: a pid like 'constructor' must not read the result
      // object's prototype.
      const won = pocket !== null && inPocket.has(pid) ? resolveRound({ bettor: (s.rec as SlipRec).b }, pocket).bettor ?? 0 : 0;
      const payout = BigInt(won);
      payouts.set(pid, payout);
      // A void moves nothing: the stake was only ever held, and stops being held.
      deltas.set(pid, out.decided === 'void' ? 0n : payout - s.stake);
    }
    return { pocket, stakes, payouts, deltas, sOut: null };
  },
  standing(_sIn, felts, stakeOf) {
    const held = new Map<string, bigint>();
    for (const [pid, f] of felts) {
      const stake = stakeOf(f.hash);
      if (stake) held.set(pid, stake);
    }
    return held;
  },
};

/** A memo key per carry, by identity: a carry is never changed once made,
 *  and the walk hands the same objects back from the play memo. */
const carryKeys = new WeakMap<CrapsCarry, string>();

/** A craps slip as computedCraps plays it, from carry `sIn`. */
function rollSlip(rec: CrapsSlipRec, sIn: CrapsCarry): RollSlip {
  const basisOk = rec.o === basisOf(sIn, rec.p);
  return rec.t === undefined ? { b: rec.b, basisOk } : { b: rec.b, basisOk, t: rec.t };
}

const bigints = (m: ReadonlyMap<string, number>): Map<string, bigint> => {
  const out = new Map<string, bigint>();
  for (const [pid, n] of m) out.set(pid, BigInt(n));
  return out;
};

/** Craps: one round is one roll, played by computedCraps from the state the
 *  rolls before it left (the point, the bets riding, who holds the dice). */
export const crapsGame: FoldGame<CrapsCarry> = {
  asSlip: asCrapsSlip,
  asCheckpoint: asCrapsCheckpoint,
  // A take-down-all is a real change at craps (riding bets come down), so a
  // close may freeze an empty felt; signerPresent still needs chips.
  frozenOk: () => true,
  start: (cp) => (cp?.s ? { ...cp.s, w: nullProtoCopy(cp.s.w) } : EMPTY_CARRY),
  key(s) {
    let k = carryKeys.get(s);
    if (k === undefined) {
      k = bytesToHex(sha256(utf8ToBytes(canon(s)!))).slice(0, 32);
      carryKeys.set(s, k);
    }
    return k;
  },
  play(ctx, r, out, P, _M, sIn) {
    // A pid only in M plays as a rider if it has riding bets, else not at all.
    const slips = new Map<string, RollSlip>();
    for (const [pid, s] of P) slips.set(pid, rollSlip(s.rec as CrapsSlipRec, sIn));
    const dice = out.decided === 'reveals' || out.decided === 'forfeit'
      ? diceOf(seedTable(ctx), r, out.counted.map((pid) => out.seeds.get(pid)!))
      : null;
    const roll = playRoll({ sIn, slips, decided: out.decided, counted: out.counted, dice });
    const credited = bigints(roll.credited);
    return {
      pocket: null,
      stakes: bigints(roll.stakes),
      payouts: credited,
      deltas: bigints(roll.deltas),
      sOut: roll.sOut,
      craps: {
        dice, pointBefore: roll.pointBefore, pointAfter: roll.pointAfter, sevenOut: roll.sevenOut, fates: roll.fates,
        credited, lost: bigints(roll.lost), amounts: bigints(roll.amounts), pushes: roll.pushes, sIn, sOut: roll.sOut,
      },
    };
  },
  standing(sIn, felts) {
    const latest = new Map<string, RollSlip>();
    for (const [pid, f] of felts) latest.set(pid, rollSlip(f.rec as CrapsSlipRec, sIn));
    return bigints(standingOf(sIn, latest));
  },
};

export type GameName = 'roulette' | 'craps';

/** The game an incarnation plays, from its name: `k…` craps, else roulette. */
export function gameOfInc(inc: string): GameName {
  return inc[0] === 'k' ? 'craps' : 'roulette';
}

/** The rules an incarnation's rounds are played by. */
export function foldGameOf(ctx: Pick<FoldCtx, 'inc'>): FoldGame<unknown> {
  return gameOfInc(ctx.inc) === 'craps' ? (crapsGame as FoldGame<unknown>) : (rouletteGame as FoldGame<unknown>);
}

/** The slip reader for an incarnation's game. */
export function asSlipFor(ctx: Pick<FoldCtx, 'inc'>): (v: unknown) => AnySlipRec | null {
  return foldGameOf(ctx).asSlip;
}

/** The key a slip must be stored under at an incarnation (null for junk
 *  there, such as the other game's slip). */
export function slipKeyFor(ctx: Pick<FoldCtx, 'inc'>): (rec: unknown) => string | null {
  const read = foldGameOf(ctx).asSlip;
  return (rec) => {
    const s = read(rec);
    const h = s && recHash(s);
    return s && h ? `s:${s.r}:${s.p}:${h}` : null;
  };
}

/** The checkpoint reader for an incarnation's game. */
export function asCheckpointFor(ctx: Pick<FoldCtx, 'inc'>): (v: unknown) => Checkpoint | null {
  return foldGameOf(ctx).asCheckpoint;
}

// ── The index ────────────────────────────────────────────────────────────────

export interface EntryBase<K extends RecKind, R> {
  kind: K;
  key: string;
  hash: string;
  rec: R;
  /** key.length + canon(rec).length */
  size: number;
}
export interface Signed {
  /** The final verdict, once the SigCheck gave one. */
  verdict?: boolean;
  /** dutyRank for this record's duty, computed on first use. */
  rank?: string;
}
interface CloseEntry extends EntryBase<'c', CloseRec>, Signed {
  /** Memo of closeInfo, valid while this round's slip set is unchanged. */
  info?: { ver: number; info: CloseInfo };
  /** Memo of signerPresent, the same way. */
  signer?: { ver: number; ok: boolean };
  /** Memo of decide, valid while this round's slips and reveals and this
   *  close's forfeits and abandons are unchanged. */
  decision?: { key: string; d: Outcome };
  /** Memo of the game's play: valid for that very decision (the same
   *  object decide's memo hands back) from the same carried state. */
  play?: { d: Outcome; sKey: string; p: Play<unknown> };
}
interface RevealEntry extends EntryBase<'x', RevealRec> {
  /** The commitment this seed opens (slipCommit of the reveal's own r, p, s). */
  commit: string;
}
type ForfeitEntry = EntryBase<'f', ForfeitRec> & Signed;
type AbandonEntry = EntryBase<'z', AbandonRec> & Signed;
type Entry = SlipEntry | CloseEntry | RevealEntry | ForfeitEntry | AbandonEntry;

/** A close's frozen slips, split. */
interface CloseInfo {
  state: 'valid' | 'pending' | 'invalid';
  /** P, by pid, in pid order. */
  P: Map<string, SlipEntry>;
  /** M, sorted. */
  M: string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** About what a stored value weighs: its canonical length when it has one,
 *  else its JSON length, else a flat 64 (a bigint, a function, a cycle, a
 *  walk too deep). Never throws: it sizes junk too. */
function rawSize(value: unknown): number {
  try {
    const c = canon(value);
    if (c !== null) return c.length;
  } catch { /* too deep to walk: try JSON, then the flat size */ }
  try {
    const j = JSON.stringify(value);
    if (typeof j === 'string') return j.length;
  } catch { /* unserializable */ }
  return 64;
}

/** Two-level map helpers: inner maps are created on demand and dropped once
 *  empty, so nothing grows past what is indexed. */
function addIn<K1, K2, V>(m: Map<K1, Map<K2, V>>, k1: K1, k2: K2, v: V): void {
  let inner = m.get(k1);
  if (!inner) m.set(k1, (inner = new Map()));
  inner.set(k2, v);
}
function dropIn<K1, K2, V>(m: Map<K1, Map<K2, V>>, k1: K1, k2: K2): void {
  const inner = m.get(k1);
  if (!inner) return;
  inner.delete(k2);
  if (!inner.size) m.delete(k1);
}
function countIn<K>(m: Map<K, number>, k: K, d: 1 | -1): void {
  const n = (m.get(k) ?? 0) + d;
  if (n > 0) m.set(k, n);
  else m.delete(k);
}

// ── The fold ─────────────────────────────────────────────────────────────────

/**
 * One computed incarnation's fold. The caller (casinoDoc bindComputed) owns
 * the Yjs side: it calls setBase whenever the checkpoint or the live session
 * map changes, apply() with each changed key of the live session map
 * (undefined = deleted), and result() once per transaction.
 *
 * result() must equal a fold built cold from the same checkpoint and record
 * set, for any order and batching of apply() calls (tests pin this).
 * It memoizes per-close decisions (by close hash + a version of that round's
 * reveal set + a version of that close's forfeit/abandon set) and slip
 * stakes, so a warm pass costs O(changed keys + closes in the session).
 *
 * HOW: apply() only maintains indexes, bumping a version for whatever it
 * touched (a round's slips, a round's reveals, a close's forfeits and
 * abandons). result() then re-walks every close in the session — cheap, at
 * most 32 per round × 500 rounds, and a deeper decided chain anywhere can
 * flip an earlier choice — but each close's split into P and M, and its
 * decision, come from a memo keyed by those versions. Final verdicts never
 * change, so a memo is kept only when nothing it read was pending.
 */
export class TableFold {
  readonly ctx: FoldCtx;
  private readonly check: SigCheck;
  private readonly keyOf: KeyOf | undefined;
  private readonly game: FoldGame<unknown>;
  private base: FoldBase = { sid: 'g', u: 0, l: null, n: new Map(), ended: false, state: null };

  private entries = new Map<string, Entry>();
  private slipsByHash = new Map<string, SlipEntry>();
  /** r → pid → hash → slip */
  private slipsAt = new Map<number, Map<string, Map<string, SlipEntry>>>();
  /** slip `c` → how many indexed slips carry it */
  private slipCommits = new Map<string, number>();
  /** r → hash → close */
  private closesAt = new Map<number, Map<string, CloseEntry>>();
  /** r → pid → hash → reveal: a junk reveal sits beside the real one. */
  private revealsAt = new Map<number, Map<string, Map<string, RevealEntry>>>();
  /** commitment a reveal opens → how many reveals open it */
  private revealCommits = new Map<string, number>();
  /** close hash → hash → forfeit / abandon */
  private forfeitsOf = new Map<string, Map<string, ForfeitEntry>>();
  private abandonsOf = new Map<string, Map<string, AbandonEntry>>();

  /** Versions: the value of `clock` when the thing last changed. */
  private clock = 0;
  private slipVer = new Map<number, number>();
  private revealVer = new Map<number, number>();
  private ffaVer = new Map<string, number>();

  private bytes = 0;
  /** key → rawSize-based weight of every key of the live session, junk too. */
  private raw = new Map<string, number>();
  private rawBytes = 0;
  private dirty = true;
  private last: FoldResult | null = null;
  /** Set by ask() when a verdict comes back undefined. */
  private sawPending = false;

  /** `keyOf`, when given, pins each player's felt to one key: a slip
   *  version counts for `felts` (and so for `held` while betting) only if
   *  `k === keyOf(p)`. Without it, any verified version does — and a page
   *  could sign a version under someone else's pid with a high `v` and hold
   *  their chips until a close froze the real one. Closes, decisions and
   *  nets don't read it: a close froze what its signer pinned.
   *  `game` is the rules the rounds are played by: by default the game the
   *  incarnation's name says (foldGameOf). */
  constructor(ctx: FoldCtx, check: SigCheck, keyOf?: KeyOf, game: FoldGame<unknown> = foldGameOf(ctx)) {
    this.ctx = ctx;
    this.check = check;
    this.keyOf = keyOf;
    this.game = game;
    this.base = { ...this.base, state: game.start(null) };
  }

  /** Point at the incarnation's checkpoint (null = none) — the live session id
   *  follows from it (nextSid). A changed sid clears the index. A checkpoint
   *  that fails the game's asCheckpoint counts as none. */
  setBase(cp: Checkpoint | null): void {
    const ok = cp === null ? null : this.game.asCheckpoint(cp);
    const sid = nextSid(this.ctx, ok);
    // The sid hashes everything the base holds (all but k and g), so the
    // same sid is the same base: nothing to redo.
    if (sid === this.base.sid) return;
    this.clearIndex();
    const n = new Map<string, bigint>();
    if (ok) for (const pid of Object.keys(ok.n).sort()) n.set(pid, BigInt(ok.n[pid]));
    this.base = { sid, u: ok ? ok.u : 0, l: ok ? ok.l : null, n, ended: ok?.e === 1, state: this.game.start(ok) };
    this.dirty = true;
  }

  /** Index changed keys of the live session map. Junk is ignored; a key whose
   *  value changed is re-indexed; undefined removes it. */
  apply(changes: Iterable<readonly [key: string, value: unknown]>): void {
    for (const [key, value] of changes) this.put(key, value);
  }

  /** Re-index the whole session (a replaced or new session map). */
  reset(entries: Iterable<readonly [key: string, value: unknown]>): void {
    this.clearIndex();
    this.apply(entries);
  }

  /** keyOf may answer differently now (a player's key showed up): the next
   *  result() reads it again. */
  keysChanged(): void {
    this.dirty = true;
  }

  /** The fold's output (cached until the next setBase/apply/reset, or until a
   *  pending verdict may have changed — always recompute when the last result
   *  was pending). Read-only: the maps and sets are the fold's own. */
  result(): FoldResult {
    if (this.last && !this.dirty && !this.last.pending) return this.last;
    this.last = this.compute();
    this.dirty = false;
    return this.last;
  }

  // ── Indexing ──────────────────────────────────────────────────────────────

  private clearIndex(): void {
    this.entries.clear();
    this.slipsByHash.clear();
    this.slipsAt.clear();
    this.slipCommits.clear();
    this.closesAt.clear();
    this.revealsAt.clear();
    this.revealCommits.clear();
    this.forfeitsOf.clear();
    this.abandonsOf.clear();
    this.slipVer.clear();
    this.revealVer.clear();
    this.ffaVer.clear();
    this.bytes = 0;
    this.raw.clear();
    this.rawBytes = 0;
    this.dirty = true;
  }

  private put(key: string, value: unknown): void {
    const old = this.entries.get(key);
    const next = value === undefined ? null : this.entryFor(key, value);
    this.weigh(key, value === undefined ? undefined : next ? next.size : key.length + rawSize(value));
    // The same record again (a re-put, or a fresh copy of the same bytes):
    // keep the old entry, its verdict and its memos.
    if (old && next && old.hash === next.hash) return;
    if (!old && !next) return;
    if (old) this.unindex(old);
    if (next) this.index(next);
    this.dirty = true;
  }

  /** The entry for a record stored under `key`, or null for junk: an
   *  unknown kind, a bad shape, or a key that isn't the body's own. The shape
   *  comes first, so canon only ever walks a small, known structure. */
  private entryFor(key: string, value: unknown): Entry | null {
    const pk = parseKey(key);
    if (!pk) return null;
    const rec = pk.kind === 's' ? this.game.asSlip(value)
      : pk.kind === 'c' ? asClose(value)
      : pk.kind === 'x' ? asReveal(value)
      : pk.kind === 'f' ? asForfeit(value)
      : asAbandon(value);
    const c = rec && canon(rec);
    if (!rec || c === null) return null;
    const hash = hashOfCanon(c);
    const who = pk.kind === 's' || pk.kind === 'x' ? `${(rec as SlipRec | RevealRec).p}:` : '';
    if (key !== `${pk.kind}:${rec.r}:${who}${hash}`) return null;
    const size = key.length + c.length;
    switch (pk.kind) {
      case 's': {
        const slip = rec as AnySlipRec;
        const stake = BigInt((slip.b as readonly { amount: number }[]).reduce((sum, bet) => sum + bet.amount, 0));
        return { kind: 's', key, hash, rec: slip, size, stake };
      }
      case 'c':
        return { kind: 'c', key, hash, rec: rec as CloseRec, size };
      case 'x': {
        const x = rec as RevealRec;
        return { kind: 'x', key, hash, rec: x, size, commit: slipCommit(this.ctx, x.r, x.p, x.s) };
      }
      case 'f':
        return { kind: 'f', key, hash, rec: rec as ForfeitRec, size };
      case 'z':
        return { kind: 'z', key, hash, rec: rec as AbandonRec, size };
    }
  }

  /** Keep `rawBytes` in line with one key's weight (undefined: gone). A
   *  change of weight is a change of output; the same weight again is none. */
  private weigh(key: string, size: number | undefined): void {
    const was = this.raw.get(key);
    if (was === size) return;
    if (was !== undefined) this.rawBytes -= was;
    if (size === undefined) this.raw.delete(key);
    else {
      this.raw.set(key, size);
      this.rawBytes += size;
    }
    this.dirty = true;
  }

  private index(e: Entry): void {
    this.entries.set(e.key, e);
    this.bytes += e.size;
    const now = ++this.clock;
    switch (e.kind) {
      case 's': {
        this.slipsByHash.set(e.hash, e);
        let byPid = this.slipsAt.get(e.rec.r);
        if (!byPid) this.slipsAt.set(e.rec.r, (byPid = new Map()));
        addIn(byPid, e.rec.p, e.hash, e);
        countIn(this.slipCommits, e.rec.c, 1);
        this.slipVer.set(e.rec.r, now);
        break;
      }
      case 'c':
        addIn(this.closesAt, e.rec.r, e.hash, e);
        break;
      case 'x': {
        let byPid = this.revealsAt.get(e.rec.r);
        if (!byPid) this.revealsAt.set(e.rec.r, (byPid = new Map()));
        addIn(byPid, e.rec.p, e.hash, e);
        countIn(this.revealCommits, e.commit, 1);
        this.revealVer.set(e.rec.r, now);
        break;
      }
      case 'f':
        addIn(this.forfeitsOf, e.rec.x, e.hash, e);
        this.ffaVer.set(e.rec.x, now);
        break;
      case 'z':
        addIn(this.abandonsOf, e.rec.x, e.hash, e);
        this.ffaVer.set(e.rec.x, now);
        break;
    }
  }

  private unindex(e: Entry): void {
    this.entries.delete(e.key);
    this.bytes -= e.size;
    const now = ++this.clock;
    switch (e.kind) {
      case 's': {
        this.slipsByHash.delete(e.hash);
        const byPid = this.slipsAt.get(e.rec.r);
        if (byPid) {
          dropIn(byPid, e.rec.p, e.hash);
          if (!byPid.size) this.slipsAt.delete(e.rec.r);
        }
        countIn(this.slipCommits, e.rec.c, -1);
        this.slipVer.set(e.rec.r, now);
        break;
      }
      case 'c':
        dropIn(this.closesAt, e.rec.r, e.hash);
        break;
      case 'x': {
        const byPid = this.revealsAt.get(e.rec.r);
        if (byPid) {
          dropIn(byPid, e.rec.p, e.hash);
          if (!byPid.size) this.revealsAt.delete(e.rec.r);
        }
        countIn(this.revealCommits, e.commit, -1);
        this.revealVer.set(e.rec.r, now);
        break;
      }
      case 'f':
        dropIn(this.forfeitsOf, e.rec.x, e.hash);
        this.ffaVer.set(e.rec.x, now);
        break;
      case 'z':
        dropIn(this.abandonsOf, e.rec.x, e.hash);
        this.ffaVer.set(e.rec.x, now);
        break;
    }
  }

  // ── Verdicts and ranks ────────────────────────────────────────────────────

  /** The record's verdict: cached once final, undefined while the caller
   *  hasn't checked it (which marks this pass pending). */
  private ask(e: SlipEntry | CloseEntry | ForfeitEntry | AbandonEntry, kind: SignedKind): boolean | undefined {
    if (e.verdict !== undefined) return e.verdict;
    const rec = e.rec;
    const v = this.check(e.hash, kind, rec.k, () => signBytes(kind, this.ctx, rec), rec.g);
    if (v === undefined) {
      this.sawPending = true;
      return undefined;
    }
    e.verdict = v === true;
    return e.verdict;
  }

  private rankOf(e: CloseEntry | ForfeitEntry | AbandonEntry): string {
    if (e.rank === undefined) {
      const duty = e.kind === 'c' ? 'close' : e.kind === 'f' ? 'forfeit' : 'abandon';
      e.rank = dutyRank(duty, this.ctx, e.rec.r, e.rec.k);
    }
    return e.rank;
  }

  private byRank = (a: CloseEntry | ForfeitEntry | AbandonEntry, b: CloseEntry | ForfeitEntry | AbandonEntry): number =>
    cmp(this.rankOf(a), this.rankOf(b)) || cmp(a.hash, b.hash);

  // ── One close ─────────────────────────────────────────────────────────────

  /** The slip `c` froze for `pid`, if it is present and could be staked:
   *  this round, this pid, and one the game lets a close freeze (at roulette
   *  a felt with something on it). Its signature is the caller's to check. */
  private frozenSlip(c: CloseEntry, pid: string): SlipEntry | null {
    const s = this.slipsByHash.get(c.rec.f[pid]);
    return s && s.rec.r === c.rec.r && s.rec.p === pid && this.game.frozenOk(s) ? s : null;
  }

  /** The cheap half of "k is the pub of a present, valid slip it freezes,
   *  with something on it": everything but the signatures. A close that
   *  fails it is never even checked; one that passes still needs closeInfo
   *  before it takes a place in its round's cap. (A game may let a close
   *  freeze an empty felt, never sign over one.) */
  private signerPresent(c: CloseEntry): boolean {
    const ver = this.slipVer.get(c.rec.r) ?? 0;
    if (c.signer && c.signer.ver === ver) return c.signer.ok;
    let ok = false;
    for (const pid of Object.keys(c.rec.f)) {
      const s = this.frozenSlip(c, pid);
      if (s && s.rec.k === c.rec.k && s.rec.b.length > 0) { ok = true; break; }
    }
    c.signer = { ver, ok };
    return ok;
  }

  /** Verify a close and split its frozen pids into P and M. Pending when its
   *  own verdict or a frozen slip's is: it counts as not arrived yet. */
  private closeInfo(c: CloseEntry): CloseInfo {
    const ver = this.slipVer.get(c.rec.r) ?? 0;
    if (c.info && c.info.ver === ver) return c.info.info;
    const outer = this.sawPending;
    this.sawPending = false;
    const P = new Map<string, SlipEntry>();
    const M: string[] = [];
    let state: CloseInfo['state'];
    const own = this.ask(c, 'close');
    if (own === false) {
      state = 'invalid';
    } else {
      let slipPending = false;
      for (const pid of Object.keys(c.rec.f).sort()) {
        const s = this.frozenSlip(c, pid);
        const ok = s ? this.ask(s, 'slip') : false;
        if (ok === undefined) slipPending = true;
        else if (ok) P.set(pid, s!);
        else M.push(pid);
      }
      if (own === undefined || slipPending) state = 'pending';
      else {
        let signer = false;
        for (const s of P.values()) if (s.rec.k === c.rec.k && s.rec.b.length > 0) signer = true;
        state = signer ? 'valid' : 'invalid';
      }
    }
    const info: CloseInfo = { state, P, M };
    if (!this.sawPending) c.info = { ver, info };
    this.sawPending = outer || this.sawPending;
    return info;
  }

  /** The seed a reveal of (r, pid) gives for commitment `c`, if any: some
   *  `x:<r>:<pid>:*` whose seed opens it. */
  private seedFor(r: number, pid: string, c: string): string | null {
    const mine = this.revealsAt.get(r)?.get(pid);
    if (mine) for (const x of mine.values()) if (x.commit === c) return x.rec.s;
    return null;
  }

  /** The first of `cands` (sorted by rank) whose signature verifies, among
   *  the first MAX_FORFEITS_PER_CLOSE that might. A record whose verdict is
   *  false takes no place in the cap: otherwise copies of a real forfeit
   *  with garbage in `g` could push it out of the running for nothing. One
   *  still pending holds its place until checked (the pass is pending then). */
  private bestVerified<E extends ForfeitEntry | AbandonEntry>(cands: readonly E[], kind: 'forfeit' | 'abandon'): E | null {
    let considered = 0;
    for (const e of cands) {
      const ok = this.ask(e, kind);
      if (ok === false) continue;
      if (ok) return e;
      if (++considered >= MAX_FORFEITS_PER_CLOSE) break;
    }
    return null;
  }

  /** Decide a valid close: (a) the best valid forfeit, (b) every reveal in
   *  with nothing missing, (c) a verified abandon (void), (d) undecided.
   *  What it pays is the game's (playOf), not this. */
  private decide(c: CloseEntry, info: CloseInfo): Outcome {
    const r = c.rec.r;
    const key = `${this.slipVer.get(r) ?? 0}|${this.revealVer.get(r) ?? 0}|${this.ffaVer.get(c.hash) ?? 0}`;
    if (c.decision && c.decision.key === key) return c.decision.d;
    const outer = this.sawPending;
    this.sawPending = false;

    const { P, M } = info;
    const present = [...P.keys()];
    const seeds = new Map<string, string>();
    for (const [pid, s] of P) {
      const seed = this.seedFor(r, pid, s.rec.c);
      if (seed !== null) seeds.set(pid, seed);
    }
    const revealed = present.filter((pid) => seeds.has(pid));

    let decided: Decision | null = null;
    let counted: string[] = [];
    let forfeit: Outcome['forfeit'];
    let abandon: Outcome['abandon'];

    // (a) A forfeit counts only seeds that are in (n ⊆ P, all revealed), and
    // only if its writer counts itself — so no round is decided on zero seeds.
    const forfeits = this.forfeitsOf.get(c.hash);
    if (forfeits) {
      const cands: ForfeitEntry[] = [];
      for (const f of forfeits.values()) {
        if (f.rec.r !== r || !f.rec.n.every((pid) => seeds.has(pid))) continue;
        if (!f.rec.n.some((pid) => P.get(pid)!.rec.k === f.rec.k)) continue;
        cands.push(f);
      }
      const f = this.bestVerified(cands.sort(this.byRank), 'forfeit');
      if (f) {
        decided = 'forfeit';
        counted = [...f.rec.n];
        forfeit = { hash: f.hash, rec: f.rec };
      }
    }
    // (b) Every frozen slip present, every seed in.
    if (!decided && M.length === 0 && revealed.length === present.length) {
      decided = 'reveals';
      counted = present;
    }
    // (c) Nobody can finish it: void.
    const abandons = decided ? undefined : this.abandonsOf.get(c.hash);
    if (abandons) {
      const z = this.bestVerified([...abandons.values()].filter((x) => x.rec.r === r).sort(this.byRank), 'abandon');
      if (z) {
        decided = 'void';
        abandon = { hash: z.hash, rec: z.rec };
      }
    }

    const d: Outcome = {
      present, missing: M, revealed, decided, counted,
      ...(forfeit ? { forfeit } : {}), ...(abandon ? { abandon } : {}),
      seeds,
    };
    if (!this.sawPending) c.decision = { key, d };
    this.sawPending = outer || this.sawPending;
    return d;
  }

  /** The game's play of close `c`, decided as `d`, from carried state `sIn`. */
  private playOf(c: CloseEntry, info: CloseInfo, d: Outcome, sIn: unknown): Play<unknown> {
    const sKey = this.game.key(sIn);
    if (c.play && c.play.d === d && c.play.sKey === sKey) return c.play.p;
    const p = this.game.play(this.ctx, c.rec.r, d, info.P, info.M, sIn);
    // Only for a decision decide kept: one made over a pending verdict is
    // made again next pass, and its play with it.
    if (c.decision?.d === d) c.play = { d, sKey, p };
    return p;
  }

  // ── The whole session ─────────────────────────────────────────────────────

  private compute(): FoldResult {
    this.sawPending = false;
    const { sid, u } = this.base;
    // An ended incarnation plays no more rounds: a session map under the sid
    // its final checkpoint names is junk someone wrote after the end (no
    // build opens one), and counts nothing. The checkpoint's nets are all
    // there is. (It still weighs what it weighs: rawBytes.)
    if (this.base.ended) {
      return {
        base: this.base, rounds: [], tip: null, open: u + 1, parent: sid, openCloses: [], felts: new Map(),
        nets: new Map(this.base.n), held: new Map(), carry: this.base.state, revealedCommits: new Set(),
        pending: false, bytes: this.bytes, rawBytes: this.rawBytes, records: this.entries.size,
      };
    }

    // 1. Round by round from the base: which closes are eligible, and which
    //    of those are decided. A close is eligible only under an eligible,
    //    decided parent, so the first round with nothing decided ends it.
    const states = new Map<string, 'valid' | 'pending' | 'invalid'>();
    const infos = new Map<string, CloseInfo>();
    const outcomes = new Map<string, Outcome>();
    const eligible: CloseEntry[][] = [];
    let decidedBefore = new Set<string>();
    for (let i = 0; i < MAX_SESSION_ROUNDS; i++) {
      const atR = this.closesAt.get(u + 1 + i);
      if (!atR) break;
      const cands: CloseEntry[] = [];
      for (const c of atR.values()) {
        if (i === 0 ? c.rec.q !== sid : !decidedBefore.has(c.rec.q)) continue;
        if (this.signerPresent(c)) cands.push(c);
      }
      cands.sort(this.byRank);
      const ok: CloseEntry[] = [];
      const decidedHere = new Set<string>();
      // The cap counts only closes that might still be valid. One whose own
      // signature, or whose signer's slip, has failed takes no place in it, so
      // closes nobody signed (a made-up pub, or a real close's copy with
      // garbage in `g`) can't push the real one out and stall the round; each
      // costs one cached check. A pending close holds its place until checked.
      let considered = 0;
      for (const c of cands) {
        if (considered >= MAX_CLOSES_PER_ROUND) break;
        const info = this.closeInfo(c);
        states.set(c.hash, info.state);
        if (info.state === 'invalid') continue;
        considered++;
        if (info.state !== 'valid') continue;
        ok.push(c);
        infos.set(c.hash, info);
        const d = this.decide(c, info);
        outcomes.set(c.hash, d);
        if (d.decided) decidedHere.add(c.hash);
      }
      eligible.push(ok);
      if (!decidedHere.size) break;
      decidedBefore = decidedHere;
    }

    // 2. Scores, deepest round first (no recursion): a decided close scores
    //    one more than its best eligible child; an undecided one scores 0.
    const score = new Map<string, number>();
    for (let i = eligible.length - 1; i >= 0; i--) {
      const bestChild = new Map<string, number>();
      for (const k of eligible[i + 1] ?? []) {
        bestChild.set(k.rec.q, Math.max(bestChild.get(k.rec.q) ?? 0, score.get(k.hash)!));
      }
      for (const c of eligible[i]) score.set(c.hash, outcomes.get(c.hash)!.decided ? 1 + (bestChild.get(c.hash) ?? 0) : 0);
    }

    // 3. Walk from the base: the highest score, then the lowest closeRank,
    //    then the lowest hash. Stop on the first undecided pick (the tip).
    //    Each pick is played by the game from the state the rounds before it
    //    left; rival branches are decided (step 2 needs that) but never played.
    const rounds: RoundView[] = [];
    let tip: RoundView | null = null;
    let parent = sid;
    let state = this.base.state;
    for (let i = 0; i < eligible.length; i++) {
      let best: CloseEntry | null = null;
      for (const c of eligible[i]) {
        if (c.rec.q !== parent) continue;
        if (!best) { best = c; continue; }
        const ds = score.get(c.hash)! - score.get(best.hash)!;
        if (ds > 0 || (ds === 0 && this.byRank(c, best) < 0)) best = c;
      }
      if (!best) break;
      const { seeds: _seeds, ...d } = outcomes.get(best.hash)!;
      const play = this.playOf(best, infos.get(best.hash)!, outcomes.get(best.hash)!, state);
      const view: RoundView = {
        r: best.rec.r, close: best.hash, closeRec: best.rec, frozen: best.rec.f, ...d,
        pocket: play.pocket, stakes: play.stakes, payouts: play.payouts, deltas: play.deltas,
        ...(play.craps ? { craps: play.craps } : {}),
      };
      rounds.push(view);
      if (!view.decided) { tip = view; break; }
      parent = best.hash;
      state = play.sOut;
    }
    const open = tip ? tip.r : u + rounds.length + 1;

    const openCloses: FoldResult['openCloses'] = [];
    const atOpen = this.closesAt.get(open);
    if (atOpen) {
      const naming = [...atOpen.values()].filter((c) => c.rec.q === parent).sort(this.byRank);
      for (const c of naming) openCloses.push({ hash: c.hash, rec: c.rec, state: states.get(c.hash) ?? 'invalid' });
    }

    // 4. The felt now: each player's latest verified version on the open
    //    round — given keyOf, of those signed by the player's pinned key
    //    (checked first: a version under the wrong key is never verified).
    const felts = new Map<string, SlipInfo>();
    const atOpenSlips = this.slipsAt.get(open);
    if (atOpenSlips) {
      for (const pid of [...atOpenSlips.keys()].sort()) {
        const pinned = this.keyOf?.(pid);
        if (this.keyOf && pinned === undefined) continue; // no key yet: no felt
        const versions = [...atOpenSlips.get(pid)!.values()].sort((a, b) => (b.rec.v - a.rec.v) || cmp(b.hash, a.hash));
        for (const s of versions) {
          if (this.keyOf && s.rec.k !== pinned) continue;
          if (this.ask(s, 'slip')) {
            felts.set(pid, { key: s.key, hash: s.hash, rec: s.rec });
            break;
          }
        }
      }
    }

    let held = new Map<string, bigint>();
    if (tip) {
      for (const [pid, stake] of tip.stakes) if (stake) held.set(pid, stake);
    } else {
      held = this.game.standing(state, felts, (hash) => this.slipsByHash.get(hash)!.stake);
    }

    const sums = new Map(this.base.n);
    for (const v of rounds) {
      if (!v.decided) continue;
      for (const [pid, d] of v.deltas) sums.set(pid, (sums.get(pid) ?? 0n) + d);
    }
    const nets = new Map<string, bigint>();
    for (const pid of [...sums.keys()].sort()) {
      const n = sums.get(pid)!;
      if (n !== 0n) nets.set(pid, n);
    }

    const revealedCommits = new Set<string>();
    for (const c of [...this.revealCommits.keys()].sort()) if (this.slipCommits.has(c)) revealedCommits.add(c);

    return {
      base: this.base,
      rounds,
      tip,
      open,
      parent,
      openCloses,
      felts,
      nets,
      held,
      carry: state,
      revealedCommits,
      pending: this.sawPending,
      bytes: this.bytes,
      rawBytes: this.rawBytes,
      records: this.entries.size,
    };
  }
}
