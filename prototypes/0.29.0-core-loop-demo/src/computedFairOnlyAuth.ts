/**
 * 🔒 FAIR ONLY tables: who holds a game, and which checkpoint it stands at
 * (PR 6c-2 of "Computed casino tables"; design-final.md section 8.3 S1 to S5,
 * S7 and S9).
 *
 * PURE, like computedFold: no Yjs, no Date, no doc state. A page (and, in
 * Rust, the owner's node) reads the records of one game, `ck:`, `fin:` and
 * `xf:` (computedFairOnly.ts), and this works out from them:
 *
 *   - THE CHAIN of authority: the opener `ok`, then each buyer a seller's
 *     signed deed offer was made out to, in the order the transfers name (S2);
 *   - THE BASE: the best checkpoint a key in range signed (S1, S3), which the
 *     game's live session continues from;
 *   - THE FIN standing, if any (S5), and whether the game is live (S7);
 *   - WHICH KEYS are crypto-invalid, to delete (S1, P7);
 *   - WHICH HOUSE decides which round (S2): a delegation by the key that holds
 *     the game at that round.
 *
 * and, across the live games of one table, which game the table plays (S9).
 *
 * It never reads `roomInfo.owner`: the opener's key is in the game's name, and
 * a deed offer made out to a person is what moves it. A rewrite of the room's
 * owner moves nothing here.
 *
 * SIGNATURES come in through one injected check, as computedFold's do: the
 * caller owns the cache and the time budget, and answers `undefined` for one
 * it hasn't checked yet. Such an answer never decides anything: the pass is
 * `pending`, the answer so far stands on what was checked, and the caller
 * asks again when it has. The check must be the STRICT one (keypair.ts
 * verifyIdentityStrict, ed25519-dalek's verify_strict in the node): the
 * maker's signature on a deed offer included, which offers.ts verifyOffer
 * (the lenient one) does not give. Each is asked about under an id (sigId)
 * that names its record and what the signature binds, so a cache keyed by the
 * id alone can be shared by the games of a room without one game's verdict
 * answering for another's.
 *
 * COST. A record is looked at by its shape first (no signatures), then by
 * whether its signer could hold the game (no signatures), and only then by its
 * signatures. A record signed by a key out of range is skipped, never
 * verified and never deleted; one whose signature fails under the key it
 * claims is crypto-invalid, takes no place, and is reported to be deleted.
 * Nothing else is ever reported: authority can depend on a record that is
 * still being put back.
 */

import { recHash, signBytes } from './computedFold';
import type { FoldCtx } from './computedFold';
import { asFin, MAX_SMALL_RECORD_BYTES, MAX_TRANSFERS, OFFER_SKEW_MS, parseFairOnlyKey, readCk, weightOf, xfId } from './computedFairOnly';
import type { CkRead, CkRec, FairOnlyLetter, FairOnlyName, FinRec, XferRec } from './computedFairOnly';
import { asDelegation, roomSignBytes } from './computedHouse';
import type { DelegationRec } from './computedHouse';
import { asXf } from './computedFairOnly';
import { offerSignBytes } from './offerBytes';
import type { TransferOffer } from './offerBytes';

// ── Constants (design section 8.9) ──────────────────────────────────────────

/** Checkpoints looked at, by their signatures, in one pass (those that fail
 *  under their own claimed key are not counted: they cost one check, once, and
 *  are deleted). */
export const MAX_CK_CANDIDATES = 8;

// ── What the caller gives ────────────────────────────────────────────────────

/** A signature's verdict: true or false once it is checked; `undefined` while
 *  the caller's time budget puts it off. `id` names the signed thing for the
 *  caller's cache (sigId): its record's hash under the kind of signature and,
 *  for a signature over a game's records, the game. The same id always has the
 *  same final verdict, so a cache shared by games, or kept by id alone, never
 *  carries a verdict from one game or one kind of signature to another. */
export type SigCheckFn = (id: string, pub: string, bytes: () => Uint8Array, sig: string) => boolean | undefined;

/** What a signature is over, for sigId. */
export type SigKind = 'ck' | 'fin' | 'xf' | 'offer' | 'hkey';

/** The id a verdict is cached under (SigCheckFn): `hash`, the recHash of the
 *  signed record, signature included, under what the signature binds. A
 *  checkpoint's, an end order's and a transfer's signature cover the table and
 *  the incarnation (signBytes), so the same record copied into another game is
 *  another thing to check there, and its id says so; a deed offer's and a
 *  delegation's cover the room alone, which a cache is kept for. */
export function sigId(kind: SigKind, t: string, inc: string, hash: string): string {
  return kind === 'offer' || kind === 'hkey' ? `${kind}|${hash}` : `${kind}|${t}|${inc}|${hash}`;
}

export interface AuthEnv {
  /** casinoRoomId(): signed into every record, never stored. */
  room: string;
  sig: SigCheckFn;
  /** The session this page folds now, if it has one: a checkpoint that closes
   *  it is the likeliest next base, so it is looked at first. */
  liveSid?: string;
  /** readCk with the caller's memory (a record is read once, not each pass). */
  read?: (key: string, value: unknown) => CkRead;
}

/** The records of ONE game, as the doc holds them (the caller picks them out
 *  by key: `ck:<t>:<inc>:*`, `xf:<t>:<inc>:*`, `fin:<t>:<inc>`), and the
 *  room's delegations (the values of the `hk:` keys). */
export interface AuthRecords {
  cks: Iterable<readonly [string, unknown]>;
  xfs: Iterable<readonly [string, unknown]>;
  fin?: unknown;
  delegations?: Iterable<unknown>;
}

// ── What it gives back ───────────────────────────────────────────────────────

/** A checkpoint that counts, with the key it is stored under. */
export interface Counted { key: string; id: string; ck: CkRec }

/** A transfer that counts. `key` is where the doc holds it, absent for one
 *  found only inside a checkpoint's `x`. */
export interface Step { id: string; xf: XferRec; key?: string }

/** One holder of the game, and the round it holds it from. */
export interface Holder {
  /** The holder's identity key. */ k: string;
  /** The round it took the game at (0 for the opener). */ from: number;
  /** The transfer that moved the game to it (none for the opener). */ step?: Step;
}

export interface Resolution {
  t: string;
  inc: string;
  letter: FairOnlyLetter;
  /** The rules version isn't one this build knows: nothing of the game counts. */
  newer: boolean;
  /** The name's inputs, as any readable record of the game says them. */
  name: FairOnlyName | null;
  /** The holders, in order: `chain[0]` is the opener. Empty when nothing is readable. */
  chain: readonly Holder[];
  /** The key that holds the game now: the chain's last. */
  holder: string | null;
  /** S3: the best checkpoint a key in range signed. Null: the game isn't open. */
  base: Counted | null;
  /** S5: an end order standing at the base. */
  fin: FinRec | null;
  /** S7: there is a base and it isn't an end. */
  live: boolean;
  /** Doc keys of records whose id or signature fails under the key they
   *  claim (`ck:` and `xf:` only): delete them. */
  invalid: readonly string[];
  /** A check was put off, and its answer could still change this one. */
  pending: boolean;
  /** Whether `pub` is a house that decides round `round` of this game: it was
   *  delegated by the key that holds the game for that round. `undefined`
   *  while the delegation's signature is put off. */
  houseAt(pub: string, round: number): boolean | undefined;
}

// ── Reading ──────────────────────────────────────────────────────────────────

function byBest(a: Counted, b: Counted): number {
  // S3: the highest round, then an end, then the most sweeps, then the lowest id.
  return b.ck.u - a.ck.u || (b.ck.e ? 1 : 0) - (a.ck.e ? 1 : 0) || (b.ck.w ?? 0) - (a.ck.w ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The key whose authority a record speaks for: the key that delegated the
 *  house that signed it (S0 makes `dl.h` the signer), else the signer. On the
 *  root `dl` names the owner's house and `dl.k` is the signer too. */
const authority = (c: CkRec): string => (c.dl !== undefined ? c.dl.k : c.k);

/** Whether a record speaks for the buyer of the last transfer it carries. Only
 *  such a record can prove a chain (`plausible` below asks exactly this of the
 *  records it takes), so only such a record's `x` is read. No signature is
 *  looked at: this decides whose `x` is read at all, not whose counts. */
function claimed(c: CkRec): boolean {
  const last = c.x?.[c.x.length - 1];
  return last !== undefined && last.k === authority(c);
}

/** The game of `inc` at table `t`, from its records (design section 8.3). */
export function resolveGame(env: AuthEnv, t: string, inc: string, rec: AuthRecords): Resolution {
  const letter = inc[0] as FairOnlyLetter;
  const ctx: FoldCtx = { room: env.room, t, inc };
  const read = env.read ?? ((key: string, value: unknown) => readCk(env.room, key, value));
  const invalid = new Set<string>();
  let pending = false;

  // S0: what is readable. A name binds its table, so `inc` is all a record has to match. A rules
  // version this build doesn't know makes the whole game one it can't count: the version is in the
  // name, so a game's records all have it or none does, and `newer` leaves nothing readable.
  const readable: Counted[] = [];
  let newer = false;
  for (const [key, value] of rec.cks) {
    const r = read(key, value);
    if (r.kind === 'ok' && r.inc === inc) readable.push({ key, id: r.id, ck: r.ck });
    else if (r.kind === 'newer' && r.inc === inc) newer = true;
  }
  const name: FairOnlyName | null = readable.length === 0 ? null : { rv: readable[0].ck.rv, ok: readable[0].ck.ok, j: readable[0].ck.j, ts: readable[0].ck.ts };
  const none = (): Resolution => ({
    t, inc, letter, newer, name, chain: [], holder: null, base: null, fin: null, live: false, invalid: [], pending: false,
    houseAt: () => false,
  });
  if (name === null) return none();

  // S2: the transfers that can move this game: those it was written with (`xf:`),
  // and those a checkpoint whose signer could hold the game carries.
  const found = new Map<string, Step>();
  const take = (xf: XferRec, key?: string): void => {
    if (xf.o.issuedAt < name.ts - OFFER_SKEW_MS) return; // made before the game opened: a replay
    const id = xfId(xf); // (null only for a value canon refuses, which asXf has already refused)
    // (The ones under their keys come first, so a copy that has a key keeps it.)
    if (id !== null && !found.has(id)) found.set(id, { id, xf, key });
  };
  for (const [key, value] of rec.xfs) {
    const pk = parseFairOnlyKey(key);
    const xf = pk && pk.kind === 'xf' && pk.t === t && pk.inc === inc ? asXf(value, env.room) : null;
    if (xf && xfId(xf) === (pk as { id: string }).id) take(xf, key);
  }
  for (const c of readable) if (claimed(c.ck)) for (const xf of c.ck.x ?? []) take(xf);

  // The chain: from the opener, the next holder is the lowest-round transfer made by the
  // holder, at or after the round it took the game, with an offer not used before.
  const chain: Holder[] = [{ k: name.ok, from: 0 }];
  const used = new Set<string>();
  const checkedXf = (s: Step): boolean | undefined => {
    const o = s.xf.o;
    const oh = recHash(o);
    if (oh === null) return false;
    const { sig, ...unsigned } = o;
    const maker = env.sig(sigId('offer', t, inc, oh), o.makerPub, () => offerSignBytes(unsigned as Omit<TransferOffer, 'sig'>), sig);
    if (maker !== true) return maker;
    const xh = recHash(s.xf);
    if (xh === null) return false;
    return env.sig(sigId('xf', t, inc, xh), s.xf.k, () => signBytes('xf', ctx, s.xf), s.xf.g);
  };
  let chainPending = false;
  while (chain.length <= MAX_TRANSFERS) {
    const last = chain[chain.length - 1];
    const next = [...found.values()]
      .filter((s) => s.xf.o.makerPub === last.k && s.xf.u >= last.from && !used.has(s.xf.o.nonce))
      .sort((a, b) => a.xf.u - b.xf.u || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let taken: Step | null = null;
    for (const s of next) {
      const v = checkedXf(s);
      if (v === true) { taken = s; break; }
      if (v === undefined) { chainPending = true; break; }
      if (s.key !== undefined) invalid.add(s.key);
    }
    if (!taken) break;
    chain.push({ k: taken.xf.k, from: taken.xf.u, step: taken });
    used.add(taken.xf.o.nonce);
  }
  if (chainPending) pending = true;

  /** Whether the holder `chain[i]` holds the game at round `u`: from the round it
   *  took it to the round it gave it, both ends included (the last holder's range is open). */
  const inRange = (i: number, u: number): boolean => chain[i].from <= u && (i + 1 === chain.length || u <= chain[i + 1].from);
  /** Whether an owner-level key `k` holds the game at round `u` (some index does). */
  const holds = (k: string, u: number): boolean => chain.some((h, i) => h.k === k && inRange(i, u));

  // S1: the checkpoints whose signer could hold the game, best first to look at.
  // (A record speaks for the chain's holder `i` when `i` steps are in its `x` and the
  // holder is the buyer of the last: a record `claimed` already by that, and by none else.)
  const plausible = readable.filter(({ ck: c }) => {
    const i = c.x?.length ?? 0;
    if (chain[i]?.k !== authority(c) || !inRange(i, c.u)) return false;
    for (let j = 0; j < i; j++) if (xfId((c.x as XferRec[])[j]) !== chain[j + 1].step?.id) return false;
    // An end order must be an owner-level key's, holding the game at the round it ends.
    return c.f === undefined || holds(c.f.k, c.u);
  });
  const rank = (a: Counted, b: Counted): number =>
    Number(b.ck.b === env.liveSid) - Number(a.ck.b === env.liveSid) || b.ck.u - a.ck.u || (b.ck.w ?? 0) - (a.ck.w ?? 0)
    || (b.ck.e ? 1 : 0) - (a.ck.e ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  plausible.sort(rank);

  const checkedCk = (cd: Counted): boolean | undefined => {
    const c = cd.ck;
    const h = recHash(c);
    if (h === null) return false;
    // Every signature is looked at (a later one that fails makes the record invalid
    // however the earlier ones stand), and one put off leaves the verdict open.
    let open = false;
    const fails = (v: boolean | undefined): boolean => {
      if (v === undefined) open = true;
      return v === false;
    };
    if (fails(env.sig(sigId('ck', t, inc, h), c.k, () => signBytes('ck', ctx, c), c.g))) return false;
    if (c.dl) {
      const dl = c.dl;
      const dh = recHash(dl);
      if (dh === null || fails(env.sig(sigId('hkey', t, inc, dh), dl.k, () => roomSignBytes('hkey', env.room, '', dl), dl.g))) return false;
    }
    if (c.f) {
      const fin = c.f;
      const fh = recHash(fin);
      if (fh === null || fails(env.sig(sigId('fin', t, inc, fh), fin.k, () => signBytes('fin', ctx, fin), fin.g))) return false;
    }
    return open ? undefined : true;
  };

  const valid: Counted[] = [];
  const waiting: Counted[] = [];
  let looked = 0;
  // Where the looking stopped for want of a place, if it did.
  let cut = plausible.length;
  for (let i = 0; i < plausible.length; i++) {
    const cd = plausible[i];
    if (looked >= MAX_CK_CANDIDATES) { cut = i; break; }
    // Anything below a checkpoint already found valid can't be the base.
    if (valid.length > 0 && cd.ck.u < valid[0].ck.u) continue;
    const v = checkedCk(cd);
    if (v === false) { invalid.add(cd.key); continue; }
    looked++;
    if (v === undefined) waiting.push(cd);
    else {
      valid.push(cd);
      valid.sort(byBest);
    }
  }
  const base = valid[0] ?? null;
  // A waiting checkpoint holds the pass if it would be the base were it good, by S3's whole order
  // (the round, an end, the sweeps, the id): one that ranks under the base changes nothing... unless
  // it holds a place of the cap. A checkpoint put off counts as looked at, so it can crowd out one
  // past the cap that its failing would let in: with any waiting, a checkpoint left unlooked at for
  // want of a place that could be the base keeps the pass pending too.
  if (waiting.some((w) => !base || byBest(w, base) < 0)
    || (waiting.length > 0 && plausible.slice(cut).some((cd) => !base || byBest(cd, base) < 0))) pending = true;

  // S5: an end order standing at the base: one an owner-level key holding the game there signed.
  let fin: FinRec | null = null;
  if (base) {
    const finCandidates: FinRec[] = [];
    if (base.ck.f) finCandidates.push(base.ck.f);
    const own = asFin(rec.fin);
    if (own) finCandidates.push(own);
    for (const f of finCandidates) {
      if (!holds(f.k, base.ck.u)) continue;
      const fh = recHash(f);
      if (fh === null) continue;
      const v = env.sig(sigId('fin', t, inc, fh), f.k, () => signBytes('fin', ctx, f), f.g);
      if (v === true) { fin = f; break; }
      if (v === undefined) pending = true;
    }
  }

  // The houses: delegations the room holds and those the game's checkpoints carry.
  const delegations: { d: DelegationRec; hash: string }[] = [];
  const seen = new Set<string>();
  const addDelegation = (raw: unknown): void => {
    // (A delegation is a few short fields: one padded past that is junk, as a padded transfer is.)
    const d = weightOf(raw, MAX_SMALL_RECORD_BYTES) === null ? null : asDelegation(raw);
    const hash = d && recHash(d);
    if (d && hash && !seen.has(hash)) { seen.add(hash); delegations.push({ d, hash }); }
  };
  for (const raw of rec.delegations ?? []) addDelegation(raw);
  for (const c of readable) if (c.ck.dl) addDelegation(c.ck.dl);

  const houseAt = (pub: string, round: number): boolean | undefined => {
    let waitingOn = false;
    for (const { d, hash } of delegations) {
      if (d.h !== pub) continue;
      // Delegated by the key that holds the game for `round`: after the round it took the game, up to the round it gave it.
      const holder = chain.some((h, i) => h.k === d.k && h.from < round && (i + 1 === chain.length || round <= chain[i + 1].from));
      if (!holder) continue;
      const v = env.sig(sigId('hkey', t, inc, hash), d.k, () => roomSignBytes('hkey', env.room, '', d), d.g);
      if (v === true) return true;
      if (v === undefined) waitingOn = true;
    }
    return waitingOn ? undefined : false;
  };

  return {
    t, inc, letter, newer: false, name, chain, holder: chain[chain.length - 1].k, base, fin, live: base !== null && base.ck.e !== 1,
    invalid: [...invalid].sort(), pending, houseAt,
  };
}

// ── S9: the table's game ─────────────────────────────────────────────────────

/** Of the live games of one table, the one pages play, show and put the
 *  switch back to (design S9): the only one whose holder is `deedHolder`; else
 *  the one the switch names; else the only live one; else the lowest name.
 *  This is the one place the room's owner enters FAIR ONLY, and it decides
 *  where NEW bets go, never what anyone's nets are or whether a game ends. */
export function tableGame(games: readonly Resolution[], deedHolder: string | null | undefined, switchInc: string | null | undefined): Resolution | null {
  const live = games.filter((g) => g.live);
  if (live.length === 0) return null;
  const theirs = live.filter((g) => g.holder === deedHolder);
  if (theirs.length === 1) return theirs[0];
  const named = live.find((g) => g.inc === switchInc);
  if (named) return named;
  // The lowest name (which is the only live game, when only one is).
  return [...live].sort((a, b) => (a.inc < b.inc ? -1 : a.inc > b.inc ? 1 : 0))[0];
}
