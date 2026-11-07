/**
 * 🔒🧪 FAIR ONLY tables: the authority resolver (computedFairOnlyAuth.ts).
 *
 * Design §8.3 S1 to S5, S7 and S9. A game is built whole (every record hashed,
 * keyed and signed by the identity that writes it) and then changed in one
 * place, so a record that stops counting can only have failed that one rule;
 * the unchanged game is read first in each as the positive control.
 */

import { describe, expect, it } from 'vitest';
import { recHash } from './computedFold';
import { ckId, ckKey, finKey, MAX_SMALL_RECORD_BYTES, MAX_TRANSFERS, nextSid3, OFFER_SKEW_MS, sealFin, sealXf, weightOf, xfId, xfKey } from './computedFairOnly';
import type { CkRec, FairOnlyLetter, XferRec } from './computedFairOnly';
import { MAX_CK_CANDIDATES, resolveGame, sigId, tableGame } from './computedFairOnlyAuth';
import type { AuthRecords, Resolution } from './computedFairOnlyAuth';
import {
  authEnv, buyer, changed, ctxOf, delegation, DL_HOUSE, fourth, hex, house, house2, houseSigner, NAME, owner, P, Q, recordsOf, rootOf,
  stranger, T, third, trimOf, xferOf,
} from './computedFairOnlyKit';
import type { FoldCtx } from './computedFold';

const CTX: Record<FairOnlyLetter, FoldCtx> = { p: P, q: Q };
type Entry = { key: string; value: unknown };

/** The resolution of a game from the records it holds (and what the check saw). */
function resolve(letter: FairOnlyLetter, entries: Entry[], opts: { liveSid?: string; hold?: string[]; delegations?: unknown[] } = {}) {
  const a = authEnv({ liveSid: opts.liveSid, hold: opts.hold });
  const res = resolveGame(a.env, T, CTX[letter].inc, recordsOf(entries, opts.delegations));
  return { res, ...a };
}

/** A signature that is well formed and good for nothing. */
const BAD_SIG = houseSigner(new Uint8Array([1, 2, 3]));
const hashOf = (e: Entry): string => recHash(e.value) as string;

const BOTH = ['p', 'q'] as const;

/** The records of a game as a caller might hand them over: checkpoints and transfers each as they are, whatever their keys say. */
const raw = (cks: Entry[], xfs: Entry[] = []): AuthRecords => ({
  cks: cks.map((e) => [e.key, e.value] as const),
  xfs: xfs.map((e) => [e.key, e.value] as const),
});

describe('the base (S3)', () => {
  it('is the root of a game with nothing else', () => {
    for (const letter of BOTH) {
      const root = rootOf(CTX[letter], letter);
      const { res } = resolve(letter, [root]);
      expect(res).toMatchObject({ newer: false, holder: owner.pub, live: true, pending: false, invalid: [], fin: null });
      expect(res.base?.key).toBe(root.key);
      expect(res.chain).toEqual([{ k: owner.pub, from: 0 }]);
      expect(res.name).toEqual(NAME);
      expect(res.letter).toBe(letter);
    }
  });

  it('is the checkpoint of the highest round', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      const three = trimOf(ctx, letter);
      const five = trimOf(ctx, letter, { u: 5, l: hex('e', 32) });
      expect(resolve(letter, [root, three]).res.base?.key).toBe(three.key);
      expect(resolve(letter, [root, three, five]).res.base?.key).toBe(five.key);
      expect(resolve(letter, [five, three, root]).res.base?.key).toBe(five.key);
    }
  });

  it('on an equal round is an end, then the most sweeps, then the lowest id', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const plain = trimOf(ctx, letter);
      const sweep1 = trimOf(ctx, letter, { b: nextSid3(ctx, plain.value), w: 1 });
      const sweep2 = trimOf(ctx, letter, { b: nextSid3(ctx, plain.value), w: 2 });
      const fin = sealFin(ctx, owner.pub, owner.sign).value;
      const end = trimOf(ctx, letter, { e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined });
      expect(resolve(letter, [plain, sweep1]).res.base?.key, 'a sweep over the plain one').toBe(sweep1.key);
      expect(resolve(letter, [plain, sweep1, sweep2]).res.base?.key, 'the most sweeps').toBe(sweep2.key);
      expect(resolve(letter, [plain, sweep1, sweep2, end]).res.base?.key, 'an end over any sweep').toBe(end.key);
      // Two of the same round and sweeps: the lowest id.
      const other = trimOf(ctx, letter, { n: { alice: '26', bob: '-26' } });
      const [lo, hi] = [plain, other].sort((a, b) => (a.key < b.key ? -1 : 1));
      expect(resolve(letter, [hi, lo]).res.base?.key, 'the lowest id').toBe(lo.key);
      // A sweep outranks the plain record of its round whichever of the two has the lower id (a record with no `w` has no sweeps, not one).
      let tried = 0;
      for (let i = 1; i < 200 && tried < 3; i++) {
        const n = { alice: String(i), bob: String(-i) };
        const bare = trimOf(ctx, letter, { n });
        const swept = trimOf(ctx, letter, { n, b: nextSid3(ctx, bare.value), w: 1 });
        if (!(swept.key > bare.key)) continue;
        tried++;
        expect(resolve(letter, [bare, swept]).res.base?.key, `a sweep with the higher id (${i})`).toBe(swept.key);
        expect(resolve(letter, [swept, bare]).res.base?.key, `a sweep with the higher id (${i}), the other way round`).toBe(swept.key);
      }
      expect(tried, 'three such pairs were found').toBe(3);
    }
  });

  it('is none for a game with no readable record, and none of another game\'s', () => {
    for (const letter of BOTH) {
      const none = resolve(letter, []).res;
      expect(none).toMatchObject({ base: null, holder: null, live: false, newer: false, name: null, pending: false });
      expect(none.chain).toEqual([]);
      expect(none.houseAt(house.pub, 1)).toBe(false);
      // junk under its key, and a record of the other game (its name is the other's)
      const root = rootOf(CTX[letter], letter);
      const otherLetter = letter === 'p' ? 'q' : 'p';
      const alien = rootOf(CTX[otherLetter], otherLetter);
      expect(resolve(letter, [{ key: root.key, value: { ...root.value, extra: 1 } }, alien]).res.base).toBeNull();
    }
  });

  it('is nothing of another game\'s records among the ones it is given: not read, not checked, not reported', () => {
    const root = rootOf(P, 'p');
    const alien = [rootOf(Q, 'q'), trimOf(Q, 'q')];
    const { res, verified } = resolve('p', [root, ...alien]);
    expect(res.base?.key).toBe(root.key);
    expect(res.invalid).toEqual([]);
    for (const a of alien) expect(verified).not.toContain(hashOf(a));
    // and a game of a rules version this build doesn't know, beside this one, makes this one no newer
    const root2 = rootOf(ctxOf('p', T, { ...NAME, rv: 'f2' }), 'p', { rv: 'f2' });
    const beside = resolve('p', [root, root2]).res;
    expect(beside).toMatchObject({ newer: false, live: true });
    expect(beside.base?.key).toBe(root.key);
    // ... nor does it make a game with no record of its own newer
    expect(resolve('p', [root2]).res).toMatchObject({ newer: false, name: null, base: null });
  });

  it('is nothing of a game whose rules version this build does not know', () => {
    const name2 = { ...NAME, rv: 'f2' };
    const ctx2 = ctxOf('p', T, name2);
    const root2 = rootOf(ctx2, 'p', { rv: 'f2' });
    const a = authEnv();
    const res = resolveGame(a.env, T, ctx2.inc, recordsOf([root2]));
    expect(res).toMatchObject({ newer: true, base: null, holder: null, live: false, name: null });
    expect(a.verified).toEqual([]);
  });
});

describe('signatures (S1)', () => {
  it('a record whose signature fails under the key it claims is crypto-invalid: no place, and reported', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      const good = trimOf(ctx, letter);
      expect(resolve(letter, [root, good]).res).toMatchObject({ invalid: [] });
      const forged = changed(ctx, good, { g: BAD_SIG });
      const { res } = resolve(letter, [root, forged]);
      expect(res.base?.key, 'falls back to the next best').toBe(root.key);
      expect(res.invalid).toEqual([forged.key]);
      // a delegation that fails, in a record whose own signature holds
      const badDl = trimOf(ctx, letter, { dl: { ...DL_HOUSE, g: BAD_SIG } });
      const byDl = resolve(letter, [root, badDl]).res;
      expect(byDl).toMatchObject({ invalid: [badDl.key] });
      expect(byDl.base?.key).toBe(root.key);
      // an end order that fails
      const fin = sealFin(ctx, owner.pub, owner.sign).value;
      const end = trimOf(ctx, letter, { e: 1, f: { ...fin, g: BAD_SIG }, s: undefined, h: undefined, k: owner.pub, dl: undefined });
      expect(resolve(letter, [root, end]).res).toMatchObject({ invalid: [end.key], live: true });
    }
  });

  it('the root counts only with the opener\'s signature and the opener\'s delegation', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      const forged = changed(ctx, root, { g: BAD_SIG });
      expect(resolve(letter, [forged]).res).toMatchObject({ base: null, holder: owner.pub, live: false, invalid: [forged.key] });
      const badDl = changed(ctx, root, { dl: { ...DL_HOUSE, g: BAD_SIG } });
      expect(resolve(letter, [badDl]).res).toMatchObject({ base: null, invalid: [badDl.key] });
    }
  });

  it('a record signed by a key that could not hold the game is skipped: never verified, never reported', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      // a stranger and its house, and the stranger signing alone
      const byHouse = trimOf(ctx, letter, { u: 5, l: hex('e', 32), k: house2.pub, dl: delegation(stranger, house2.pub) });
      const alone = trimOf(ctx, letter, { u: 6, l: hex('f', 32), k: stranger.pub, dl: undefined });
      const { res, verified } = resolve(letter, [root, byHouse, alone]);
      expect(res.base?.key).toBe(root.key);
      expect(res.invalid).toEqual([]);
      expect(verified).not.toContain(hashOf(byHouse));
      expect(verified).not.toContain(hashOf(alone));
    }
  });

  it('is checked once, by the caller\'s cache, however many times the game is read', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const a = authEnv();
    const records = recordsOf([root, trim]);
    resolveGame(a.env, T, P.inc, records);
    const first = a.verified.length;
    expect(first).toBeGreaterThan(0);
    resolveGame(a.env, T, P.inc, records);
    expect(a.verified.length).toBe(first);
  });

  it('checks the most likely next base first: the one that closes the session this page folds', () => {
    const root = rootOf(P, 'p');
    const live = nextSid3(P, root.value);
    const closing = trimOf(P, 'p', { b: live });
    const higher = trimOf(P, 'p', { u: 5, l: hex('e', 32), b: hex('c', 24) });
    const { res, verified } = resolve('p', [root, higher, closing], { liveSid: live });
    expect(verified.indexOf(hashOf(closing)), 'both were looked at').toBeGreaterThanOrEqual(0);
    expect(verified.indexOf(hashOf(higher))).toBeGreaterThan(verified.indexOf(hashOf(closing)));
    expect(res.base?.key, 'but the higher round is still the base').toBe(higher.key);
  });

  it('then the most sweeps, and then the lowest id, of one round', () => {
    const base = trimOf(P, 'p');
    const sweeps = [1, 2, 3].map((w) => trimOf(P, 'p', { b: nextSid3(P, base.value), w }));
    const seen = resolve('p', sweeps).verified;
    const at = sweeps.map((s) => seen.indexOf(hashOf(s)));
    expect(at.every((i) => i >= 0), 'all three were looked at').toBe(true);
    expect(at[2], 'three sweeps before two').toBeLessThan(at[1]);
    expect(at[1], 'two sweeps before one').toBeLessThan(at[0]);
    // Four states of one round: looked at from the lowest id up.
    const states = [0, 1, 2, 3].map((i) => trimOf(P, 'p', { n: { alice: `${20 + i}`, bob: `-${20 + i}` } }));
    const byId = [...states].sort((a, b) => (a.key < b.key ? -1 : 1));
    const looked = resolve('p', states).verified;
    const order = byId.map((r) => looked.indexOf(hashOf(r)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('on an equal round the base is the lowest id, whichever session this page happens to fold', () => {
    const root = rootOf(P, 'p');
    const x = trimOf(P, 'p', { b: hex('a', 24) });
    const y = trimOf(P, 'p', { b: hex('c', 24) });
    const [lo, hi] = [x, y].sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const liveSid of [lo.value.b, hi.value.b, undefined]) {
      expect(resolve('p', [root, hi, lo], { liveSid }).res.base?.key, `folding ${liveSid}`).toBe(lo.key);
    }
  });

  it('looks at an end before a plain checkpoint of the same round', () => {
    const root = rootOf(P, 'p');
    const plain = trimOf(P, 'p', { b: hex('c', 24) });
    const fin = sealFin(P, owner.pub, owner.sign).value;
    // (the ids order the two the other way, so only the end's place puts it first)
    const end = ['1', '2', '3', '4', '5', '6', '7', '8']
      .map((c) => trimOf(P, 'p', { b: hex('c', 24), l: hex(c, 32), e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined }))
      .find((r) => r.key > plain.key);
    expect(end).toBeDefined();
    const { verified } = resolve('p', [root, plain, end as Entry]);
    expect(verified.indexOf(hashOf(end as Entry))).toBeGreaterThanOrEqual(0);
    expect(verified.indexOf(hashOf(end as Entry))).toBeLessThan(verified.indexOf(hashOf(plain)));
  });

  it('reports every record that failed, in key order, whatever order the doc gave them', () => {
    const root = rootOf(P, 'p');
    const forged = [8, 9, 10].map((u) => changed(P, trimOf(P, 'p', { u, l: hex('e', 32) }), { g: BAD_SIG }));
    const a = resolve('p', [root, ...forged]).res.invalid;
    expect(a).toEqual(forged.map((f) => f.key).sort());
    expect(resolve('p', [root, ...[...forged].reverse()]).res.invalid).toEqual(a);
  });

  it('does not look at a round below a base it found, and looks at no more than MAX_CK_CANDIDATES', () => {
    const root = rootOf(P, 'p');
    const high = trimOf(P, 'p', { u: 9, l: hex('e', 32) });
    const low = trimOf(P, 'p', { u: 4, l: hex('d', 32) });
    const { res, verified } = resolve('p', [root, low, high]);
    expect(res.base?.key).toBe(high.key);
    expect(verified).toContain(hashOf(high));
    expect(verified).not.toContain(hashOf(low));
    expect(verified).not.toContain(hashOf(root));
    // Sweeps of one round: only the first eight are looked at.
    const base = trimOf(P, 'p');
    const sweeps = Array.from({ length: MAX_CK_CANDIDATES + 3 }, (_, i) => trimOf(P, 'p', { b: nextSid3(P, base.value), w: i + 1 }));
    const many = resolve('p', sweeps);
    const ckVerified = sweeps.filter((s) => many.verified.includes(hashOf(s)));
    expect(ckVerified.length).toBe(MAX_CK_CANDIDATES);
    // (they were looked at from the most sweeps down)
    expect(many.res.base?.ck.w).toBe(MAX_CK_CANDIDATES + 3);
  });

  it('does not count a crypto-invalid record against that limit: forging costs one check each, and no place', () => {
    const base = trimOf(P, 'p');
    const forged = Array.from({ length: MAX_CK_CANDIDATES + 2 }, (_, i) => changed(P, trimOf(P, 'p', { u: 20 + i, l: hex('e', 32) }), { g: BAD_SIG }));
    const honest = Array.from({ length: MAX_CK_CANDIDATES }, (_, i) => trimOf(P, 'p', { b: nextSid3(P, base.value), w: i + 1 }));
    const { res, verified } = resolve('p', [...forged, ...honest]);
    expect(res.invalid.length).toBe(forged.length);
    expect(res.base?.ck.w).toBe(MAX_CK_CANDIDATES);
    expect(honest.filter((h) => verified.includes(hashOf(h))).length).toBe(MAX_CK_CANDIDATES);
  });
});

describe('transfers (S2)', () => {
  const setup = (letter: FairOnlyLetter) => {
    const ctx = CTX[letter];
    const root = rootOf(ctx, letter);
    const trim = trimOf(ctx, letter); // u = 3
    const xf = xferOf(ctx, owner, buyer, 3);
    const adoption = trimOf(ctx, letter, { k: buyer.pub, dl: undefined, x: [xf.value] });
    return { ctx, root, trim, xf, adoption };
  };

  it('moves the game from the opener to the buyer an offer was made out to', () => {
    for (const letter of BOTH) {
      const { root, trim, xf, adoption } = setup(letter);
      const { res } = resolve(letter, [root, trim, xf, adoption]);
      expect(res.holder).toBe(buyer.pub);
      expect(res.chain.map((h) => [h.k, h.from])).toEqual([[owner.pub, 0], [buyer.pub, 3]]);
      expect(res.chain[1].step).toMatchObject({ key: xf.key, id: xfId(xf.value) });
      expect(res.invalid).toEqual([]);
      // the adoption and the opener's own trim are of one round, one state: the same live session
      expect(nextSid3(CTX[letter], adoption.value)).toBe(nextSid3(CTX[letter], trim.value));
      expect(res.base?.ck.u).toBe(3);
    }
  });

  it('is found under its own key, or only inside the checkpoint that carries it', () => {
    const { root, trim, xf, adoption } = setup('p');
    expect(resolve('p', [root, trim, xf]).res.holder, 'a transfer alone').toBe(buyer.pub);
    const inside = resolve('p', [root, trim, adoption]).res;
    expect(inside.holder, 'only inside the adoption').toBe(buyer.pub);
    expect(inside.chain[1].step?.key).toBeUndefined();
    // ... and a transfer inside a stranger's record is nobody's
    const hidden = trimOf(P, 'p', { u: 4, l: hex('e', 32), k: stranger.pub, dl: undefined, x: [xf.value] });
    expect(resolve('p', [root, trim, hidden]).res.holder, 'a stranger carries no transfer').toBe(owner.pub);
  });

  it('is read from a record only if it speaks for the buyer of the last transfer it carries', () => {
    const { ctx, root, trim, xf } = setup('p');
    const carried = (patch: Record<string, unknown>) => resolve('p', [root, trim, trimOf(ctx, 'p', { u: 5, l: hex('e', 32), x: [xf.value], ...patch })]).res;
    // the buyer's own, and a house of the buyer's: the only copy of the transfer
    expect(carried({ k: buyer.pub, dl: undefined }).holder, 'the buyer').toBe(buyer.pub);
    const buyersHouse = carried({ k: house2.pub, dl: delegation(buyer, house2.pub) });
    expect(buyersHouse.holder, 'a house of the buyer\'s').toBe(buyer.pub);
    expect(buyersHouse.base?.ck.k).toBe(house2.pub);
    expect(buyersHouse.chain[1].step?.key, 'the only copy').toBeUndefined();
    // the seller's house, a stranger's house, the seller itself, a house of a person not in it: none speaks for the buyer
    expect(carried({}).holder, 'the seller\'s house').toBe(owner.pub);
    expect(carried({ k: house2.pub, dl: delegation(stranger, house2.pub) }).holder, 'a stranger\'s house').toBe(owner.pub);
    expect(carried({ k: owner.pub, dl: undefined }).holder, 'the seller').toBe(owner.pub);
    expect(carried({ k: house2.pub, dl: delegation(third, house2.pub) }).invalid, 'and none is reported').toEqual([]);
  });

  it('a later buyer\'s checkpoint carries the whole chain, and is read by the buyer of its last step', () => {
    const { ctx, root, trim, xf } = setup('p');
    const onward = xferOf(ctx, buyer, third, 4, { nonce: hex('9', 24) });
    const carrier = trimOf(ctx, 'p', { u: 6, l: hex('e', 32), k: third.pub, dl: undefined, x: [xf.value, onward.value] });
    const { res } = resolve('p', [root, trim, carrier]); // no transfer under a key of its own
    expect(res.chain.map((h) => h.k)).toEqual([owner.pub, buyer.pub, third.pub]);
    expect(res.base?.key).toBe(carrier.key);
    expect(res.invalid).toEqual([]);
  });

  it('is read from a transfer key of this game only', () => {
    const { root, trim, xf } = setup('p');
    const bare = (cks: Entry[], xfs: Entry[]) => resolveGame(authEnv().env, T, P.inc, raw(cks, xfs));
    expect(bare([root, trim], [xf]).holder, 'the control').toBe(buyer.pub);
    // under a checkpoint's key, under a transfer key of another game (a transfer is good in one game only)
    const asCk: Entry = { key: ckKey(T, P.inc, xfId(xf.value)!), value: xf.value };
    expect(bare([root, trim], [asCk]).holder, 'under a ck: key').toBe(owner.pub);
    const foreign = xferOf(Q, owner, buyer, 3);
    const other = bare([root, trim], [foreign]);
    expect(other.holder, 'another game\'s').toBe(owner.pub);
    expect(other.invalid, 'and none of its records is this game\'s to report').toEqual([]);
  });

  it('a transfer that fails inside a checkpoint is nobody\'s, and has no key to report', () => {
    const { ctx, root, trim, xf } = setup('p');
    const forged = { ...xf.value, g: BAD_SIG };
    const carrier = trimOf(ctx, 'p', { u: 5, l: hex('e', 32), k: buyer.pub, dl: undefined, x: [forged] });
    const { res } = resolve('p', [root, trim, carrier]);
    expect(res.holder).toBe(owner.pub);
    expect(res.base?.key).toBe(trim.key);
    expect(res.invalid).toEqual([]);
  });

  it('does not count what was not signed by the seller, or by the buyer', () => {
    const { ctx, root, trim, xf } = setup('p');
    const forgedOffer = sealForged(ctx, { ...xf.value.o, sig: BAD_SIG });
    const a = resolve('p', [root, trim, forgedOffer]);
    expect(a.res.holder, 'a forged offer').toBe(owner.pub);
    expect(a.res.invalid).toEqual([forgedOffer.key]);
    const forgedXf = sealForged(ctx, xf.value.o, BAD_SIG);
    const b = resolve('p', [root, trim, forgedXf]);
    expect(b.res.holder, 'a forged transfer').toBe(owner.pub);
    expect(b.res.invalid).toEqual([forgedXf.key]);
    // the buyer's signature, but a stranger's offer (the maker is not the holder): not checked, not reported
    const notTheirs = xferOf(ctx, stranger, buyer, 3);
    const c = resolve('p', [root, trim, notTheirs]);
    expect(c.res.holder).toBe(owner.pub);
    expect(c.res.invalid).toEqual([]);
    expect(c.verified).not.toContain(hashOf(notTheirs));
  });

  it('counts only an offer made out to a person, for this room, free, and not older than the game', () => {
    const { ctx, root, trim } = setup('p');
    const fresh = (patch: object) => resolve('p', [root, trim, xferOf(ctx, owner, buyer, 3, patch)]).res.holder;
    expect(fresh({})).toBe(buyer.pub);
    expect(fresh({ issuedAt: NAME.ts - OFFER_SKEW_MS }), 'exactly the skew earlier').toBe(buyer.pub);
    expect(fresh({ issuedAt: NAME.ts - OFFER_SKEW_MS - 1 }), 'a ms older: a sale-back replay').toBe(owner.pub);
    expect(fresh({ price: 1 })).toBe(owner.pub);
    expect(fresh({ asset: { kind: 'deed', roomId: 'room-other', roomName: 'Furlong' } })).toBe(owner.pub);
    expect(fresh({ toPub: undefined }), 'a bearer offer').toBe(owner.pub);
  });

  it('takes the lowest round first, and then moves on from the new holder', () => {
    const { ctx, root, trim } = setup('p');
    const late = xferOf(ctx, owner, buyer, 5, { nonce: hex('1', 24) });
    const early = xferOf(ctx, owner, third, 2, { nonce: hex('2', 24) });
    const onward = xferOf(ctx, third, fourth, 4, { nonce: hex('3', 24) });
    const res = resolve('p', [root, trim, late, early, onward]).res;
    expect(res.chain.map((h) => [h.k, h.from])).toEqual([[owner.pub, 0], [third.pub, 2], [fourth.pub, 4]]);
    // the same round: the lowest id
    const a = xferOf(ctx, owner, buyer, 2, { nonce: hex('4', 24) });
    const b = xferOf(ctx, owner, third, 2, { nonce: hex('5', 24) });
    const [lo] = [a, b].sort((x, y) => (xfId(x.value)! < xfId(y.value)! ? -1 : 1));
    expect(resolve('p', [root, trim, a, b]).res.holder).toBe(lo.value.k);
    // before the round the holder took the game, a transfer by it counts for nothing
    const tooEarly = xferOf(ctx, third, fourth, 1, { nonce: hex('6', 24) });
    expect(resolve('p', [root, trim, early, tooEarly]).res.holder).toBe(third.pub);
    const sameRound = xferOf(ctx, third, fourth, 2, { nonce: hex('7', 24) });
    expect(resolve('p', [root, trim, early, sameRound]).res.holder).toBe(fourth.pub);
  });

  it('uses an offer once: a game sold back and forth cannot be moved by the same offer again', () => {
    const { ctx, root, trim } = setup('p');
    const ab = xferOf(ctx, owner, buyer, 3, { nonce: hex('1', 24) });
    const ba = xferOf(ctx, buyer, owner, 4, { nonce: hex('2', 24) });
    const again = xferOf(ctx, owner, third, 6, { nonce: hex('1', 24) }); // the first offer's nonce
    const res = resolve('p', [root, trim, ab, ba, again]).res;
    expect(res.chain.map((h) => h.k)).toEqual([owner.pub, buyer.pub, owner.pub]);
    const fresh = xferOf(ctx, owner, third, 6, { nonce: hex('3', 24) });
    expect(resolve('p', [root, trim, ab, ba, fresh]).res.chain.map((h) => h.k)).toEqual([owner.pub, buyer.pub, owner.pub, third.pub]);
  });

  it('follows at most MAX_TRANSFERS transfers', () => {
    const { ctx, root, trim } = setup('p');
    const people = [owner, buyer, third, fourth, stranger];
    const steps: Entry[] = [];
    for (let i = 0; i < MAX_TRANSFERS + 2; i++) {
      steps.push(xferOf(ctx, people[i % people.length], people[(i + 1) % people.length], i + 1, { nonce: `${i}`.padStart(24, '0') }));
    }
    const res = resolve('p', [root, trim, ...steps]).res;
    expect(res.chain.length).toBe(MAX_TRANSFERS + 1);
  });

  it('is found only under the key that is its own hash', () => {
    const { root, trim, xf } = setup('p');
    const wrong: Entry = { key: xfKey(T, P.inc, hex('9', 32)), value: xf.value };
    expect(resolve('p', [root, trim, wrong]).res.holder).toBe(owner.pub);
    const other: Entry = { key: xfKey('other-table', P.inc, xfId(xf.value)!), value: xf.value };
    expect(resolve('p', [root, trim, other]).res.holder).toBe(owner.pub);
  });

  it('a checkpoint of the buyer\'s counts only with the transfers that brought the game to it', () => {
    const { ctx, root, trim, xf } = setup('p');
    const noX = trimOf(ctx, 'p', { u: 5, l: hex('e', 32), k: buyer.pub, dl: undefined });
    expect(resolve('p', [root, trim, xf, noX]).res.base?.key, 'no transfer carried').toBe(trim.key);
    const other = xferOf(ctx, owner, third, 3, { nonce: hex('8', 24) });
    const wrongX = trimOf(ctx, 'p', { u: 5, l: hex('e', 32), k: buyer.pub, dl: undefined, x: [other.value] });
    expect(resolve('p', [root, trim, xf, wrongX]).res.base?.key, 'another transfer carried').toBe(trim.key);
    const right = trimOf(ctx, 'p', { u: 5, l: hex('e', 32), k: buyer.pub, dl: undefined, x: [xf.value] });
    expect(resolve('p', [root, trim, xf, right]).res.base?.key).toBe(right.key);
    // and the opener's own, with a transfer it did not need
    const extra = trimOf(ctx, 'p', { u: 2, l: hex('d', 32), x: [xf.value] });
    expect(resolve('p', [root, xf, extra]).res.base?.key, 'the opener carries none').toBe(root.key);
  });

  it('a signer holds the game from the round it took it, and until the round it gave it, both ends included', () => {
    const { ctx, root, xf } = setup('p');
    const at = (u: number, who: 'owner' | 'buyer') => {
      const patch = who === 'owner' ? {} : { k: buyer.pub, dl: undefined, x: [xf.value] };
      return trimOf(ctx, 'p', { u, l: hex('e', 32), ...patch });
    };
    const counted = (rec: Entry): boolean => resolve('p', [root, xf, rec]).res.base?.key === rec.key;
    expect(counted(at(3, 'owner')), 'the opener at the round it gave the game').toBe(true);
    expect(counted(at(4, 'owner')), 'the opener after it').toBe(false);
    expect(counted(at(3, 'buyer')), 'the buyer at the round it took it').toBe(true);
    expect(counted(at(2, 'buyer')), 'the buyer before it').toBe(false);
    expect(counted(at(2, 'owner'))).toBe(true);
    expect(counted(at(40, 'buyer'))).toBe(true);
  });

  it('a house counts under the key that delegated it, in that key\'s range', () => {
    const { ctx, root, trim, xf } = setup('p');
    const buyersHouse = (u: number) => trimOf(ctx, 'p', { u, l: hex('e', 32), k: house2.pub, dl: delegation(buyer, house2.pub), x: [xf.value] });
    const records = (rec: Entry) => resolve('p', [root, trim, xf, rec]).res.base?.key === rec.key;
    expect(records(buyersHouse(5))).toBe(true);
    expect(records(buyersHouse(2)), 'before the buyer had the game').toBe(false);
    // the first house, delegated by the opener, after the sale
    const sellersHouse = trimOf(ctx, 'p', { u: 5, l: hex('e', 32) });
    expect(records(sellersHouse), 'the seller\'s house past the sale').toBe(false);
    // a delegation by a stranger of a house signing a game it does not hold
    const strangers = trimOf(ctx, 'p', { u: 5, l: hex('e', 32), k: house2.pub, dl: delegation(stranger, house2.pub), x: [xf.value] });
    expect(records(strangers)).toBe(false);
    expect(resolve('p', [root, trim, xf, buyersHouse(5)]).res.invalid).toEqual([]);
  });
});

/** A transfer record whose signatures are as given: the seller's on the offer as it stands, and the buyer's
 *  `g` (by default the buyer signs this very record, so a change to the offer fails the seller's signature alone). */
function sealForged(ctx: FoldCtx, offer: XferRec['o'], g?: string): Entry {
  if (g === undefined) return sealXf(ctx, { v: 1, o: offer, u: 3, k: buyer.pub }, buyer.sign);
  const value = { v: 1, o: offer, u: 3, k: buyer.pub, g };
  return { key: xfKey(ctx.t, ctx.inc, xfId(value) as string), value };
}

describe('ends and end orders (S5, S7)', () => {
  const ended = (letter: FairOnlyLetter, who = owner, patch: Record<string, unknown> = {}) => {
    const ctx = CTX[letter];
    const fin = sealFin(ctx, who.pub, who.sign).value;
    return trimOf(ctx, letter, { e: 1, f: fin, s: undefined, h: undefined, k: who.pub, dl: undefined, ...patch });
  };

  it('an end by the opener is the base, and the game is not live', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      const end = ended(letter);
      const { res } = resolve(letter, [root, trimOf(ctx, letter), end]);
      expect(res).toMatchObject({ live: false, invalid: [] });
      expect(res.base?.key).toBe(end.key);
      expect(res.fin).toEqual(end.value.f);
    }
  });

  it('an end order counts if an owner-level key signed it that holds the game where it ends', () => {
    const root = rootOf(P, 'p');
    const strangers = ended('p', stranger);
    expect(resolve('p', [root, strangers]).res, 'a stranger\'s').toMatchObject({ live: true, invalid: [] });
    expect(resolve('p', [root, strangers]).res.base?.key).toBe(root.key);
    // the opener's after the sale: out of range; the buyer's: in range
    const xf = xferOf(P, owner, buyer, 3);
    const late = ended('p', owner, { u: 6, l: hex('e', 32) });
    expect(resolve('p', [root, xf, late]).res.base?.key, 'the seller ends it after selling').toBe(root.key);
    const byBuyer = ended('p', buyer, { u: 6, l: hex('e', 32), x: [xf.value] });
    const r = resolve('p', [root, xf, byBuyer]).res;
    expect(r.base?.key).toBe(byBuyer.key);
    expect(r.live).toBe(false);
    // an end written by the buyer's house, carrying the buyer's order
    const byHouse = trimOf(P, 'p', { e: 1, f: sealFin(P, buyer.pub, buyer.sign).value, s: undefined, h: undefined, u: 6, l: hex('e', 32), k: house2.pub, dl: delegation(buyer, house2.pub), x: [xf.value] });
    expect(resolve('p', [root, xf, byHouse]).res.live).toBe(false);
    // an order the house signed is no owner's
    const byHouseOrder = trimOf(P, 'p', { e: 1, f: sealFin(P, house.pub, houseSigner).value, s: undefined, h: undefined, k: owner.pub, dl: undefined });
    expect(resolve('p', [root, byHouseOrder]).res.live).toBe(true);
  });

  it('names the end order the base carries before the one the doc holds', () => {
    const root = rootOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const embedded = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { e: 1, f: embedded, s: undefined, h: undefined, k: owner.pub, dl: undefined });
    // (the buyer holds the game from round 3 too: its order stands beside the seller's)
    const theirs = sealFin(P, buyer.pub, buyer.sign);
    expect(resolve('p', [root, xf, end, theirs]).res.fin).toEqual(embedded);
    expect(resolve('p', [theirs, end, xf, root]).res.fin).toEqual(embedded);
  });

  it('a standing end order changes no count and ends nothing by itself', () => {
    for (const letter of BOTH) {
      const ctx = CTX[letter];
      const root = rootOf(ctx, letter);
      const trim = trimOf(ctx, letter);
      const fin = sealFin(ctx, owner.pub, owner.sign);
      const { res } = resolve(letter, [root, trim, fin]);
      expect(res.fin).toEqual(fin.value);
      expect(res.live).toBe(true);
      expect(res.base?.key).toBe(trim.key);
    }
  });

  it('a standing end order is the holder\'s at the base\'s round, and its signature holds', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p'); // u = 3
    const finBy = (who: typeof owner) => sealFin(P, who.pub, who.sign);
    expect(resolve('p', [root, trim, finBy(stranger)]).res.fin, 'a stranger\'s').toBeNull();
    expect(resolve('p', [root, trim, finBy(buyer)]).res.fin, 'a buyer with no transfer').toBeNull();
    const forged = { key: finBy(owner).key, value: { ...finBy(owner).value, g: BAD_SIG } };
    expect(resolve('p', [root, trim, forged]).res.fin, 'forged').toBeNull();
    // after the sale: the opener\'s order holds up to the round it gave the game, the buyer\'s from it
    const xf = xferOf(P, owner, buyer, 3);
    expect(resolve('p', [root, trim, xf, finBy(owner)]).res.fin, 'at the round of the sale, the seller\'s').not.toBeNull();
    expect(resolve('p', [root, trim, xf, finBy(buyer)]).res.fin, 'at the round of the sale, the buyer\'s').not.toBeNull();
    const later = trimOf(P, 'p', { u: 6, l: hex('e', 32), k: buyer.pub, dl: undefined, x: [xf.value] });
    expect(resolve('p', [root, later, xf, finBy(owner)]).res.fin, 'after the sale, the seller\'s').toBeNull();
    expect(resolve('p', [root, later, xf, finBy(buyer)]).res.fin, 'after the sale, the buyer\'s').not.toBeNull();
    // no base: nothing to hold it against
    expect(resolve('p', [finBy(owner)]).res.fin).toBeNull();
  });
});

describe('what is not yet checked (pending)', () => {
  it('a best record put off leaves the next best standing, and the pass pending until it is checked', () => {
    const root = rootOf(P, 'p');
    const five = trimOf(P, 'p', { u: 5, l: hex('e', 32) });
    const three = trimOf(P, 'p');
    const held = resolve('p', [root, three, five], { hold: [hashOf(five)] });
    expect(held.res.base?.key).toBe(three.key);
    expect(held.res.pending).toBe(true);
    expect(held.res.invalid).toEqual([]);
    held.hold.delete(hashOf(five));
    const again = resolveGame(held.env, T, P.inc, recordsOf([root, three, five]));
    expect(again.base?.key).toBe(five.key);
    expect(again.pending).toBe(false);
  });

  it('one that could not beat the base does not hold the pass', () => {
    const root = rootOf(P, 'p');
    const five = trimOf(P, 'p', { u: 5, l: hex('e', 32) });
    const three = trimOf(P, 'p');
    // the lower one is looked at first (it closes the live session) and put off; the higher one then settles it
    const live = nextSid3(P, root.value);
    const closing = trimOf(P, 'p', { b: live, u: 2, l: hex('d', 32) });
    const held = resolve('p', [root, closing, five, three], { liveSid: live, hold: [hashOf(closing)] });
    expect(held.res.base?.key).toBe(five.key);
    expect(held.res.pending).toBe(false);
    // ... but one of the same round could win on the tie-break
    const sweep = trimOf(P, 'p', { b: nextSid3(P, three.value), w: 1 });
    const tie = resolve('p', [root, three, sweep], { hold: [hashOf(sweep)] });
    expect(tie.res.base?.key).toBe(three.key);
    expect(tie.res.pending).toBe(true);
  });

  it('one that ranks under the base by S3\'s whole order, not only by its round, does not hold the pass', () => {
    const root = rootOf(P, 'p');
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined });
    const live = trimOf(P, 'p', { n: { alice: '21', bob: '-21' } });
    // an end stands at the round, and a live checkpoint of that round is put off: either answer leaves the end the base
    const underEnd = resolve('p', [root, end, live], { hold: [hashOf(live)] });
    expect(underEnd.res).toMatchObject({ pending: false, live: false, invalid: [] });
    expect(underEnd.res.base?.key).toBe(end.key);
    // ... but an end of that round put off, over a live base, could be the base
    const overLive = resolve('p', [root, end, live], { hold: [hashOf(end)] });
    expect(overLive.res.base?.key).toBe(live.key);
    expect(overLive.res.pending).toBe(true);
    // fewer sweeps are under the base; more are over it
    const three = trimOf(P, 'p');
    const sweeps = [1, 2].map((w) => trimOf(P, 'p', { b: nextSid3(P, three.value), w }));
    const [one, two] = sweeps;
    expect(resolve('p', [root, one, two], { hold: [hashOf(one)] }).res.pending, 'one sweep under two').toBe(false);
    expect(resolve('p', [root, one, two], { hold: [hashOf(two)] }).res.pending, 'two over one').toBe(true);
    // the same round, the same kind: the lower id wins, so only a lower one put off holds the pass
    const states = [0, 1, 2, 3].map((i) => trimOf(P, 'p', { n: { alice: `${20 + i}`, bob: `-${20 + i}` } }));
    const byId = [...states].sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(resolve('p', [root, ...states], { hold: [hashOf(byId[3])] }).res.pending, 'the highest id').toBe(false);
    expect(resolve('p', [root, ...states], { hold: [hashOf(byId[0])] }).res.pending, 'the lowest id').toBe(true);
  });

  it('one put off that holds a place of the cap keeps the pass pending while a better one lies past the places', () => {
    const root = rootOf(P, 'p');
    const live = nextSid3(P, root.value);
    // Seven good checkpoints of round 3 (each with a sweep) and a forged one of round 3 close the live session: the eight places.
    const threes = Array.from({ length: MAX_CK_CANDIDATES - 1 }, (_, i) => trimOf(P, 'p', { b: live, w: 1, n: { alice: `${20 + i}`, bob: `-${20 + i}` } }));
    const forged = changed(P, trimOf(P, 'p', { b: live, l: hex('d', 32) }), { g: BAD_SIG });
    // A good one of round 5, closing a session that is not the live one, comes after them.
    const five = trimOf(P, 'p', { u: 5, l: hex('e', 32) });
    const all = [root, ...threes, forged, five];
    const held = resolve('p', all, { liveSid: live, hold: [hashOf(forged)] });
    expect(held.res.base?.ck.u, 'the round 3 stands for now').toBe(3);
    expect(held.verified, 'the round 5 is not looked at: the forgery holds the eighth place').not.toContain(hashOf(five));
    expect(held.res.pending, 'but its failing would let the round 5 in').toBe(true);
    // Checked, the forgery fails and takes no place: the round 5 is the base, and nothing is waiting.
    held.hold.delete(hashOf(forged));
    const again = resolveGame(held.env, T, P.inc, recordsOf(all));
    expect(again.base?.key).toBe(five.key);
    expect(again).toMatchObject({ pending: false, invalid: [forged.key] });
    // Past the places there is one that could not be the base: it does not hold the pass.
    const one = trimOf(P, 'p', { u: 1, l: hex('9', 32) });
    const low = resolve('p', [root, ...threes, forged, one], { liveSid: live, hold: [hashOf(forged)] });
    expect(low.res.base?.ck.u).toBe(3);
    expect(low.res.pending).toBe(false);
    // And with nothing put off, a full set of good ones is the limit S3 documents: nothing frees a place, so nothing waits.
    const full = resolve('p', [root, ...threes, trimOf(P, 'p', { b: live, w: 1, l: hex('d', 32) }), five], { liveSid: live });
    expect(full.res).toMatchObject({ pending: false, invalid: [] });
    expect(full.res.base?.ck.u).toBe(3);
  });

  it('a transfer put off leaves the chain where it was, and the pass pending', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const adoption = trimOf(P, 'p', { u: 5, l: hex('e', 32), k: buyer.pub, dl: undefined, x: [xf.value] });
    const held = resolve('p', [root, trim, xf, adoption], { hold: [recHash(xf.value.o) as string] });
    expect(held.res.holder).toBe(owner.pub);
    expect(held.res.pending).toBe(true);
    expect(held.res.base?.key).toBe(trim.key);
    expect(held.res.invalid).toEqual([]);
  });

  it('does not pass over a transfer that was put off to take a later one', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const early = xferOf(P, owner, third, 2, { nonce: hex('2', 24) });
    const late = xferOf(P, owner, buyer, 5, { nonce: hex('1', 24) });
    const held = resolve('p', [root, trim, early, late], { hold: [recHash(early.value.o) as string] });
    expect(held.res).toMatchObject({ holder: owner.pub, pending: true, invalid: [] });
    held.hold.clear();
    expect(resolveGame(held.env, T, P.inc, recordsOf([root, trim, early, late]))).toMatchObject({ holder: third.pub, pending: false });
  });

  it('a root put off leaves no base yet, and the pass pending', () => {
    const root = rootOf(P, 'p');
    const held = resolve('p', [root], { hold: [hashOf(root)] });
    expect(held.res).toMatchObject({ base: null, live: false, pending: true, invalid: [], holder: owner.pub });
  });

  it('so is one whose buyer\'s signature is put off, once the seller\'s was checked', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const held = resolve('p', [root, trim, xf], { hold: [recHash(xf.value) as string] });
    expect(held.res).toMatchObject({ holder: owner.pub, pending: true, invalid: [] });
    expect(held.verified).toContain(recHash(xf.value.o));
    held.hold.clear();
    const again = resolveGame(held.env, T, P.inc, recordsOf([root, trim, xf]));
    expect(again).toMatchObject({ holder: buyer.pub, pending: false });
  });

  it('an end order put off is no end order yet', () => {
    const root = rootOf(P, 'p');
    const fin = sealFin(P, owner.pub, owner.sign);
    const held = resolve('p', [root, fin], { hold: [hashOf(fin)] });
    expect(held.res.fin).toBeNull();
    expect(held.res.pending).toBe(true);
  });
});

describe('who decides a round (houseAt)', () => {
  it('a house delegated by the holder decides the rounds after the round the holder took the game', () => {
    for (const letter of BOTH) {
      const root = rootOf(CTX[letter], letter);
      const { res } = resolve(letter, [root]);
      expect(res.houseAt(house.pub, 1)).toBe(true);
      expect(res.houseAt(house.pub, 1_000_000)).toBe(true);
      expect(res.houseAt(house.pub, 0), 'there is no round 0').toBe(false);
      expect(res.houseAt(house2.pub, 1), 'a house nobody delegated').toBe(false);
    }
  });

  it('after a sale the seller\'s house decides up to the round of the sale, the buyer\'s after it', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const buyersDl = delegation(buyer, house2.pub);
    const adoption = trimOf(P, 'p', { u: 3, k: house2.pub, dl: buyersDl, x: [xf.value] });
    const { res } = resolve('p', [root, trim, xf, adoption]);
    expect(res.holder).toBe(buyer.pub);
    expect(res.houseAt(house.pub, 3), 'the seller\'s house at the round of the sale').toBe(true);
    expect(res.houseAt(house.pub, 4), 'the seller\'s house after it').toBe(false);
    expect(res.houseAt(house2.pub, 3), 'the buyer\'s house at the round of the sale').toBe(false);
    expect(res.houseAt(house2.pub, 4), 'the buyer\'s house after it').toBe(true);
  });

  it('is read from the room\'s delegations as well as the game\'s checkpoints, and a forged one counts for nothing', () => {
    const root = rootOf(P, 'p');
    const ours = delegation(owner, house2.pub);
    const a = resolve('p', [root], { delegations: [ours] });
    expect(a.res.houseAt(house2.pub, 1)).toBe(true);
    const forged = { ...ours, g: BAD_SIG };
    const b = resolve('p', [root], { delegations: [forged] });
    expect(b.res.houseAt(house2.pub, 1)).toBe(false);
    // by a stranger, or not a delegation at all
    expect(resolve('p', [root], { delegations: [delegation(stranger, house2.pub), 'x', null, { v: 1 }] }).res.houseAt(house2.pub, 1)).toBe(false);
  });

  it('checks a delegation once a call, however many places carry it', () => {
    const root = rootOf(P, 'p');
    const forged = { ...delegation(owner, house2.pub), g: BAD_SIG };
    const a = authEnv();
    const calls: string[] = [];
    const env = { ...a.env, sig: (h: string, pub: string, bytes: () => Uint8Array, sig: string) => { calls.push(h); return a.env.sig(h, pub, bytes, sig); } };
    const res = resolveGame(env, T, P.inc, recordsOf([root], [forged, { ...forged }, forged]));
    calls.length = 0;
    expect(res.houseAt(house2.pub, 1)).toBe(false);
    expect(calls).toEqual([sigId('hkey', T, P.inc, recHash(forged) as string)]);
  });

  it('a delegation put off does not hide one that holds', () => {
    const root = rootOf(P, 'p');
    const junk = { ...delegation(owner, house2.pub), g: BAD_SIG };
    const good = delegation(owner, house2.pub);
    const held = resolve('p', [root], { delegations: [junk, good], hold: [recHash(junk) as string] });
    expect(held.res.houseAt(house2.pub, 1)).toBe(true);
  });

  it('a delegation put off is not yet known', () => {
    const root = rootOf(P, 'p');
    const ours = delegation(owner, house2.pub);
    const held = resolve('p', [root], { delegations: [ours], hold: [recHash(ours) as string] });
    expect(held.res.houseAt(house2.pub, 1)).toBeUndefined();
    expect(held.res.houseAt(house.pub, 1), 'the root\'s own is checked with the root').toBe(true);
    expect(held.res.houseAt(stranger.pub, 1), 'no delegation at all: no').toBe(false);
  });
});

describe('the table\'s game (S9)', () => {
  const game = (inc: string, holder: string, live = true): Resolution => ({ inc, holder, live } as unknown as Resolution);
  const a = game('p' + hex('a', 24), owner.pub);
  const b = game('p' + hex('b', 24), buyer.pub);
  const c = game('p' + hex('c', 24), buyer.pub);

  it('is the only live game whose holder holds the deed', () => {
    expect(tableGame([a, b], buyer.pub, a.inc)).toBe(b);
    expect(tableGame([a, b], owner.pub, b.inc)).toBe(a);
  });

  it('else the game the switch names, if it is live', () => {
    expect(tableGame([b, c], buyer.pub, c.inc), 'two of the deed holder\'s: the switch').toBe(c);
    expect(tableGame([a, b], stranger.pub, b.inc), 'none the deed holder\'s: the switch').toBe(b);
    expect(tableGame([a, b], null, a.inc)).toBe(a);
    expect(tableGame([a, b], undefined, a.inc)).toBe(a);
  });

  it('else the only live one, else the lowest name', () => {
    const dead = game('p' + hex('d', 24), owner.pub, false);
    expect(tableGame([a, dead], stranger.pub, null)).toBe(a);
    expect(tableGame([a, dead], stranger.pub, dead.inc), 'a switch naming a dead game').toBe(a);
    expect(tableGame([c, b, a], stranger.pub, null)).toBe(a);
    expect(tableGame([c, b], stranger.pub, 'p' + hex('f', 24))).toBe(b);
  });

  it('is none when no game is live', () => {
    expect(tableGame([], owner.pub, null)).toBeNull();
    expect(tableGame([game('p' + hex('d', 24), owner.pub, false)], owner.pub, null)).toBeNull();
  });
});

describe('the answer does not depend on the order the records come in', () => {
  it('any order of the same records gives the same game', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const adoption = trimOf(P, 'p', { k: buyer.pub, dl: undefined, x: [xf.value] });
    const sweep = trimOf(P, 'p', { b: nextSid3(P, trim.value), w: 1 });
    const junk = changed(P, trimOf(P, 'p', { u: 8, l: hex('e', 32) }), { g: BAD_SIG });
    const all: Entry[] = [root, trim, xf, adoption, sweep, junk];
    const view = (r: Resolution) => ({ base: r.base?.key, holder: r.holder, chain: r.chain.map((h) => [h.k, h.from]), invalid: r.invalid, live: r.live, fin: r.fin, pending: r.pending });
    const want = view(resolve('p', all).res);
    expect(want.base).toBeDefined();
    for (let shift = 1; shift < all.length; shift++) {
      expect(view(resolve('p', [...all.slice(shift), ...all.slice(0, shift)]).res), `rotated by ${shift}`).toEqual(want);
    }
    expect(view(resolve('p', [...all].reverse()).res)).toEqual(want);
  });
});

describe('what a check is asked about (the id)', () => {
  it('names the record under what its signature binds: the game for a game\'s own signatures, the room alone for the others', () => {
    const h = hex('a', 64);
    expect(sigId('ck', T, P.inc, h)).toBe(`ck|${T}|${P.inc}|${h}`);
    expect(sigId('xf', T, P.inc, h)).toBe(`xf|${T}|${P.inc}|${h}`);
    expect(sigId('fin', T, P.inc, h)).toBe(`fin|${T}|${P.inc}|${h}`);
    expect(sigId('offer', T, P.inc, h)).toBe(`offer|${h}`);
    expect(sigId('hkey', T, P.inc, h)).toBe(`hkey|${h}`);
    const ids = new Set([
      sigId('ck', T, P.inc, h), sigId('xf', T, P.inc, h), sigId('fin', T, P.inc, h), sigId('ck', 'roulette-2', P.inc, h), sigId('ck', T, Q.inc, h),
      sigId('ck', T, P.inc, hex('b', 64)),
    ]);
    expect(ids.size, 'no two of a different kind, table, game or record').toBe(6);
    // (a table id that holds the separator makes no id of another table: the game and the hash have a fixed spelling)
    expect(sigId('ck', 'a|b', P.inc, h)).not.toBe(sigId('ck', 'a', P.inc, h));
  });

  it('is what the resolver gives the check, for every signature it asks about', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const adoption = trimOf(P, 'p', { k: buyer.pub, dl: undefined, x: [xf.value] });
    const fin = sealFin(P, buyer.pub, buyer.sign);
    const a = authEnv();
    const asked: string[] = [];
    const env = { ...a.env, sig: (id: string, pub: string, bytes: () => Uint8Array, sig: string) => { asked.push(id); return a.env.sig(id, pub, bytes, sig); } };
    const res = resolveGame(env, T, P.inc, recordsOf([root, trim, xf, adoption, fin], [delegation(owner, house2.pub)]));
    expect(res.houseAt(house2.pub, 1)).toBe(true);
    expect(res.fin).not.toBeNull();
    const want = [
      sigId('ck', T, P.inc, hashOf(adoption)), sigId('ck', T, P.inc, hashOf(trim)), sigId('offer', T, P.inc, recHash(xf.value.o) as string),
      sigId('xf', T, P.inc, hashOf(xf)), sigId('fin', T, P.inc, hashOf(fin)), sigId('hkey', T, P.inc, recHash(DL_HOUSE) as string),
      sigId('hkey', T, P.inc, recHash(delegation(owner, house2.pub)) as string),
    ];
    for (const id of want) expect(asked, id).toContain(id);
    // nothing is asked under a bare hash
    for (const id of asked) expect(id).toMatch(/^(ck|xf|fin)\|.+\|[pq][0-9a-f]{24}\|[0-9a-f]{32,64}$|^(offer|hkey)\|[0-9a-f]{32,64}$/);
  });

  it('is the same for an end order inside an end checkpoint, which no record of its own carries', () => {
    const root = rootOf(P, 'p');
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined });
    const a = authEnv();
    const asked: string[] = [];
    const env = { ...a.env, sig: (id: string, pub: string, bytes: () => Uint8Array, sig: string) => { asked.push(id); return a.env.sig(id, pub, bytes, sig); } };
    const res = resolveGame(env, T, P.inc, recordsOf([root, end]));
    expect(res.base?.key, 'the end is the base').toBe(end.key);
    expect(asked).toContain(sigId('fin', T, P.inc, recHash(fin) as string));
    expect(asked, 'not under the bare hash').not.toContain(recHash(fin));
  });
});

describe('games that share a cache of verdicts', () => {
  const T2 = 'roulette-2';
  const P2 = ctxOf('p', T2);
  const rootA = rootOf(P, 'p');
  const trimA = trimOf(P, 'p');
  const xfA = xferOf(P, owner, buyer, 3);
  const finA = sealFin(P, owner.pub, owner.sign);
  const rootB = rootOf(P2, 'p');
  const trimB = trimOf(P2, 'p');
  // (another game's records, the same bytes: the key is B's and the value is what A's writers signed)
  const xfCopy = { key: xfKey(T2, P2.inc, xfId(xfA.value) as string), value: xfA.value };
  const finCopy = { key: finKey(T2, P2.inc), value: finA.value };

  /** Both games read by one environment (so one cache), in the order given. */
  const both = (a: Entry[], b: Entry[], order: ('a' | 'b')[]) => {
    const { env, verified } = authEnv();
    const out = {} as Record<'a' | 'b', Resolution>;
    for (const g of order) out[g] = g === 'a' ? resolveGame(env, T, P.inc, recordsOf(a)) : resolveGame(env, T2, P2.inc, recordsOf(b));
    return { ...out, verified };
  };

  it('a transfer the buyer signed for one game is no transfer in another, whichever is read first', () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const r = both([rootA, trimA, xfA], [rootB, trimB, xfCopy], [...order]);
      expect(r.a.holder, `A, read ${order.join(' then ')}`).toBe(buyer.pub);
      expect(r.a.invalid, 'A\'s own transfer is not reported').toEqual([]);
      expect(r.b.holder, 'B keeps its owner').toBe(owner.pub);
      expect(r.b.invalid, 'and the copy is reported there').toEqual([xfCopy.key]);
    }
  });

  it('nor is an end order, nor a checkpoint', () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const r = both([rootA, trimA, finA], [rootB, trimB, finCopy], [...order]);
      expect(r.a.fin, `A, read ${order.join(' then ')}`).not.toBeNull();
      expect(r.b.fin, 'B has no end order').toBeNull();
    }
    // A's trim under B's key, read in B because the two games were opened with the same inputs at two tables (the name is of the table too);
    // the house signed it for A
    const asB = { key: ckKey(T2, P2.inc, ckId(trimA.value) as string), value: trimA.value };
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const r = both([rootA, trimA], [rootB, asB], [...order]);
      expect(r.a.base?.key, `A, read ${order.join(' then ')}`).toBe(trimA.key);
      expect(r.a.invalid).toEqual([]);
      expect(r.b.base?.key, 'B stays at its root').toBe(rootB.key);
      expect(r.b.invalid, 'and the copy is reported there').toEqual([asB.key]);
    }
  });

  it('while a signature that binds the room alone is checked once for them all', () => {
    const r = both([rootA, trimA, xfA], [rootB, trimB, xfCopy], ['a', 'b']);
    expect(r.verified.filter((h) => h === recHash(DL_HOUSE)).length, 'the owner\'s delegation of the house').toBe(1);
    expect(r.verified.filter((h) => h === recHash(xfA.value.o)).length, 'the maker\'s signature on the offer').toBe(1);
    expect(r.verified.filter((h) => h === hashOf(xfA)).length, 'but the buyer\'s, which is for a game, in each').toBe(2);
  });
});

describe('records padded with undefined fields', () => {
  /** `v` with `n` fields that are undefined: no reader counts them, and neither the id nor the signature sees them. */
  const pad = <T extends object>(v: T, n = 2_000): T => ({ ...v, ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`pad${i}`, undefined])) });

  it('a transfer, an end order or a delegation padded past the small-record cap is not read, checked or reported, and its clean twin is', () => {
    const root = rootOf(P, 'p');
    const trim = trimOf(P, 'p');
    const xf = xferOf(P, owner, buyer, 3);
    const padded = { key: xf.key, value: pad(xf.value) };
    expect(xfId(padded.value), 'the same record to canon, the id and the signature').toBe(xfId(xf.value));
    expect(weightOf(padded.value, MAX_SMALL_RECORD_BYTES)).toBeNull();
    const bare = resolve('p', [root, trim]);
    const clean = resolve('p', [root, trim, xf]);
    expect(clean.res.holder).toBe(buyer.pub);
    const fat = resolve('p', [root, trim, padded]);
    expect(fat.res).toMatchObject({ holder: owner.pub, invalid: [], pending: false });
    expect(fat.verified, 'and nothing of it was checked').toEqual(bare.verified);
    // a little padding is the same record
    expect(resolve('p', [root, trim, { key: xf.key, value: pad(xf.value, 3) }]).res.holder).toBe(buyer.pub);
    // padding inside the offer weighs the transfer as much
    expect(resolve('p', [root, trim, { key: xf.key, value: { ...xf.value, o: pad(xf.value.o) } }]).res.holder).toBe(owner.pub);

    const fin = sealFin(P, owner.pub, owner.sign);
    expect(resolve('p', [root, trim, fin]).res.fin).not.toBeNull();
    const fatFin = resolve('p', [root, trim, { key: fin.key, value: pad(fin.value) }]);
    expect(fatFin.res).toMatchObject({ fin: null, invalid: [], pending: false });
    expect(fatFin.verified).toEqual(bare.verified);

    const ours = delegation(owner, house2.pub);
    expect(resolve('p', [root], { delegations: [ours] }).res.houseAt(house2.pub, 1)).toBe(true);
    const fatDl = resolve('p', [root], { delegations: [pad(ours)] });
    expect(fatDl.res.houseAt(house2.pub, 1)).toBe(false);
    expect(fatDl.verified, 'the delegation was not checked').not.toContain(recHash(ours));
  });
});

// (kept so `ckKey`/`CkRec` stay used by the helpers above)
void ckKey;
void (null as unknown as CkRec);
