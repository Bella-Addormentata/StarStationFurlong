/**
 * 🧪🧮 Test kit for computed tables (computedFold.ts) — for specs only; no app
 * code imports it.
 *
 * Builds records the way an honest page would: hashed, keyed and signed for
 * one FoldCtx, by deterministic test identities (the same name always gives
 * the same key), with deterministic seeds; and a house's, as the owner's
 * node would (computedHouse's mirror of house.rs). Plus SigChecks: a caching one on
 * the real verifier (keypair.verifyIdentityStrict) that can hold chosen
 * records back as "not checked yet", and a trusting one for timing runs that
 * must not spend their budget on signatures.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  abandonKey,
  closeKey,
  forfeitKey,
  houseCommitKey,
  houseCommitOf,
  houseRevealKey,
  nextSid,
  recHash,
  revealKey,
  signBytes,
  slipCommit,
  slipKey,
  slipKeyFor,
  TableFold,
} from './computedFold';
import type {
  AbandonRec, AnySlipRec, Checkpoint, CloseRec, CrapsSlipRec, FoldCtx, FoldResult, ForfeitRec, HouseCheck, HouseCommitRec,
  HouseRevealRec, RevealRec, SigCheck, SignedKind, SlipRec,
} from './computedFold';
import { housePubOf, houseSeedOf, houseSign } from './computedHouse';
import type { CrapsCarry } from './computedCraps';
import type { CrapsBet } from './games/craps';
import type { RouletteBet } from './games/roulette';
// Also wires noble's synchronous sha512 (keypair.ts does it at import).
import { verifyIdentityStrict } from './keypair';

/** The table every spec uses unless it says otherwise. */
export const TEST_CTX: FoldCtx = { room: 'room-test', t: 'roulette-1', inc: 'c0123456789abcdef01234567' };

// ── Identities ───────────────────────────────────────────────────────────────

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface TestIdentity {
  /** The player id it bets as (the name unless given). */
  pid: string;
  /** base64url of the 32-byte public key. */
  pub: string;
  /** base64url signature over `bytes`. */
  sign(bytes: Uint8Array): string;
}

/** A real Ed25519 identity from a fixed seed: sha256('ssf-ct-test-identity|<name>'). */
export function testIdentity(name: string, pid: string = name): TestIdentity {
  const seed = sha256(utf8ToBytes(`ssf-ct-test-identity|${name}`));
  return { pid, pub: b64url(ed.getPublicKey(seed)), sign: (bytes) => b64url(ed.sign(bytes, seed)) };
}

/** An identity whose "signatures" are only well-formed (sha512 of the bytes):
 *  for timing runs under trustAll, where signing would dominate. */
export function fakeIdentity(name: string, pid: string = name): TestIdentity {
  return { pid, pub: b64url(sha256(utf8ToBytes(`ssf-ct-fake-identity|${name}`))), sign: (bytes) => b64url(sha512(bytes)) };
}

// ── SigChecks ────────────────────────────────────────────────────────────────

export interface CachingCheck {
  check: SigCheck;
  /** hash → final verdict */
  cache: Map<string, boolean>;
  /** Hashes answered "not checked yet" (undefined) for as long as they're here. */
  hold: Set<string>;
  /** How many records were actually verified. */
  verified: number;
}

/** A house: a node secret from a fixed seed (sha256('ssf-ct-test-house|<name>'))
 *  and the house key house.rs derives from it. */
export interface TestHouse {
  secret: Uint8Array;
  /** base64url house key. */
  pub: string;
}

export function testHouse(name: string): TestHouse {
  const secret = sha256(utf8ToBytes(`ssf-ct-test-house|${name}`));
  return { secret, pub: housePubOf(secret) };
}

/** A HouseCheck: these houses are delegated, every other key is not. */
export const housesAre = (...houses: TestHouse[]): HouseCheck => (pub) => houses.some((h) => h.pub === pub);

/** A SigCheck on keypair.verifyIdentityStrict that verifies each record once.
 *  Hashes in `hold` read as pending until taken out. */
export function cachingCheck(hold: Iterable<string> = []): CachingCheck {
  const out: CachingCheck = {
    cache: new Map(),
    hold: new Set(hold),
    verified: 0,
    check: (hash, _kind, pub, bytes, sig) => {
      if (out.hold.has(hash)) return undefined;
      let v = out.cache.get(hash);
      if (v === undefined) {
        v = verifyIdentityStrict(pub, bytes(), sig);
        out.cache.set(hash, v);
        out.verified++;
      }
      return v;
    },
  };
  return out;
}

/** Every signature passes (for fakeIdentity records in timing runs). */
export const trustAll: SigCheck = () => true;

// ── Records ──────────────────────────────────────────────────────────────────

export interface Built<R> {
  key: string;
  hash: string;
  rec: R;
}

export const red = (amount: number): RouletteBet => ({ type: 'red', amount });
export const black = (amount: number): RouletteBet => ({ type: 'black', amount });
export const straight = (pick: number, amount: number): RouletteBet => ({ type: 'straight', pick, amount });

/** Records for one table, built and signed as an honest page would. */
export class ComputedKit {
  constructor(readonly ctx: FoldCtx = TEST_CTX) {}

  /** A deterministic 64-hex seed for (name, round, tag). */
  seed(name: string, r: number, tag = ''): string {
    return bytesToHex(sha256(utf8ToBytes(`ssf-ct-test-seed|${name}|${r}|${tag}`)));
  }

  commit(r: number, pid: string, seed: string): string {
    return slipCommit(this.ctx, r, pid, seed);
  }

  /** `body` with k = id's pub, signed over signBytes(kind, ctx, body). */
  sign<T extends { k: string; g: string }>(kind: SignedKind, id: TestIdentity, body: Omit<T, 'k' | 'g'>): T {
    const withKey = { ...(body as object), k: id.pub };
    return { ...withKey, g: id.sign(signBytes(kind, this.ctx, withKey)) } as unknown as T;
  }

  /** A slip version for id's player. The seed defaults to seed(pid, r), so
   *  every version of a round shares one commitment, as a real page's do. */
  slip(id: TestIdentity, r: number, b: RouletteBet[], opts: { v?: number; seed?: string; p?: string } = {}): Built<SlipRec> {
    const p = opts.p ?? id.pid;
    const c = this.commit(r, p, opts.seed ?? this.seed(p, r));
    return built(this.sign<SlipRec>('slip', id, { r, p, v: opts.v ?? 1, b, c }), slipKey);
  }

  /** A craps slip version (a `k` table's): `b` canonical, `o` the stamp of
   *  the carry it was built on (computedCraps basisOf), `t` the stand it was
   *  written at, `l` a goodbye. The seed defaults as slip's does. */
  crapsSlip(
    id: TestIdentity, r: number, b: CrapsBet[], o: string, opts: { v?: number; seed?: string; p?: string; t?: number; l?: 1 } = {},
  ): Built<CrapsSlipRec> {
    const p = opts.p ?? id.pid;
    const c = this.commit(r, p, opts.seed ?? this.seed(p, r));
    const body = { r, p, v: opts.v ?? 1, b, o, c, ...(opts.t !== undefined ? { t: opts.t } : {}), ...(opts.l ? { l: opts.l } : {}) };
    return built(this.sign<CrapsSlipRec>('slip', id, body), slipKeyFor(this.ctx));
  }

  /** A close of round r under parent q, freezing the given slips (or a raw
   *  pid → hash map); at a house table, naming house commitment `h`. */
  close(id: TestIdentity, r: number, q: string, frozen: Built<AnySlipRec>[] | Record<string, string>, h?: string): Built<CloseRec> {
    const f: Record<string, string> = {};
    if (Array.isArray(frozen)) for (const s of frozen) f[s.rec.p] = s.hash;
    else Object.assign(f, frozen);
    return built(this.sign<CloseRec>('close', id, { r, q, f, ...(h !== undefined ? { h } : {}) }), closeKey);
  }

  /** The reveal for a slip made with the default seed (or `seed`). */
  reveal(r: number, pid: string, seed: string = this.seed(pid, r)): Built<RevealRec> {
    return built({ r, p: pid, s: seed }, revealKey);
  }

  /** A forfeit of close x counting `n` (sorted here). */
  forfeit(id: TestIdentity, r: number, x: string, n: string[]): Built<ForfeitRec> {
    return built(this.sign<ForfeitRec>('forfeit', id, { r, x, n: [...new Set(n)].sort() }), forfeitKey);
  }

  abandon(id: TestIdentity, r: number, x: string): Built<AbandonRec> {
    return built(this.sign<AbandonRec>('abandon', id, { r, x }), abandonKey);
  }

  /** A checkpoint closing session `b` at round u, with nets given as bigints
   *  (and, for a live craps table, the carried state `s`; for a live house
   *  table, the commitment `h` its next session must name first). */
  checkpoint(
    id: TestIdentity, b: string, u: number, l: string, nets: Record<string, bigint>, e?: 1, s?: CrapsCarry, h?: string,
  ): Checkpoint {
    const n: Record<string, string> = {};
    for (const pid of Object.keys(nets).sort()) if (nets[pid] !== 0n) n[pid] = nets[pid].toString();
    return this.sign<Checkpoint>('sum', id, { v: 1, b, u, l, n, ...(e ? { e } : {}), ...(s ? { s } : {}), ...(h ? { h } : {}) });
  }

  // ── The house's ──

  /** The house's seed for round r (computedHouse houseSeedOf). */
  houseSeed(house: TestHouse, r: number): string {
    return houseSeedOf(house.secret, this.ctx, r);
  }

  /** The house's commitment for round r: to houseSeed unless given a seed. */
  houseCommit(house: TestHouse, r: number, seed: string = this.houseSeed(house, r)): string {
    return houseCommitOf(this.ctx, r, seed);
  }

  /** `body` with k = the house key, signed by the house over signBytes(kind, ctx, body). */
  signHouse<T extends { k: string; g: string }>(kind: 'hreveal' | 'hcommit', house: TestHouse, body: Omit<T, 'k' | 'g'>): T {
    const withKey = { ...(body as object), k: house.pub };
    return { ...withKey, g: houseSign(house.secret, signBytes(kind, this.ctx, withKey)) } as unknown as T;
  }

  /** The house's reveal of round r, deciding closes `x` and counting the
   *  slips `n` (both sorted here), carrying the next round's commitment
   *  unless `c` is null (or the one given). `s` defaults to the house's seed. */
  houseReveal(
    house: TestHouse, r: number, x: string[], n: string[], opts: { c?: string | null; s?: string } = {},
  ): Built<HouseRevealRec> {
    const c = opts.c === null ? undefined : opts.c ?? this.houseCommit(house, r + 1);
    const body = {
      r, s: opts.s ?? this.houseSeed(house, r), x: [...new Set(x)].sort(), n: [...new Set(n)].sort(), ...(c !== undefined ? { c } : {}),
    };
    return built(this.signHouse<HouseRevealRec>('hreveal', house, body), houseRevealKey);
  }

  /** The house stepping down at round r: its seed out, no close listed. */
  stepDown(house: TestHouse, r: number, s: string = this.houseSeed(house, r)): Built<HouseRevealRec> {
    return built(this.signHouse<HouseRevealRec>('hreveal', house, { r, s, x: [], n: [] }), houseRevealKey);
  }

  /** The house joining round r with commitment `c` (to its own seed by default). */
  houseJoin(house: TestHouse, r: number, c: string = this.houseCommit(house, r)): Built<HouseCommitRec> {
    return built(this.signHouse<HouseCommitRec>('hcommit', house, { r, c }), houseCommitKey);
  }

  /** The session id a checkpoint opens. */
  sidAfter(cp: Checkpoint | null): string {
    return nextSid(this.ctx, cp);
  }
}

function built<R>(rec: R, keyOf: (rec: R) => string | null): Built<R> {
  const key = keyOf(rec);
  const hash = recHash(rec);
  if (!key || !hash) throw new Error(`computedTestKit: built a junk record ${JSON.stringify(rec)}`);
  return { key, hash, rec };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** One live session's records, as the session map would hold them. */
export class TestSession {
  readonly records = new Map<string, unknown>();

  put(...recs: Built<unknown>[]): this {
    for (const r of recs) this.records.set(r.key, r.rec);
    return this;
  }

  /** Store anything under any key (junk included). */
  raw(key: string, value: unknown): this {
    this.records.set(key, value);
    return this;
  }

  del(...keys: string[]): this {
    for (const k of keys) this.records.delete(k);
    return this;
  }

  /** A fold built cold from this session (with `houseOk`, at a house table). */
  fold(check: SigCheck, cp: Checkpoint | null = null, ctx: FoldCtx = TEST_CTX, houseOk?: HouseCheck): TableFold {
    const fold = new TableFold(ctx, check, undefined, undefined, houseOk);
    fold.setBase(cp);
    fold.reset(this.records.entries());
    return fold;
  }
}

/** The fold's whole output as one canonical string (sorted, bigints as
 *  decimal), for "these two folds agree" assertions. */
export function snapshot(res: FoldResult): string {
  const m = (map: Map<string, bigint>) => [...map.keys()].sort().map((k) => [k, map.get(k)!.toString()]);
  const round = (v: FoldResult['rounds'][number]) => ({
    r: v.r, close: v.close, present: v.present, missing: v.missing, revealed: v.revealed, decided: v.decided,
    counted: v.counted, forfeit: v.forfeit?.hash ?? null, abandon: v.abandon?.hash ?? null, pocket: v.pocket,
    stakes: m(v.stakes), payouts: m(v.payouts), deltas: m(v.deltas),
  });
  return JSON.stringify({
    base: { sid: res.base.sid, u: res.base.u, l: res.base.l, n: m(res.base.n), ended: res.base.ended },
    rounds: res.rounds.map(round),
    tip: res.tip ? res.tip.close : null,
    open: res.open,
    parent: res.parent,
    openCloses: res.openCloses.map((c) => [c.hash, c.state]),
    felts: [...res.felts.keys()].sort().map((k) => [k, res.felts.get(k)!.hash]),
    nets: m(res.nets),
    held: m(res.held),
    revealedCommits: [...res.revealedCommits].sort(),
    pending: res.pending,
    bytes: res.bytes,
    records: res.records,
  });
}

/** snapshot, plus what THE HOUSE adds: each round's deciding house reveal,
 *  the open round's required commitment and the join records it may name.
 *  (snapshot itself stays as PR 2 hashed it: computedFoldGolden pins it.) */
export function houseSnapshot(res: FoldResult): string {
  return JSON.stringify({
    s: snapshot(res),
    houseTable: res.houseTable,
    house: res.rounds.map((v) => v.house?.hash ?? null),
    required: res.required,
    joins: res.joins.map((j) => j.hash),
  });
}
