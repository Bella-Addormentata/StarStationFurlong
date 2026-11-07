/**
 * 🔒🧪 Test kit for FAIR ONLY tables (computedFairOnly.ts) — for specs only; no
 * app code imports it.
 *
 * Builds the records of a game the way their writers would: whole (hashed,
 * keyed and signed), by deterministic identities, with the owner's house
 * delegated. A spec changes one thing in a good record with `changed` (which
 * seals it again, so the record's key still matches what it holds) and so
 * makes exactly one rule fail.
 */

import { ckId, ckKey, FAIR_ONLY_RV, faironlyInc, NO_CLOSE, sealCk, sealXf } from './computedFairOnly';
import type { CkRec, DeedOffer, FairOnlyLetter, FairOnlyName } from './computedFairOnly';
import type { AuthEnv, AuthRecords } from './computedFairOnlyAuth';
import type { FoldCtx } from './computedFold';
import { houseSign, roomSignBytes } from './computedHouse';
import type { DelegationRec } from './computedHouse';
import { testHouse, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import { verifyIdentityStrict } from './keypair';
import { offerSignBytes } from './offerBytes';
import type { TransferOffer } from './offerBytes';

export const ROOM = 'room-fo';
export const T = 'roulette-1';
export const owner = testIdentity('fo-owner');
export const buyer = testIdentity('fo-buyer');
export const house = testHouse('fo-house');
/** Three more people, and a second house. */
export const third = testIdentity('fo-third');
export const fourth = testIdentity('fo-fourth');
export const stranger = testIdentity('fo-stranger');
export const house2 = testHouse('fo-house-2');
/** The name's inputs of the game the specs play. */
export const NAME: FairOnlyName = { rv: FAIR_ONLY_RV, ok: owner.pub, j: '0123456789abcdef', ts: 1_700_000_000_000 };

export const ctxOf = (letter: FairOnlyLetter, t = T, name: FairOnlyName = NAME): FoldCtx => ({ room: ROOM, t, inc: faironlyInc(letter, ROOM, t, name) });
/** A roulette game's context, and a craps game's. */
export const P = ctxOf('p');
export const Q = ctxOf('q');

export const hex = (c: string, n: number): string => c.repeat(n);
export const houseSigner = (bytes: Uint8Array): string => houseSign(house.secret, bytes);
/** The signer of the key `k`: a person, the second house, else the first. */
export const signerOf = (k: unknown): ((bytes: Uint8Array) => string) => {
  for (const who of [owner, buyer, third, fourth, stranger]) if (k === who.pub) return who.sign;
  return k === house2.pub ? (bytes) => houseSign(house2.secret, bytes) : houseSigner;
};

/** A delegation of `h` by `by`, as the room's deed holder signs one. */
export function delegation(by: TestIdentity, h: string): DelegationRec {
  const body = { v: 1 as const, h, k: by.pub };
  return { ...body, g: by.sign(roomSignBytes('hkey', ROOM, '', body)) };
}
/** The owner's delegation of the house. */
export const DL_HOUSE = delegation(owner, house.pub);
/** The craps carry a table opens with. */
export const OPENING_CARRY = { p: 0, w: {} };

/** The deed offer `maker` signs, made out to `to`. */
export function offerOf(maker: TestIdentity, to: TestIdentity, patch: Partial<TransferOffer> = {}): DeedOffer {
  const unsigned: Omit<TransferOffer, 'sig'> = {
    v: 1, kind: 'transfer-offer', asset: { kind: 'deed', roomId: ROOM, roomName: 'Furlong' }, makerPub: maker.pub, makerName: 'Maker',
    toPub: to.pub, price: 0, issuedAt: NAME.ts + 1_000, expiresAt: NAME.ts + 1_000 + 7 * 24 * 3_600_000, nonce: '0123456789abcdef01234567', ...patch,
  };
  return { ...unsigned, sig: maker.sign(offerSignBytes(unsigned)) } as DeedOffer;
}

/** The opening root of a game, signed by its owner. */
export function rootOf(ctx: FoldCtx, letter: FairOnlyLetter, patch: Record<string, unknown> = {}) {
  const body = {
    v: 1, ok: NAME.ok, j: NAME.j, rv: NAME.rv, ts: NAME.ts, b: 'g', u: 0, l: NO_CLOSE, n: {}, ...(letter === 'q' ? { s: OPENING_CARRY } : {}),
    dl: DL_HOUSE, k: owner.pub, ...patch,
  };
  return sealCk(ctx, body as unknown as Omit<CkRec, 'g'>, owner.sign);
}

/** A house's checkpoint after round 3 (a house reveal decided it), closing
 *  session `b`; signed by whoever `patch.k` names (the house unless it says). */
export function trimOf(ctx: FoldCtx, letter: FairOnlyLetter, patch: Record<string, unknown> = {}) {
  const body = {
    v: 1, ok: NAME.ok, j: NAME.j, rv: NAME.rv, ts: NAME.ts, b: hex('a', 24), u: 3, l: hex('b', 32), d: `h:${hex('c', 32)}`,
    o: letter === 'q' ? [3, 4] : 17, n: { alice: '25', bob: '-25' }, ...(letter === 'q' ? { s: { p: 6, w: {} } } : {}), h: hex('d', 64),
    dl: DL_HOUSE, k: house.pub, ...patch,
  };
  return sealCk(ctx, body as unknown as Omit<CkRec, 'g'>, signerOf(body.k));
}

/** `good` with `patch` laid over it (an undefined value deletes the field),
 *  keyed again by what it now holds. A value canon refuses can't match any
 *  key; it is stored under a well-formed one. */
export function changed(ctx: FoldCtx, good: { value: CkRec }, patch: Record<string, unknown>): { key: string; value: Record<string, unknown> } {
  const value: Record<string, unknown> = { ...good.value };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete value[k];
    else value[k] = v;
  }
  const id = ckId(value);
  return { key: ckKey(ctx.t, ctx.inc, id ?? hex('0', 32)), value };
}

// ── For the resolver's specs (computedFairOnlyAuth.test.ts) ──────────────────

/** A transfer of the game from `from` to `to` at round `u`: the seller's signed
 *  deed offer made out to the buyer, and the buyer's signature over the record. */
export function xferOf(ctx: FoldCtx, from: TestIdentity, to: TestIdentity, u: number, offerPatch: Partial<TransferOffer> = {}) {
  return sealXf(ctx, { v: 1, o: offerOf(from, to, offerPatch), u, k: to.pub }, to.sign);
}

/** A game's records as the doc holds them, for the resolver. */
export function recordsOf(entries: ReadonlyArray<{ key: string; value: unknown }>, delegations: unknown[] = []): AuthRecords {
  return {
    cks: entries.filter((e) => e.key.startsWith('ck:')).map((e) => [e.key, e.value] as const),
    xfs: entries.filter((e) => e.key.startsWith('xf:')).map((e) => [e.key, e.value] as const),
    fin: entries.find((e) => e.key.startsWith('fin:'))?.value,
    delegations,
  };
}

/** The strict check a page gives, as a spec's environment: each signed thing is
 *  verified once (in the order `verified` lists), and the hashes in `hold` read
 *  as not checked yet for as long as they stay there. */
export function authEnv(opts: { liveSid?: string; hold?: Iterable<string> } = {}) {
  const cache = new Map<string, boolean>();
  const hold = new Set(opts.hold ?? []);
  const verified: string[] = [];
  const env: AuthEnv = {
    room: ROOM,
    liveSid: opts.liveSid,
    sig: (hash, pub, bytes, sig) => {
      if (hold.has(hash)) return undefined;
      let v = cache.get(hash);
      if (v === undefined) {
        v = verifyIdentityStrict(pub, bytes(), sig);
        cache.set(hash, v);
        verified.push(hash);
      }
      return v;
    },
  };
  return { env, hold, verified, cache };
}
