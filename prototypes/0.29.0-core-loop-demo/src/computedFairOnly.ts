/**
 * 🔒 FAIR ONLY tables: their names, records and bytes (PR 6c-1 of "Computed
 * casino tables"; design-final.md section 8).
 *
 * PURE, like computedFold: no Yjs, no Date, no Math.random, no doc state. A
 * FAIR ONLY table is a house table that never plays without its house: every
 * round is decided by the house's reveal, and only the house of the owner who
 * opened the game (or of a buyer the owner's deed offer was made out to) can
 * checkpoint or end it, so a peer can't fake its checkpoints, end a craps
 * table mid-point or stop it for good. This file holds what the records are
 * and what bytes they sign; which of them count (the chain of authority, the
 * base) is the resolver's, and how they are played is the fold's.
 *
 * THE LETTERS. `p` is roulette and `q` is craps, as `r` and `d` are at an
 * ordinary house table. A build that doesn't know them reads a `p`/`q` name as
 * junk, which is how a v0.50 page stays out of a FAIR ONLY table.
 *
 * THE NAME BINDS THE AUTHORITY (faironlyInc):
 *   inc = letter + first 24 hex of sha256("ssf-computed-faironly-inc-v1|"
 *         + letter|q(room)|q(t)|q(rv)|q(ok)|q(j)|ts)
 * where q is JSON.stringify, so that a room or table id holding a `|` can't
 * make one name of two different (room, table) pairs. `ok` is the identity
 * key of the owner who opened the game, `j` 16 random hex (so every switch-on
 * makes a new name), `rv` the rules version and `ts` the opening time (it
 * only dates the deed offers that may move the game).
 * Every checkpoint carries those four and is read only if they hash to the
 * incarnation it sits under, so a record can't claim another authority for
 * the same name, and a later rewrite of `roomInfo.owner` changes nothing
 * about who signs for it.
 *
 * RECORDS, at the top level of `casinoComputed`, beside `sum:` and `hs:`:
 *   ck:<t>:<inc>:<id>   checkpoint      write-once; <id> = first 32 hex of
 *                                       sha256("ssf-ck-id-v1|" + canon(value)),
 *                                       so a value that doesn't hash to its key
 *                                       is junk, and an overwrite can only junk
 *                                       a key, never replace a checkpoint
 *   fin:<t>:<inc>       end order       {v:1, k, g}: "this game is ending"; it
 *                                       names no round, and an `e:1` checkpoint
 *                                       must embed one
 *   xf:<t>:<inc>:<id>   transfer        {v:1, o, u, k, g}: the seller's signed
 *                                       deed offer, made out to the buyer `k`,
 *                                       and the round `u` the game moves at
 *   do:<nonce>          deed offer      the offer itself, kept so the buyer's
 *                                       page can write the transfer later
 * and the live session `ses:<t>:<inc>:<nextSid3(cp)>`, whose records are the
 * fold's. A checkpoint's `value` includes every field, so `k` and `g` too.
 *
 * Signed bytes are computedFold's: sha256("ssf-ct-v1|<kind>|<room>|<t>|<inc>|"
 * + canon(body without g)), kind `ck`, `fin` or `xf`. The live session's id
 * (nextSid3) binds the room, and `w` gives a sweep its own session.
 *
 * Nothing here is wired to a table yet: no count, page or node reads these
 * records until the PRs after this one. test-vectors/computed-checkpoint-v1.json
 * pins the bytes for the owner's node (house_bytes.rs), as computed-house-v1
 * does for PR 5's.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  canon, hasFields, isCarry, isHex32, isHex64, isHouseSumOutcome, isNet, isPid, isPlain, isPub, isSig, MAX_TABLE_PIDS, signBytes, U_MAX,
} from './computedFold';
import type { Checkpoint, FoldCtx } from './computedFold';
import { asDelegation } from './computedHouse';
import type { DelegationRec } from './computedHouse';

// ── Constants (design §8.9) ──────────────────────────────────────────────────

/** The rules version this build plays FAIR ONLY tables by. It is in the name,
 *  so a fix to the rules never strands a game already open: every build keeps
 *  every version it served, and one that doesn't know a version reads the
 *  table as UPDATE TO PLAY (`newer`). */
export const FAIR_ONLY_RV = 'f1';
/** The rules versions this build knows. */
const KNOWN_RV: ReadonlySet<string> = new Set([FAIR_ONLY_RV]);
export const isKnownRv = (rv: string): boolean => KNOWN_RV.has(rv);

/** A checkpoint heavier than this (see weightOf) is junk, unhashed: it bounds
 *  what junk costs to hash, and to read (the node reads a room's records
 *  within 4 MiB a tick). A game the fold lets be never reaches it: at most
 *  MAX_TABLE_PIDS players, whose ids total at most MAX_TABLE_PID_BYTES, with
 *  40-digit nets, a craps carry and the transfers weigh some 1.3 MB at the
 *  very worst (the specs build that game). */
export const MAX_CHECKPOINT_BYTES = 1.5 * 1024 * 1024;
/** The UTF-8 bytes the ids of a game's players may total, beside
 *  MAX_TABLE_PIDS (its checkpoint's nets and every slip its session froze): a
 *  close that would pass it is invalid (S6 (e), the fold's, PR 6c-3). An id
 *  is up to 256 UTF-16 units, up to 768 bytes, so without this 4,000 of them
 *  could take a checkpoint past MAX_CHECKPOINT_BYTES and no trim could be
 *  written. An honest id is a 43-character key: this is some 6 times what
 *  4,000 of those take. */
export const MAX_TABLE_PID_BYTES = 1_000_000;
/** Transfers of authority a game's chain follows. */
export const MAX_TRANSFERS = 8;
/** A deed offer made before the game opened can't move it (a sale-back
 *  replay); this much earlier than the game's `ts` is allowed for clocks. */
export const OFFER_SKEW_MS = 600_000;
/** The longest maker or room name an offer may carry in a transfer record. */
export const MAX_OFFER_TEXT = 256;
/** `l` of a checkpoint that closed no round. */
export const NO_CLOSE = '0'.repeat(32);

// ── The letters ──────────────────────────────────────────────────────────────

export type FairOnlyLetter = 'p' | 'q';
export type FairOnlyGame = 'roulette' | 'craps';

/** The game each FAIR ONLY letter plays. */
export const FAIR_ONLY_GAMES: Readonly<Record<FairOnlyLetter, FairOnlyGame>> = Object.freeze({ p: 'roulette', q: 'craps' });

const FAIR_ONLY_INC = /^[pq][0-9a-f]{24}$/;

/** Whether an incarnation name is a FAIR ONLY table's (`p…` or `q…`). */
export const isFairOnlyInc = (inc: unknown): inc is string => typeof inc === 'string' && FAIR_ONLY_INC.test(inc);

// ── Names ────────────────────────────────────────────────────────────────────

/** What a FAIR ONLY name is made of besides the letter, the room and the table. */
export interface FairOnlyName {
  /** The rules version. */ rv: string;
  /** The identity key (base64url) of the owner who opened the game. */ ok: string;
  /** 16 random hex. */ j: string;
  /** The owner page's clock at switch-on (a safe integer, ms). */ ts: number;
}

/** The incarnation name: the letter and the first 24 hex of
 *  sha256("ssf-computed-faironly-inc-v1|<letter>|<room>|<t>|<rv>|<ok>|<j>|<ts>"),
 *  each text field as JSON.stringify spells it: a room or table id may hold a
 *  `|`, and unquoted, (`a|b`, `c`) and (`a`, `b|c`) would make one name. Every
 *  signature of a FAIR ONLY record covers its incarnation, so the name is
 *  what binds a record to its room and table. */
export function faironlyInc(letter: FairOnlyLetter, room: string, t: string, n: FairOnlyName): string {
  const q = JSON.stringify;
  const pre = `ssf-computed-faironly-inc-v1|${letter}|${q(room)}|${q(t)}|${q(n.rv)}|${q(n.ok)}|${q(n.j)}|${n.ts}`;
  return letter + bytesToHex(sha256(utf8ToBytes(pre))).slice(0, 24);
}

// ── Records ──────────────────────────────────────────────────────────────────

/** The end order of a game: signed by an authority key (never a house). */
export interface FinRec { v: 1; k: string; g: string }

/** A deed offer made out to a person, as a transfer record or a `do:` record
 *  holds it: the offers.ts TransferOffer of a deed, with a recipient. */
export interface DeedOffer {
  v: 1;
  kind: 'transfer-offer';
  asset: { kind: 'deed'; roomId: string; roomName: string };
  makerPub: string;
  makerName: string;
  toPub: string;
  price: 0;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  sig: string;
}

/** A transfer of the game's authority from the offer's maker to `k`, at round `u`. */
export interface XferRec { v: 1; o: DeedOffer; u: number; k: string; g: string }

/** A FAIR ONLY checkpoint (design §8.2 a). */
export interface CkRec {
  v: 1;
  /** The name's inputs (faironlyInc). */
  ok: string;
  j: string;
  rv: string;
  ts: number;
  /** The session it closes: 'g' only on the opening root, else a nextSid3. */
  b: string;
  /** The last round folded (0 on the root). */
  u: number;
  /** Sweeps at this `u`; absent means 0. */
  w?: number;
  /** recHash of round u's close (NO_CLOSE iff u = 0). */
  l: string;
  /** How round u was decided: 'h:' + the house reveal's hash, or 'z:' + the abandon's. */
  d?: string;
  /** Round u's outcome, when the house decided it: a pocket, or the dice. */
  o?: number | [number, number];
  /** pid → net since the incarnation opened (computedFold's NET strings). */
  n: Record<string, string>;
  /** 1 = ended; then `f` is the authority's end order. */
  e?: 1;
  f?: FinRec;
  /** Craps only, while live: the carry the next roll plays from. */
  s?: Checkpoint['s'];
  /** The commitment the next round must name. */
  h?: string;
  /** Who delegated the signer (`dl.h === k`), or on the root the owner's house. */
  dl?: DelegationRec;
  /** The transfers from `ok` to this record's authority, in chain order. */
  x?: XferRec[];
  k: string;
  g: string;
}

// ── Bytes ────────────────────────────────────────────────────────────────────

/** First 32 hex of sha256("ssf-ck-id-v1|" + canon(value)); null when canon is.
 *  The value is the whole record, `g` included. */
export function ckId(value: unknown): string | null {
  const c = canon(value);
  return c === null ? null : bytesToHex(sha256(utf8ToBytes(`ssf-ck-id-v1|${c}`))).slice(0, 32);
}

/** First 32 hex of sha256("ssf-xf-id-v1|" + canon(value)); null when canon is. */
export function xfId(value: unknown): string | null {
  const c = canon(value);
  return c === null ? null : bytesToHex(sha256(utf8ToBytes(`ssf-xf-id-v1|${c}`))).slice(0, 32);
}

/** The live session after a FAIR ONLY checkpoint: the first 24 hex of
 *  sha256("ssf-ct-sid-v3|" + canon({room, t, inc, b, u, w, l, d, o, n, e, s, h})),
 *  absent fields left out. It leaves out `ok`, `j`, `rv`, `ts` (bound through
 *  `inc`) and `k`, `g`, `f`, `dl`, `x`, so two authorities signing the same
 *  state open the same session, which is what lets a transfer keep the game
 *  going. Unlike computedFold's nextSid it binds the room, and `w` gives a
 *  sweep a session of its own. */
export function nextSid3(ctx: FoldCtx, cp: Pick<CkRec, 'b' | 'u' | 'w' | 'l' | 'd' | 'o' | 'n' | 'e' | 's' | 'h'>): string {
  const c = canon({
    room: ctx.room, t: ctx.t, inc: ctx.inc, b: cp.b, u: cp.u, w: cp.w, l: cp.l, d: cp.d, o: cp.o, n: cp.n, e: cp.e, s: cp.s, h: cp.h,
  });
  if (c === null) throw new TypeError('nextSid3: the checkpoint must be canonical');
  return bytesToHex(sha256(utf8ToBytes(`ssf-ct-sid-v3|${c}`))).slice(0, 24);
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export const ckKey = (t: string, inc: string, id: string): string => `ck:${t}:${inc}:${id}`;
export const finKey = (t: string, inc: string): string => `fin:${t}:${inc}`;
export const xfKey = (t: string, inc: string, id: string): string => `xf:${t}:${inc}:${id}`;
export const doKey = (nonce: string): string => `do:${nonce}`;

export type FairOnlyKey =
  | { kind: 'ck' | 'xf'; t: string; inc: string; id: string }
  | { kind: 'fin'; t: string; inc: string }
  | { kind: 'do'; nonce: string };

// The table id may hold ':', so keys parse from the right, where the
// incarnation and the id have a fixed spelling.
const KEY_ID = /^(ck|xf):([\s\S]+):([pq][0-9a-f]{24}):([0-9a-f]{32})$/;
const KEY_FIN = /^fin:([\s\S]+):([pq][0-9a-f]{24})$/;
const NONCE = /^[0-9a-f]{24}$/;

/** A top-level casinoComputed key's FAIR ONLY parts, or null for any other
 *  key (or one no record could be stored under). */
export function parseFairOnlyKey(key: string): FairOnlyKey | null {
  if (typeof key !== 'string') return null;
  const m = KEY_ID.exec(key);
  if (m) return { kind: m[1] as 'ck' | 'xf', t: m[2], inc: m[3], id: m[4] };
  const f = KEY_FIN.exec(key);
  if (f) return { kind: 'fin', t: f[1], inc: f[2] };
  if (key.startsWith('do:') && NONCE.test(key.slice(3))) return { kind: 'do', nonce: key.slice(3) };
  return null;
}

// ── Weight ───────────────────────────────────────────────────────────────────

/** Nesting a record may have and still be weighed (the Rust twin's MAX_DEPTH). */
export const MAX_WEIGHT_DEPTH = 16;

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3; // a BMP character, or a lone surrogate (TextEncoder writes U+FFFD)
  }
  return n;
}

/** About what a value weighs as JSON — the Rust twin of house_bytes.rs
 *  `weight`, so a page and the node agree on which record is too heavy to
 *  read: a string its UTF-8 bytes and two quotes, a number (or anything not a
 *  string, array or object) 8, an array two brackets and a comma for each
 *  member, an object two braces and for each field its key's bytes and 4.
 *  An undefined field weighs like any other (its key, 4, and 8 for the
 *  value): a peer can write one and no reader counts it, and the node weighs
 *  it as padding, so a page that skipped it would call a record light that
 *  the node calls too heavy to read. It is charged at the field and takes no
 *  depth of its own (the node does not visit it), where an undefined member
 *  of an array is visited, one level down, like any member. Weighed only as
 *  far as `cap` and MAX_WEIGHT_DEPTH: null past either, so finding a heavy
 *  value out costs about `cap` however big it is (an object's keys are listed
 *  once, and the value is in memory already: that costs about what holding it
 *  did). */
export function weightOf(v: unknown, cap: number): number | null {
  let total = 0;
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length > 0) {
    const [x, depth] = stack.pop() as [unknown, number];
    if (depth > MAX_WEIGHT_DEPTH) return null;
    if (typeof x === 'string') {
      // A string is at least a byte a UTF-16 unit: past the cap without measuring.
      if (x.length > cap) return null;
      total += utf8Length(x) + 2;
    } else if (x instanceof Uint8Array) {
      total += x.length + 2;
    } else if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        total += 1;
        if (total > cap) return null;
        stack.push([x[i], depth + 1]);
      }
      total += 2;
    } else if (isPlain(x)) {
      for (const k of Object.keys(x)) {
        if (k.length > cap) return null;
        total += utf8Length(k) + 4;
        const field = x[k];
        // An undefined field is charged where it stands and not visited, as the
        // node charges it: it takes no depth of its own.
        if (field === undefined) total += 8;
        if (total > cap) return null;
        if (field !== undefined) stack.push([field, depth + 1]);
      }
      total += 2;
    } else {
      total += 8;
    }
    if (total > cap) return null;
  }
  return total;
}

// ── Readers ──────────────────────────────────────────────────────────────────

const HEX16 = /^[0-9a-f]{16}$/;
const HEX24 = /^[0-9a-f]{24}$/;
/** A rules version's spelling (a build that doesn't know one still reads it). */
const RV = /^[a-z][a-z0-9]{0,7}$/;
/** How a round was decided, as a checkpoint says: a house reveal or an abandon. */
const CK_D = /^[hz]:[0-9a-f]{32}$/;

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Whether `s` has no unpaired surrogate. Yjs writes a string as UTF-8, which
 *  has none, so a peer reads U+FFFD where this page holds one, and nothing
 *  signed or hashed over the text (the maker's signature, the id of the
 *  record that holds it) would hold there: the page that wrote it would
 *  count a transfer no other page can read. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1); // NaN past the end
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_OFFER_TEXT && wellFormed(v);

/** A fin: {v:1, k, g}. The signature is the resolver's to check. */
export function asFin(v: unknown): FinRec | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'k', 'g'])) return null;
  return v.v === 1 && isPub(v.k) && isSig(v.g) ? (v as unknown as FinRec) : null;
}

/** A deed offer made out to a person, for `room`: the offers.ts shape with a
 *  directed recipient and nothing a company offer adds, held to the sizes and
 *  integers the node ports (only integers, short names). Whether the maker
 *  signed it, and whether it is for this game, are the resolver's. */
export function asDeedOffer(v: unknown, room: string): DeedOffer | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'kind', 'asset', 'makerPub', 'makerName', 'toPub', 'price', 'issuedAt', 'expiresAt', 'nonce', 'sig'])) return null;
  if (v.v !== 1 || v.kind !== 'transfer-offer') return null;
  const a = v.asset;
  if (!isPlain(a) || !hasFields(a, ['kind', 'roomId', 'roomName'])) return null;
  if (a.kind !== 'deed' || a.roomId !== room || !isText(a.roomName)) return null;
  if (!isPub(v.makerPub) || !isText(v.makerName) || !isPub(v.toPub) || !isSig(v.sig)) return null;
  if (v.price !== 0 || !isCount(v.issuedAt) || !isCount(v.expiresAt)) return null;
  return typeof v.nonce === 'string' && NONCE.test(v.nonce) ? (v as unknown as DeedOffer) : null;
}

/** A transfer of authority: {v:1, o, u, k, g} with a deed offer made out to
 *  the buyer `k` (design §8.2 c). Whether the maker's and the buyer's
 *  signatures hold, and whether the offer is newer than the game, are the
 *  resolver's. */
export function asXf(v: unknown, room: string): XferRec | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'o', 'u', 'k', 'g'])) return null;
  if (v.v !== 1 || !isSig(v.g) || !Number.isSafeInteger(v.u) || (v.u as number) < 0 || (v.u as number) > U_MAX) return null;
  // (The buyer's key `k` is a key because it is the offer's `toPub`, which is one.)
  const o = asDeedOffer(v.o, room);
  return o && o.toPub === v.k ? (v as unknown as XferRec) : null;
}

/** A `do:<nonce>` value: a deed offer made out to a person, under its own nonce. */
export function asDo(key: string, v: unknown, room: string): DeedOffer | null {
  const k = parseFairOnlyKey(key);
  if (!k || k.kind !== 'do') return null;
  const o = asDeedOffer(v, room);
  return o && o.nonce === k.nonce ? o : null;
}

/** What reading a `ck:` key's value gives. */
export type CkRead =
  | { kind: 'ok'; t: string; inc: string; id: string; letter: FairOnlyLetter; ck: CkRec }
  /** Well formed as far as the name goes, but of a rules version this build
   *  doesn't know: the table reads UPDATE TO PLAY, and nothing of it counts. */
  | { kind: 'newer'; t: string; inc: string; rv: string }
  | { kind: 'junk' };

const JUNK: CkRead = Object.freeze({ kind: 'junk' });

/** The carry a craps table opens with, `{p: 0, w: {}}`, as canon spells it. */
const OPENING_CARRY_CANON = '{"p":0,"w":{}}';

/** Whether `s` is the carry a craps table opens with. By canon's spelling, so
 *  that a field left undefined is no field here, as it is in the record's id. */
function isOpeningCarry(s: unknown): boolean {
  return canon(s) === OPENING_CARRY_CANON;
}

/** The checks of design §8.3 S0 on a value whose name has been settled: the
 *  fields and their forms, and the rules that tie them together. Signatures,
 *  authority and the id are not here. */
function ckBody(v: Record<string, unknown>, room: string, letter: FairOnlyLetter): CkRec | null {
  if (!hasFields(v, ['v', 'ok', 'j', 'rv', 'ts', 'b', 'u', 'l', 'n', 'k', 'g'], ['w', 'd', 'o', 'e', 'f', 's', 'h', 'dl', 'x'])) return null;
  if (v.v !== 1 || !isPub(v.k) || !isSig(v.g)) return null;
  const u = v.u;
  if (!Number.isSafeInteger(u) || (u as number) < 0 || (u as number) > U_MAX) return null;
  const root = v.b === 'g';
  // `b` names the session a checkpoint closes: 'g' only on the opening root.
  if (root ? u !== 0 : typeof v.b !== 'string' || !HEX24.test(v.b)) return null;
  // `l` is the close of round u: none at u = 0, always one after.
  if (u === 0 ? v.l !== NO_CLOSE : !isHex32(v.l) || v.l === NO_CLOSE) return null;
  if (v.w !== undefined && !(Number.isSafeInteger(v.w) && (v.w as number) >= 1)) return null;
  // `d` says how round u was decided, so it is there exactly after a round.
  if (u === 0 ? v.d !== undefined : typeof v.d !== 'string' || !CK_D.test(v.d)) return null;
  if (v.o !== undefined && !(typeof v.d === 'string' && v.d.startsWith('h:') && isHouseSumOutcome(v.o, letter === 'q'))) return null;
  // The nets: since the incarnation opened, so none before a round.
  if (!isPlain(v.n)) return null;
  // (A player whose net is undefined is no player, as in the record's id.)
  const pids = Object.keys(v.n).filter((pid) => (v.n as Record<string, unknown>)[pid] !== undefined);
  if (pids.length > MAX_TABLE_PIDS || (u === 0 && pids.length > 0)) return null;
  if (!pids.every((pid) => isPid(pid) && isNet((v.n as Record<string, unknown>)[pid]))) return null;
  // An end carries the authority's end order, and nothing a live game plays on.
  if (v.e !== undefined && v.e !== 1) return null;
  const ended = v.e === 1;
  if (ended !== (v.f !== undefined)) return null;
  if (v.f !== undefined && !asFin(v.f)) return null;
  if (ended && (v.s !== undefined || v.h !== undefined || v.w !== undefined)) return null;
  // The craps carry: there while live, only at craps, and the opening one at u = 0.
  if (letter === 'q' && !ended ? !isCarry(v.s) : v.s !== undefined) return null;
  if (u === 0 && v.s !== undefined && !isOpeningCarry(v.s)) return null;
  // The commitment the next round must name: none before the house has joined one.
  if (v.h !== undefined && (!isHex64(v.h) || u === 0)) return null;
  // Who delegated the signer. The root's names the owner's house; any other
  // record's names the signer itself, as a house.
  if (v.dl !== undefined) {
    const dl = asDelegation(v.dl);
    if (!dl || (root ? dl.k !== v.ok : dl.h !== v.k)) return null;
  }
  // The transfers that brought the game to this record's authority.
  if (v.x !== undefined) {
    if (!Array.isArray(v.x) || v.x.length < 1 || v.x.length > MAX_TRANSFERS) return null;
    for (let i = 0; i < v.x.length; i++) if (!asXf(v.x[i], room)) return null;
  }
  if (root) {
    // The root: signed by the owner who opened the game, naming that owner's house.
    if (v.k !== v.ok || v.dl === undefined || v.w !== undefined || v.e !== undefined || v.x !== undefined) return null;
  } else if (u === 0 && v.w === undefined && !ended) {
    // At u = 0 the only records after the root are a sweep of its session and an end.
    return null;
  }
  return v as unknown as CkRec;
}

/** Reads the value stored at a `ck:` key (design §8.3 S0): the key parses, the
 *  value is no heavier than MAX_CHECKPOINT_BYTES, its name inputs hash to the
 *  incarnation it sits under (and this build knows its rules version), its
 *  fields have their forms and agree with each other, and the key's id is the
 *  hash of the value. The signatures and who may sign are the resolver's.
 *  Junk is never deleted for failing this: authority can depend on records
 *  still being put back. */
export function readCk(room: string, key: string, value: unknown): CkRead {
  const pk = parseFairOnlyKey(key);
  if (!pk || pk.kind !== 'ck' || !isPlain(value)) return JUNK;
  if (weightOf(value, MAX_CHECKPOINT_BYTES) === null) return JUNK;
  const { ok, j, rv, ts } = value;
  if (!isPub(ok) || typeof j !== 'string' || !HEX16.test(j) || typeof rv !== 'string' || !RV.test(rv) || !isCount(ts)) return JUNK;
  const letter = pk.inc[0] as FairOnlyLetter;
  if (faironlyInc(letter, room, pk.t, { rv, ok, j, ts }) !== pk.inc) return JUNK;
  if (!isKnownRv(rv)) return { kind: 'newer', t: pk.t, inc: pk.inc, rv };
  const ck = ckBody(value, room, letter);
  if (!ck || ckId(value) !== pk.id) return JUNK;
  return { kind: 'ok', t: pk.t, inc: pk.inc, id: pk.id, letter, ck };
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Signs `bytes`: the signer's identity key for an authority's record, the
 *  house's key for a house's. */
export type Signer = (bytes: Uint8Array) => string;

/** `o` without its undefined fields: canon (so a record's id and signature)
 *  leaves them out, but the doc would keep each as padding the node weighs. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** A checkpoint as its writer stores it: signed under `ctx` (its incarnation
 *  a FAIR ONLY name) and keyed by its own hash. Throws on a body canon refuses. */
export function sealCk(ctx: FoldCtx, body: Omit<CkRec, 'g'>, sign: Signer): { key: string; value: CkRec } {
  const value = defined({ ...body, g: sign(signBytes('ck', ctx, body)) }) as CkRec;
  const id = ckId(value);
  if (id === null) throw new TypeError('sealCk: a checkpoint must be canonical');
  return { key: ckKey(ctx.t, ctx.inc, id), value };
}

/** An end order, signed by an authority key. */
export function sealFin(ctx: FoldCtx, k: string, sign: Signer): { key: string; value: FinRec } {
  const body = { v: 1 as const, k };
  return { key: finKey(ctx.t, ctx.inc), value: { ...body, g: sign(signBytes('fin', ctx, body)) } };
}

/** A transfer of authority, signed by the buyer `body.k`. */
export function sealXf(ctx: FoldCtx, body: Omit<XferRec, 'g'>, sign: Signer): { key: string; value: XferRec } {
  const value = defined({ ...body, g: sign(signBytes('xf', ctx, body)) }) as XferRec;
  const id = xfId(value);
  if (id === null) throw new TypeError('sealXf: a transfer must be canonical');
  return { key: xfKey(ctx.t, ctx.inc, id), value };
}
