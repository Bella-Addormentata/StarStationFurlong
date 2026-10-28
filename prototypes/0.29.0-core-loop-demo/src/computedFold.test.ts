/**
 * 🧮 The computed-table fold (computedFold.ts): records in, rounds and chips
 * out, the same on every page.
 *
 * These specs pin the encoding (canon, recHash, keys), what a record must look
 * like to count, how one close is decided, which close the chain picks, what
 * the felt holds, and the property everything else rests on: the output is a
 * function of the record SET — any arrival order, any batching, any mix of
 * inserts and deletes gives what a cold fold of the same records gives.
 *
 * Records come from computedTestKit (deterministic identities and seeds,
 * signed for TEST_CTX); one caching SigCheck on the real strict verifier is
 * shared, so each record is verified once for the whole file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  abandonKey, asAbandon, asCheckpoint, asClose, asForfeit, asReveal, asSlip, canon, closeKey, dutyRank, forfeitKey,
  MAX_FROZEN, MAX_SESSION_ROUNDS, MAX_SLIP_BETS, nextSid, parseKey, pocketOf, recHash, revealKey, seedTable, slipCommit,
  slipKey, TableFold,
} from './computedFold';
import type { AbandonRec, CloseRec, FoldResult, ForfeitRec, SlipRec } from './computedFold';
import {
  black, cachingCheck, ComputedKit, fakeIdentity, red, snapshot, straight, TEST_CTX, TestSession, testIdentity,
  trustAll,
} from './computedTestKit';
import type { Built } from './computedTestKit';
import { combinePocketSeeds, commitTableSeed } from './games/diceFairness';
import { payoutFor } from './games/roulette';
import type { RouletteBet } from './games/roulette';

const kit = new ComputedKit();
const sigs = cachingCheck();
const A = testIdentity('alice');
const B = testIdentity('bob');
const C = testIdentity('carol');
const D = testIdentity('dave');
const SID = 'g';
const NOBODY = 'f'.repeat(32);

const fold = (s: TestSession, cp: Parameters<TestSession['fold']>[1] = null): FoldResult => s.fold(sigs.check, cp).result();
const stakeOf = (b: RouletteBet[]): bigint => BigInt(b.reduce((n, x) => n + x.amount, 0));
const deltaOf = (b: RouletteBet[], pocket: number): bigint => BigInt(b.reduce((n, x) => n + payoutFor(x, pocket), 0)) - stakeOf(b);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The lower-ranked (first in line) of two closers for a duty and round. */
function inLine(duty: 'close' | 'forfeit' | 'abandon', r: number, ...ids: ReturnType<typeof testIdentity>[]) {
  return [...ids].sort((x, y) => (dutyRank(duty, TEST_CTX, r, x.pub) < dutyRank(duty, TEST_CTX, r, y.pub) ? -1 : 1));
}

// ── Purity ───────────────────────────────────────────────────────────────────

describe('the fold module', () => {
  it('stays pure: its whole import graph is the pure game engines and @noble/hashes', () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const walk = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = readFileSync(new URL(`./${rel}.ts`, import.meta.url), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${rel}: a clock, randomness or storage`).not.toMatch(/\bDate\b|Math\.random|localStorage|performance\./);
      for (const [, spec] of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        if (!spec.startsWith('.')) { bare.add(spec); continue; }
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
        const parts = `${dir}${spec}`.split('/').reduce<string[]>((acc, x) => (x === '..' ? acc.slice(0, -1) : x === '.' ? acc : [...acc, x]), []);
        walk(parts.join('/'));
      }
    };
    walk('computedFold');
    expect([...seen].sort()).toEqual(['computedCraps', 'computedFold', 'games/craps', 'games/diceFairness', 'games/fairDice', 'games/roulette']);
    expect([...bare].sort()).toEqual(['@noble/hashes/sha256', '@noble/hashes/utils']);
  });
});

// ── Encoding ─────────────────────────────────────────────────────────────────

describe('canon and recHash', () => {
  it('sort keys, keep integers and strings, and skip undefined fields (golden)', () => {
    expect(canon({ b: [1, 'x', [-2]], a: { d: 2, c: 'y' } })).toBe('{"a":{"c":"y","d":2},"b":[1,"x",[-2]]}');
    expect(canon({ e: undefined, a: 1 })).toBe('{"a":1}');
    expect(canon(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
    expect(canon('é "q"')).toBe('"é \\"q\\""');
    expect(canon('\ud800')).toBe('"\\ud800"'); // a lone surrogate keeps its own spelling
    expect(canon(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canon([])).toBe('[]');
    expect(canon({})).toBe('{}');
  });

  it('hash the tagged canonical form, signature included (golden)', () => {
    const rec = { r: 1, p: 'alice', s: '00'.repeat(32) };
    expect(recHash(rec)).toBe('91b2743926045f13d615b61be47a1bc3');
    expect(recHash({ s: '00'.repeat(32), p: 'alice', r: 1 })).toBe(recHash(rec)); // key order doesn't matter
    expect(revealKey(rec)).toBe('x:1:alice:91b2743926045f13d615b61be47a1bc3');
    const slip: SlipRec = { r: 2, p: 'bob', v: 3, b: [red(5), straight(17, 1)], c: 'ab'.repeat(32), k: 'K'.repeat(43), g: 'G'.repeat(86) };
    expect(canon(slip)).toBe(
      `{"b":[{"amount":5,"type":"red"},{"amount":1,"pick":17,"type":"straight"}],"c":"${'ab'.repeat(32)}","g":"${'G'.repeat(86)}","k":"${'K'.repeat(43)}","p":"bob","r":2,"v":3}`,
    );
    expect(recHash(slip)).toBe('2c61c62aa4e323b2e94c8ee01c9c5adb');
    expect(slipKey(slip)).toBe('s:2:bob:2c61c62aa4e323b2e94c8ee01c9c5adb');
    expect(recHash({ ...slip, g: 'H'.repeat(86) })).not.toBe(recHash(slip));
  });

  it('turn anything but strings, safe integers, arrays and plain objects into null', () => {
    class Box { a = 1; }
    const junk: unknown[] = [
      1.5, NaN, Infinity, 2 ** 53, true, null, undefined, 1n, Symbol('s'), () => 1,
      new Map(), new Date(0), new Uint8Array(2), new Box(),
      [1, undefined], [1, , 2], { a: null }, { a: [0.5] }, { a: { b: false } },
    ];
    for (const v of junk) {
      expect(canon(v), String(v)).toBeNull();
      expect(recHash(v)).toBeNull();
    }
  });

  it('parse keys from both ends: a pid may hold a colon, r and the hash may not', () => {
    const h = 'a'.repeat(32);
    expect(parseKey(`s:3:pl:ay:er:${h}`)).toEqual({ kind: 's', r: 3, pid: 'pl:ay:er', h });
    expect(parseKey(`c:12:${h}`)).toEqual({ kind: 'c', r: 12, h });
    for (const bad of [`c:0:${h}`, `c:01:${h}`, `c:1.5:${h}`, `c:1:x:${h}`, `s:1:${h}`, `s:1::${h}`, `c:1:${h}0`, `h:1:${h}`, `x:1:__proto__:${h}`, 'c:1', '']) {
      expect(parseKey(bad), bad).toBeNull();
    }
  });

  it('index a record only under the key computed from its body', () => {
    const s = kit.slip(A, 1, [red(10)]);
    const wrong = [
      `s:1:alice:${'0'.repeat(32)}`, // another hash
      `s:2:alice:${s.hash}`, // another round
      `s:1:bob:${s.hash}`, // another pid
      `x:1:alice:${s.hash}`, // another kind
      `${s.key} `,
    ];
    const session = new TestSession();
    for (const k of wrong) session.raw(k, s.rec);
    session.raw(s.key, { ...s.rec, v: 2 }); // the right key for a different body
    expect(fold(session).records).toBe(0);
    session.put(s);
    const res = fold(session);
    expect(res.records).toBe(1);
    expect(res.bytes).toBe(s.key.length + canon(s.rec)!.length);
  });
});

// ── Validators ───────────────────────────────────────────────────────────────

describe('what a record must look like', () => {
  const slip = kit.slip(A, 1, [red(10)]).rec;
  const close = kit.close(A, 1, SID, { alice: 'a'.repeat(32) }).rec;

  it('slips: integers only, exact fields, 0–400 exact bets, a real pid', () => {
    expect(asSlip(slip)).not.toBeNull();
    expect(asSlip({ ...slip, b: [] })).not.toBeNull(); // everything taken down
    expect(asSlip({ ...slip, b: Array.from({ length: MAX_SLIP_BETS }, () => red(1)) })).not.toBeNull();
    const bad: unknown[] = [
      { ...slip, r: 1.5 }, { ...slip, r: 0 }, { ...slip, v: 0 }, { ...slip, v: 2.5 },
      { ...slip, b: [{ type: 'red', amount: 2.5 }] },
      { ...slip, extra: 1 }, { ...slip, g: undefined },
      { ...slip, b: Array.from({ length: MAX_SLIP_BETS + 1 }, () => red(1)) },
      { ...slip, b: [{ type: 'red', amount: 5, pick: 3 }] }, // a stray pick
      { ...slip, b: [{ type: 'straight', amount: 5 }] }, // a missing one
      { ...slip, b: [{ type: 'red', amount: 5, note: 'x' }] },
      { ...slip, p: '__proto__' }, { ...slip, p: '' }, { ...slip, p: 'x'.repeat(257) },
      { ...slip, c: slip.c.toUpperCase() }, { ...slip, k: slip.k.slice(1) }, { ...slip, g: `${slip.g}=` },
      [slip], 'slip', null,
    ];
    for (const v of bad) expect(asSlip(v), JSON.stringify(v)?.slice(0, 80)).toBeNull();
    expect(asSlip({ ...slip, p: 'x'.repeat(256) })).not.toBeNull();
    expect(asSlip({ ...slip, extra: undefined })).not.toBeNull(); // canon skips it too
  });

  it('closes: 1–31 frozen 32-hex hashes under real pids', () => {
    expect(asClose(close)).not.toBeNull();
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 'b'.repeat(32)]));
    expect(asClose({ ...close, f: many(MAX_FROZEN) })).not.toBeNull();
    expect(asClose({ ...close, f: many(MAX_FROZEN + 1) })).toBeNull();
    expect(asClose({ ...close, f: {} })).toBeNull(); // an empty close
    expect(asClose({ ...close, f: { alice: 'B'.repeat(32) } })).toBeNull();
    expect(asClose({ ...close, f: JSON.parse(`{"__proto__":"${'b'.repeat(32)}"}`) })).toBeNull();
    expect(asClose({ ...close, q: 'nope' })).toBeNull();
    expect(asClose({ ...close, r: 1.0000001 })).toBeNull();
    expect(asClose({ ...close, by: 'alice' })).toBeNull();
  });

  it('reveals, forfeits, abandons and checkpoints: exact fields and ranges', () => {
    expect(asReveal({ r: 1, p: 'alice', s: '0'.repeat(64) })).not.toBeNull();
    expect(asReveal({ r: 1, p: 'alice', s: '0'.repeat(63) })).toBeNull();
    expect(asReveal({ r: 1, p: 'alice', s: '0'.repeat(64), k: A.pub })).toBeNull();
    const f = kit.forfeit(A, 1, 'a'.repeat(32), ['alice', 'bob']).rec;
    expect(asForfeit(f)).not.toBeNull();
    expect(asForfeit({ ...f, n: [] })).toBeNull(); // no round is decided on zero seeds
    expect(asForfeit({ ...f, n: ['bob', 'alice'] })).toBeNull();
    expect(asForfeit({ ...f, n: ['alice', 'alice'] })).toBeNull();
    expect(asForfeit({ ...f, n: Array.from({ length: MAX_FROZEN + 1 }, (_, i) => `p${String(i).padStart(2, '0')}`) })).toBeNull();
    const z = kit.abandon(D, 1, 'a'.repeat(32)).rec;
    expect(asAbandon(z)).not.toBeNull();
    expect(asAbandon({ ...z, x: 'a'.repeat(31) })).toBeNull();
    const cp = kit.checkpoint(A, 'g', 3, 'c'.repeat(32), { alice: 5n, bob: -7n });
    expect(asCheckpoint(cp)).not.toBeNull();
    expect(asCheckpoint({ ...cp, e: 1 })).not.toBeNull();
    expect(asCheckpoint({ ...cp, e: 2 })).toBeNull();
    expect(asCheckpoint({ ...cp, n: { alice: '0' } })).toBeNull();
    expect(asCheckpoint({ ...cp, n: { alice: '-0' } })).toBeNull();
    expect(asCheckpoint({ ...cp, n: { alice: '012' } })).toBeNull();
    expect(asCheckpoint({ ...cp, n: { alice: 12 } })).toBeNull();
    expect(asCheckpoint({ ...cp, v: 2 })).toBeNull();
    expect(asCheckpoint({ ...cp, b: 'a'.repeat(32) })).toBeNull();
  });

  it('a close without its signer\'s slip, or with only an empty one, is invalid', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const b = kit.slip(B, 1, [black(10)]);
    const cEmpty = kit.slip(C, 1, []);
    const byOutsider = kit.close(C, 1, SID, [a, b]);
    const byEmpty = kit.close(C, 1, SID, [a, cEmpty]);
    const res = fold(new TestSession().put(a, b, cEmpty, byOutsider, byEmpty));
    expect(res.tip).toBeNull();
    expect(res.openCloses.map((c) => c.state)).toEqual(['invalid', 'invalid']);
    expect(res.held).toEqual(new Map([['alice', 10n], ['bob', 10n]]));
  });

  it('a close whose signature fails is invalid, and so is one signed for its slip by another key', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const good = kit.close(A, 1, SID, [a]);
    const forged: CloseRec = { ...good.rec, f: { ...good.rec.f } };
    forged.g = kit.close(B, 1, SID, [a]).rec.g; // B's signature, A's key
    const session = new TestSession().put(a).raw(closeKey(forged)!, forged);
    expect(fold(session).openCloses.map((c) => c.state)).toEqual(['invalid']);
    session.put(good);
    expect(fold(session).tip?.close).toBe(good.hash);
  });

  it('a close whose signer\'s own slip fails verification is invalid', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const forged = kit.sign<SlipRec>('slip', B, { r: 1, p: 'carol', v: 1, b: [red(5)], c: kit.commit(1, 'carol', kit.seed('carol', 1)) });
    forged.k = C.pub; // carol's key, bob's signature
    const cs = { key: slipKey(forged)!, hash: recHash(forged)!, rec: forged };
    const byCarol = kit.close(C, 1, SID, [a, cs]);
    const res = fold(new TestSession().put(a, cs, byCarol, kit.reveal(1, 'alice')));
    expect(res.openCloses.map((c) => c.state)).toEqual(['invalid']);
    expect(res.rounds).toEqual([]);
  });

  it('a slip frozen under another pid is missing', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const b = kit.slip(B, 1, [black(5)]);
    const swapped = kit.close(A, 1, SID, { alice: a.hash, bob: a.hash, carol: b.hash });
    const v = fold(new TestSession().put(a, b, swapped, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'))).tip!;
    expect(v.present).toEqual(['alice']);
    expect(v.missing).toEqual(['bob', 'carol']);
  });

  it('pids like "constructor" and "hasOwnProperty" fold like any other', () => {
    const ids = [testIdentity('ctor', 'constructor'), testIdentity('own', 'hasOwnProperty'), testIdentity('tostr', 'toString')];
    const slips = ids.map((id) => kit.slip(id, 1, [red(10), straight(0, 1)]));
    const close = kit.close(ids[0], 1, SID, slips);
    const session = new TestSession().put(...slips, close, ...ids.map((id) => kit.reveal(1, id.pid)));
    const res = fold(session);
    expect(res.rounds[0].decided).toBe('reveals');
    const pocket = res.rounds[0].pocket!;
    for (const id of ids) {
      expect(res.rounds[0].deltas.get(id.pid)).toBe(deltaOf([red(10), straight(0, 1)], pocket));
    }
  });
});

// ── Deciding one close ───────────────────────────────────────────────────────

describe('deciding a close', () => {
  const betsA = [red(10), straight(7, 2)];
  const betsB = [black(20)];
  const a = kit.slip(A, 1, betsA);
  const b = kit.slip(B, 1, betsB);
  const close = kit.close(A, 1, SID, [a, b]);
  const ra = kit.reveal(1, 'alice');
  const rb = kit.reveal(1, 'bob');

  it('every reveal in: both seeds count and each felt is paid on the pocket', () => {
    const res = fold(new TestSession().put(a, b, close, ra, rb));
    const v = res.rounds[0];
    expect(v.decided).toBe('reveals');
    expect(v.counted).toEqual(['alice', 'bob']);
    expect(v.pocket).toBe(pocketOf(TEST_CTX, 1, [ra.rec.s, rb.rec.s]));
    expect(v.deltas.get('alice')).toBe(deltaOf(betsA, v.pocket!));
    expect(v.deltas.get('bob')).toBe(deltaOf(betsB, v.pocket!));
    expect(v.stakes.get('alice')).toBe(12n);
    expect(res.tip).toBeNull();
    expect(res.open).toBe(2);
    expect(res.parent).toBe(close.hash);
    expect(res.held.size).toBe(0);
    expect(res.revealedCommits).toEqual(new Set([a.rec.c, b.rec.c]));
  });

  it('a valid forfeit beats a full set of reveals', () => {
    const f = kit.forfeit(A, 1, close.hash, ['alice']);
    const v = fold(new TestSession().put(a, b, close, ra, rb, f)).rounds[0];
    expect(v.decided).toBe('forfeit');
    expect(v.forfeit?.hash).toBe(f.hash);
    expect(v.counted).toEqual(['alice']);
    expect(v.pocket).toBe(pocketOf(TEST_CTX, 1, [ra.rec.s]));
    expect(v.payouts.get('bob')).toBe(0n);
    expect(v.deltas.get('bob')).toBe(-20n);
  });

  it('the best-ranked valid forfeit wins, whatever the hashes say', () => {
    const [first, second] = inLine('forfeit', 1, A, B);
    // Whichever of first's forfeits hashes above second's: only the rank picks it.
    const f2 = kit.forfeit(second, 1, close.hash, ['alice', 'bob']);
    const f1 = [kit.forfeit(first, 1, close.hash, [first.pid]), kit.forfeit(first, 1, close.hash, ['alice', 'bob'])]
      .find((f) => f.hash > f2.hash)!;
    expect(f1).toBeDefined();
    expect(fold(new TestSession().put(a, b, close, ra, rb, f1, f2)).rounds[0].forfeit?.hash).toBe(f1.hash);
  });

  it('a forfeit whose writer is not in n, or names an unrevealed or unfrozen pid, is invalid', () => {
    const notSelf = kit.forfeit(B, 1, close.hash, ['alice']);
    const unrevealed = kit.forfeit(A, 1, close.hash, ['alice', 'bob']);
    const unfrozen = kit.forfeit(A, 1, close.hash, ['alice', 'carol']);
    const byOutsider = kit.forfeit(C, 1, close.hash, ['alice']);
    const wrongRound = kit.forfeit(A, 2, close.hash, ['alice']);
    const v = fold(new TestSession().put(a, b, close, ra, notSelf, unrevealed, unfrozen, byOutsider, wrongRound)).rounds[0];
    expect(v.decided).toBeNull();
    expect(v.revealed).toEqual(['alice']);
  });

  it('a slip nobody has is missing, never staked, and a forfeit still decides the round', () => {
    const ghost = kit.close(A, 1, SID, { alice: a.hash, bob: NOBODY });
    const f = kit.forfeit(A, 1, ghost.hash, ['alice']);
    const session = new TestSession().put(a, b, ghost, ra);
    let res = fold(session);
    expect(res.tip?.missing).toEqual(['bob']);
    expect(res.held).toEqual(new Map([['alice', 12n]])); // bob's own slip wasn't frozen
    res = fold(session.put(f));
    const v = res.rounds[0];
    expect(v.decided).toBe('forfeit');
    expect([...v.stakes.keys()]).toEqual(['alice']);
    expect(res.nets.has('bob')).toBe(false);
  });

  it('a close that freezes an empty slip counts that pid as missing', () => {
    const bEmpty = kit.slip(B, 1, [], { v: 2 });
    const c2 = kit.close(A, 1, SID, [a, bEmpty]);
    const v = fold(new TestSession().put(a, bEmpty, c2, ra)).tip!;
    expect(v.present).toEqual(['alice']);
    expect(v.missing).toEqual(['bob']);
    expect(v.decided).toBeNull(); // M isn't empty, so the reveals alone can't decide it
  });

  it('an abandon voids a round nobody can finish: every stake back, no pocket', () => {
    const z = kit.abandon(D, 1, close.hash);
    const res = fold(new TestSession().put(a, b, close, z));
    const v = res.rounds[0];
    expect(v.decided).toBe('void');
    expect(v.abandon?.hash).toBe(z.hash);
    expect(v.pocket).toBeNull();
    expect(v.stakes.get('bob')).toBe(20n);
    expect(v.payouts.get('bob')).toBe(0n);
    expect(v.deltas.get('bob')).toBe(0n);
    expect(res.nets.size).toBe(0);
    expect(res.held.size).toBe(0);
    expect(res.open).toBe(2); // the table moves on
  });

  it('a void round pays nobody: nobody is counted, every payout is 0 and only the delta is forced to 0', () => {
    // Review regression: a void used to report each stake as its payout, so
    // anything reading payouts as chips returned saw a void that paid out.
    // Spec decide step 5: payout = counted ? resolveRound(...) : 0n; delta =
    // payout − stake, or 0 if the round is void.
    const z = kit.abandon(D, 1, close.hash);
    const v = fold(new TestSession().put(a, b, close, z)).rounds[0];
    expect(v.decided).toBe('void');
    expect(v.counted).toEqual([]);
    expect([...v.payouts]).toEqual([['alice', 0n], ['bob', 0n]]);
    expect([...v.deltas]).toEqual([['alice', 0n], ['bob', 0n]]);
  });

  it('an abandon loses to a valid forfeit that arrives after it, and to a full set of reveals', () => {
    const z = kit.abandon(D, 1, close.hash);
    const session = new TestSession().put(a, b, close, z, ra);
    expect(fold(session).rounds[0].decided).toBe('void');
    session.put(kit.forfeit(A, 1, close.hash, ['alice']));
    expect(fold(session).rounds[0].decided).toBe('forfeit');
    const full = new TestSession().put(a, b, close, z, ra, rb);
    expect(fold(full).rounds[0].decided).toBe('reveals');
  });

  it('an abandon for another round or another close does nothing', () => {
    const res = fold(new TestSession().put(a, b, close, kit.abandon(D, 2, close.hash), kit.abandon(D, 1, NOBODY)));
    expect(res.tip?.decided).toBeNull();
  });

  it('a junk reveal beside the real one does not erase it', () => {
    const junk = kit.reveal(1, 'alice', kit.seed('alice', 1, 'junk'));
    expect(junk.key).not.toBe(ra.key);
    const v = fold(new TestSession().put(a, b, close, junk, ra, rb)).rounds[0];
    expect(v.decided).toBe('reveals');
    expect(v.pocket).toBe(pocketOf(TEST_CTX, 1, [ra.rec.s, rb.rec.s]));
  });

  it('a reveal for another round or pid never opens a slip, even with a copied commitment', () => {
    // carol copies alice's commitment into her own slip: alice's seed is
    // public once revealed, but it opens only alice's (round, pid).
    const copy = kit.sign<SlipRec>('slip', C, { r: 1, p: 'carol', v: 1, b: [red(5)], c: a.rec.c });
    const cs = { key: slipKey(copy)!, hash: recHash(copy)!, rec: copy };
    const cc = kit.close(C, 1, SID, [cs]);
    const res = fold(new TestSession().put(a, cs, cc, ra, kit.reveal(1, 'carol', ra.rec.s), kit.reveal(2, 'alice')));
    expect(res.tip?.revealed).toEqual([]);
    expect(res.revealedCommits).toEqual(new Set([a.rec.c])); // burned for both slips
  });
});

// ── What the felt holds ──────────────────────────────────────────────────────

describe('held stakes', () => {
  const a1 = kit.slip(A, 1, [red(10)]);
  const a2 = kit.slip(A, 1, [red(10), red(15)], { v: 2 });
  const b1 = kit.slip(B, 1, [black(7)]);

  it('while betting: each player\'s latest verified version', () => {
    const forged = kit.sign<SlipRec>('slip', C, { r: 1, p: 'alice', v: 9, b: [red(999)], c: a1.rec.c });
    forged.k = A.pub; // claims alice's key; the signature is carol's
    const res = fold(new TestSession().put(a1, a2, b1).raw(slipKey(forged)!, forged));
    expect(res.felts.get('alice')?.hash).toBe(a2.hash);
    expect(res.held).toEqual(new Map([['alice', 25n], ['bob', 7n]]));
  });

  it('equal versions: the higher hash is the felt', () => {
    const twin = kit.slip(A, 1, [black(3)], { v: 2 });
    const top = twin.hash > a2.hash ? twin : a2;
    expect(fold(new TestSession().put(a2, twin)).felts.get('alice')?.hash).toBe(top.hash);
  });

  it('an empty version is a felt that holds nothing', () => {
    const down = kit.slip(A, 1, [], { v: 3 });
    const res = fold(new TestSession().put(a1, a2, down, b1));
    expect(res.felts.get('alice')?.hash).toBe(down.hash);
    expect(res.held).toEqual(new Map([['bob', 7n]]));
  });

  it('while a close is undecided: what it froze, and nothing for a version or player it left out', () => {
    const close = kit.close(A, 1, SID, [a1]); // the older version, and no bob
    const res = fold(new TestSession().put(a1, a2, b1, close));
    expect(res.tip?.close).toBe(close.hash);
    expect(res.held).toEqual(new Map([['alice', 10n]]));
    expect(res.felts.get('alice')?.hash).toBe(a2.hash); // still the latest, for display
  });

  it('once decided: the next round\'s felts', () => {
    const close = kit.close(A, 1, SID, [a1]);
    const next = kit.slip(B, 2, [black(4)]);
    const res = fold(new TestSession().put(a1, b1, close, kit.reveal(1, 'alice'), next));
    expect(res.open).toBe(2);
    expect(res.held).toEqual(new Map([['bob', 4n]]));
  });
});

// ── Pinned keys ──────────────────────────────────────────────────────────────

describe('felts pinned to each player\'s key (keyOf)', () => {
  const a1 = kit.slip(A, 1, [red(10)]);
  const b1 = kit.slip(B, 1, [black(7)]);
  // Carol signs a version of alice's felt with her own key: a valid signature,
  // a higher v, and far more on it.
  const forged = kit.slip(C, 1, [red(999)], { p: 'alice', v: 9 });
  const pins = new Map([['alice', A.pub], ['bob', B.pub], ['carol', C.pub]]);
  const pinned = (session: TestSession, keys: Map<string, string> = pins): TableFold => {
    const f = new TableFold(TEST_CTX, sigs.check, (pid) => keys.get(pid));
    f.setBase(null);
    f.reset(session.records.entries());
    return f;
  };

  it('without keyOf, a version under another key holds that player\'s felt', () => {
    const res = fold(new TestSession().put(a1, forged, b1));
    expect(res.felts.get('alice')?.hash).toBe(forged.hash);
    expect(res.held.get('alice')).toBe(999n);
  });

  it('with keyOf, only versions signed by the pinned key are the felt', () => {
    const res = pinned(new TestSession().put(a1, forged, b1)).result();
    expect(res.felts.get('alice')?.hash).toBe(a1.hash);
    expect(res.held).toEqual(new Map([['alice', 10n], ['bob', 7n]]));
  });

  it('a version under the wrong key is never verified', () => {
    const chk = cachingCheck();
    const f = new TableFold(TEST_CTX, chk.check, (pid) => pins.get(pid));
    f.reset(new TestSession().put(a1, forged).records.entries());
    f.result();
    expect(chk.cache.has(forged.hash)).toBe(false);
    expect(chk.cache.get(a1.hash)).toBe(true);
  });

  it('a player whose key is unknown has no felt and holds nothing, until keysChanged reads it again', () => {
    const keys = new Map([['bob', B.pub]]);
    const f = pinned(new TestSession().put(a1, b1), keys);
    let res = f.result();
    expect(res.felts.has('alice')).toBe(false);
    expect(res.held).toEqual(new Map([['bob', 7n]]));
    keys.set('alice', A.pub);
    expect(f.result()).toBe(res); // cached: keyOf is read again only when told
    f.keysChanged();
    res = f.result();
    expect(res.felts.get('alice')?.hash).toBe(a1.hash);
    expect(res.held).toEqual(new Map([['alice', 10n], ['bob', 7n]]));
  });

  it('a close still freezes what its signer pinned, and decisions and nets don\'t read keyOf', () => {
    const close = kit.close(C, 1, SID, [forged, kit.slip(C, 1, [red(1)])]);
    const session = new TestSession().put(a1, forged, b1, close, kit.slip(C, 1, [red(1)]));
    const res = pinned(session).result();
    expect(res.tip?.close).toBe(close.hash);
    expect(res.held).toEqual(new Map([['alice', 999n], ['carol', 1n]]));
    session.put(kit.reveal(1, 'alice'), kit.reveal(1, 'carol'));
    const decided = pinned(session).result();
    expect(snapshot(decided)).toBe(snapshot(fold(session)));
    expect(decided.rounds[0].decided).toBe('reveals');
    expect(decided.nets.has('alice')).toBe(true);
  });

  it('pins only the felt on the open round: an empty version under the pinned key takes it down', () => {
    const down = kit.slip(A, 1, [], { v: 2 });
    const res = pinned(new TestSession().put(a1, down, forged)).result();
    expect(res.felts.get('alice')?.hash).toBe(down.hash);
    expect(res.held.has('alice')).toBe(false);
  });
});

// ── The checkpoint ───────────────────────────────────────────────────────────

describe('a session after a checkpoint', () => {
  const cp = kit.checkpoint(A, 'g', 3, 'c'.repeat(32), { alice: 100n, bob: -40n });
  const sid = nextSid(TEST_CTX, cp);

  it('opens the session nextSid names, the same whoever signed the checkpoint', () => {
    expect(sid).toMatch(/^[0-9a-f]{24}$/);
    expect(nextSid(TEST_CTX, kit.checkpoint(B, 'g', 3, 'c'.repeat(32), { alice: 100n, bob: -40n }))).toBe(sid);
    expect(nextSid(TEST_CTX, kit.checkpoint(A, 'g', 3, 'c'.repeat(32), { alice: 101n, bob: -40n }))).not.toBe(sid);
    expect(nextSid({ ...TEST_CTX, inc: 'c'.padEnd(25, '9') }, cp)).not.toBe(sid);
    expect(nextSid(TEST_CTX, { ...cp, e: 1 })).not.toBe(sid);
    expect(nextSid(TEST_CTX, null)).toBe('g');
  });

  it('numbers rounds from u + 1 under the new sid and adds their deltas to the checkpoint nets', () => {
    const bets = [red(50)];
    const s4 = kit.slip(A, 4, bets);
    const c4 = kit.close(A, 4, sid, [s4]);
    const stale = kit.close(A, 4, 'g', [s4]);
    const early = kit.slip(A, 3, bets);
    const session = new TestSession().put(s4, stale, early, kit.close(A, 3, sid, [early]), kit.reveal(3, 'alice'));
    let res = fold(session, cp);
    expect(res.base).toMatchObject({ sid, u: 3, l: 'c'.repeat(32), ended: false });
    expect(res.open).toBe(4);
    expect(res.parent).toBe(sid);
    expect(res.openCloses.map((c) => [c.hash, c.state])).toEqual([]);
    expect(res.nets).toEqual(new Map([['alice', 100n], ['bob', -40n]]));
    res = fold(session.put(c4, kit.reveal(4, 'alice')), cp);
    expect(res.rounds.map((v) => v.close)).toEqual([c4.hash]);
    expect(res.open).toBe(5);
    expect(res.nets.get('alice')).toBe(100n + deltaOf(bets, res.rounds[0].pocket!));
    expect(res.nets.get('bob')).toBe(-40n);
  });

  it('a new sid clears the index; the same sid keeps it', () => {
    const s4 = kit.slip(A, 4, [red(1)]);
    const f = new TableFold(TEST_CTX, sigs.check);
    f.setBase(cp);
    f.apply([[s4.key, s4.rec]]);
    expect(f.result().records).toBe(1);
    const before = f.result();
    f.setBase(kit.checkpoint(B, 'g', 3, 'c'.repeat(32), { alice: 100n, bob: -40n })); // same content, another signer
    expect(f.result()).toBe(before);
    const cp2 = kit.checkpoint(A, sid, 9, 'd'.repeat(32), { alice: 1n });
    f.setBase(cp2);
    const res = f.result();
    expect(res.records).toBe(0);
    expect(res.base.sid).toBe(nextSid(TEST_CTX, cp2));
    expect(res.open).toBe(10);
  });

  it('marks an ended incarnation, and treats a junk checkpoint as none', () => {
    const f = new TableFold(TEST_CTX, sigs.check);
    f.setBase({ ...cp, e: 1 });
    expect(f.result().base.ended).toBe(true);
    f.setBase({ ...cp, n: { alice: '1.5' } });
    expect(f.result().base).toMatchObject({ sid: 'g', u: 0, ended: false });
  });

  it('counts nothing of a session after a checkpoint saying the incarnation ended: its nets only', () => {
    const end = kit.checkpoint(A, 'g', 3, 'c'.repeat(32), { alice: 100n, bob: -40n }, 1);
    const esid = nextSid(TEST_CTX, end);
    // A whole round, decided, and an open felt, under the sid the end names.
    const bets = [red(50)];
    const s4 = kit.slip(A, 4, bets);
    const b5 = kit.slip(B, 5, [black(30)]);
    const session = new TestSession().put(s4, kit.close(A, 4, esid, [s4]), kit.reveal(4, 'alice'), b5);
    const res = fold(session, end);
    expect(res.base).toMatchObject({ sid: esid, u: 3, ended: true });
    expect(res.rounds).toEqual([]);
    expect(res.tip).toBeNull();
    expect(res.openCloses).toEqual([]);
    expect(res.felts.size).toBe(0);
    expect(res.held.size).toBe(0);
    expect(res.revealedCommits.size).toBe(0);
    expect(res.pending).toBe(false);
    expect(res.nets).toEqual(new Map([['alice', 100n], ['bob', -40n]]));
    // It still weighs what the doc holds.
    expect(res.records).toBe(4);
    expect(res.rawBytes).toBeGreaterThan(0);
    // The same records under an end that isn't one count as a round.
    const notEnded = kit.checkpoint(A, 'g', 3, 'c'.repeat(32), { alice: 100n, bob: -40n });
    const sid = nextSid(TEST_CTX, notEnded);
    const counted = fold(new TestSession().put(s4, kit.close(A, 4, sid, [s4]), kit.reveal(4, 'alice'), b5), notEnded);
    expect(counted.rounds).toHaveLength(1);
    expect(counted.nets.get('alice')).toBe(100n + deltaOf(bets, counted.rounds[0].pocket!));
    // An incremental fold ending on the same records reads the same.
    const f = new TableFold(TEST_CTX, sigs.check);
    f.setBase(end);
    f.apply(session.records.entries());
    expect(snapshot(f.result())).toBe(snapshot(res));
  });

  it('keeps bigint nets exact past 2^53', () => {
    const big = kit.checkpoint(A, 'g', 1, 'c'.repeat(32), { alice: 2n ** 53n + 1n, bob: -(10n ** 30n) });
    const bsid = nextSid(TEST_CTX, big);
    const bets = [red(10), black(3)];
    const s = kit.slip(A, 2, bets);
    const res = fold(new TestSession().put(s, kit.close(A, 2, bsid, [s]), kit.reveal(2, 'alice')), big);
    expect(res.nets.get('alice')).toBe(2n ** 53n + 1n + deltaOf(bets, res.rounds[0].pocket!));
    expect(res.nets.get('bob')).toBe(-(10n ** 30n));
  });
});

// ── Pending verdicts ─────────────────────────────────────────────────────────

describe('verdicts not checked yet', () => {
  const a = kit.slip(A, 1, [red(10)]);
  const b = kit.slip(B, 1, [black(5)]);
  const close = kit.close(A, 1, SID, [a, b]);
  const reveals = [kit.reveal(1, 'alice'), kit.reveal(1, 'bob')];

  it('a pending close counts as not arrived; once checked, it decides', () => {
    const chk = cachingCheck([close.hash]);
    const f = new TestSession().put(a, b, close, ...reveals).fold(chk.check);
    let res = f.result();
    expect(res.pending).toBe(true);
    expect(res.rounds).toEqual([]);
    expect(res.openCloses.map((c) => c.state)).toEqual(['pending']);
    expect(res.held).toEqual(new Map([['alice', 10n], ['bob', 5n]]));
    chk.hold.clear();
    res = f.result(); // no apply: a pending result is always recomputed
    expect(res.pending).toBe(false);
    expect(res.rounds[0].decided).toBe('reveals');
  });

  it('a pending frozen slip makes its close pending', () => {
    const chk = cachingCheck([b.hash]);
    const f = new TestSession().put(a, b, close, ...reveals).fold(chk.check);
    expect(f.result().openCloses.map((c) => c.state)).toEqual(['pending']);
    expect(f.result().felts.has('bob')).toBe(false);
    chk.hold.clear();
    expect(f.result().rounds[0].decided).toBe('reveals');
  });

  it('a pending forfeit is skipped until checked, then it decides', () => {
    const fa = kit.forfeit(A, 1, close.hash, ['alice']);
    const chk = cachingCheck([fa.hash]);
    const f = new TestSession().put(a, b, close, ...reveals, fa).fold(chk.check);
    let res = f.result();
    expect(res.pending).toBe(true);
    expect(res.rounds[0].decided).toBe('reveals');
    chk.hold.clear();
    res = f.result();
    expect(res.pending).toBe(false);
    expect(res.rounds[0].decided).toBe('forfeit');
  });

  it('a settled result is cached; a change recomputes it; the same bytes again change nothing', () => {
    const f = new TestSession().put(a, b, close).fold(sigs.check);
    const first = f.result();
    expect(f.result()).toBe(first);
    f.apply([[close.key, { ...close.rec, f: { ...close.rec.f } }]]); // a re-put: a fresh copy of the same record
    f.apply([[`c:1:${NOBODY}`, undefined]]); // deleting a key that holds nothing
    expect(f.result()).toBe(first);
    f.apply([[reveals[0].key, reveals[0].rec]]);
    expect(f.result()).not.toBe(first);
  });
});

// ── The pocket ───────────────────────────────────────────────────────────────

describe('the pocket', () => {
  it('equals the async combinePocketSeeds (and the commitment commitTableSeed) on 2,000 inputs', async () => {
    const rand = rng(2_000);
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const ctx = { room: i % 3 ? 'room-x' : '', t: `table-${i % 7}`, inc: `c${(i % 5).toString().repeat(24)}` };
      const seeds = Array.from({ length: 1 + (i % 6) }, (_, j) => kit.seed(`p${j}`, i, String(rand())));
      const r = 1 + Math.floor(rand() * 1_000);
      const pocket = pocketOf(ctx, r, seeds);
      expect(pocket).toBe(await combinePocketSeeds(seeds, seedTable(ctx), r));
      seen.add(pocket);
      if (i % 20 === 0) {
        expect(slipCommit(ctx, r, `p${i}`, seeds[0]))
          .toBe(await commitTableSeed(seeds[0], { room: ctx.room, table: seedTable(ctx), round: r, party: `p${i}`, house: '' }));
      }
    }
    expect(seen.size).toBe(37);
  });

  it('ignores seed order', () => {
    const s = ['1', '2', '3'].map((x) => kit.seed(x, 1));
    expect(pocketOf(TEST_CTX, 4, s)).toBe(pocketOf(TEST_CTX, 4, [...s].reverse()));
  });
});

// ── The chain ────────────────────────────────────────────────────────────────

describe('choosing the chain', () => {
  const a1 = kit.slip(A, 1, [red(10)]);
  const b1 = kit.slip(B, 1, [black(10)]);
  const ra1 = kit.reveal(1, 'alice');
  const rb1 = kit.reveal(1, 'bob');

  it('a decided close beats an undecided one, whatever their ranks', () => {
    const onlyA = kit.close(A, 1, SID, [a1]);
    const both = kit.close(B, 1, SID, [a1, b1]);
    const res = fold(new TestSession().put(a1, b1, both, onlyA, ra1));
    expect(res.rounds[0].close).toBe(onlyA.hash);
    expect(res.rounds[0].decided).toBe('reveals');
    expect(res.held).toEqual(new Map()); // bob's version was left out of the chosen close
  });

  it('ties go to the lower closeRank, then to the lower hash', () => {
    // Two solo closers whose rank order and hash order disagree, so only the
    // rank can pick the winner.
    const pick = (): [Built<CloseRec>, Built<CloseRec>, Built<unknown>[]] => {
      for (let i = 0; ; i++) {
        const [x, y] = inLine('close', 1, testIdentity(`tie-x${i}`), testIdentity(`tie-y${i}`));
        const sx = kit.slip(x, 1, [red(1)]);
        const sy = kit.slip(y, 1, [red(1)]);
        const cx = kit.close(x, 1, SID, [sx]);
        const cy = kit.close(y, 1, SID, [sy]);
        if (cx.hash > cy.hash) return [cx, cy, [sx, sy, kit.reveal(1, x.pid), kit.reveal(1, y.pid)]];
      }
    };
    const [cFirst, cSecond, rest] = pick();
    expect(fold(new TestSession().put(...rest, cSecond, cFirst)).rounds[0].close).toBe(cFirst.hash);
    // One closer, two closes: same rank, so the hash decides.
    const x = kit.close(A, 1, SID, [a1]);
    const y = kit.close(A, 1, SID, [a1, b1]);
    const low = x.hash < y.hash ? x : y;
    expect(fold(new TestSession().put(a1, b1, x, y, ra1, rb1)).rounds[0].close).toBe(low.hash);
    // Undecided rivals tie at 0: the tip is the first in line.
    expect(fold(new TestSession().put(rest[0], rest[1], cSecond, cFirst)).tip?.close).toBe(cFirst.hash);
  });

  it('a deeper decided chain wins, even when it flips an earlier round\'s choice', () => {
    const [first, second] = inLine('close', 1, A, B);
    const s1 = (id: typeof A) => (id === A ? a1 : b1);
    const cFirst = kit.close(first, 1, SID, [s1(first)]);
    const cSecond = kit.close(second, 1, SID, [s1(second)]);
    const session = new TestSession().put(a1, b1, cFirst, cSecond, ra1, rb1);
    let res = fold(session);
    expect(res.rounds.map((v) => v.close)).toEqual([cFirst.hash]);
    expect(res.open).toBe(2);
    expect(res.parent).toBe(cFirst.hash);
    // Round 2 lands under the round-1 close that lost the tie.
    const s2 = kit.slip(second, 2, [red(3)]);
    const c2 = kit.close(second, 2, cSecond.hash, [s2]);
    session.put(s2, c2);
    expect(fold(session).rounds.map((v) => v.close)).toEqual([cFirst.hash]); // undecided: no flip yet
    session.put(kit.reveal(2, second.pid));
    res = fold(session);
    expect(res.rounds.map((v) => v.close)).toEqual([cSecond.hash, c2.hash]);
    expect(res.nets.has(first.pid)).toBe(false); // first's round-1 bet is now unstaked
  });

  it('a close for round 2 under an undecided or unknown parent is not eligible', () => {
    const c1 = kit.close(A, 1, SID, [a1, b1]);
    const a2 = kit.slip(A, 2, [red(1)]);
    const res = fold(new TestSession().put(a1, b1, c1, ra1, a2, kit.close(A, 2, c1.hash, [a2]), kit.close(A, 2, NOBODY, [a2])));
    expect(res.tip?.close).toBe(c1.hash);
    expect(res.rounds).toHaveLength(1);
  });

  it('walks 500 rounds without recursion, quickly, and stops at the session cap', () => {
    const P = fakeIdentity('solo');
    const session = new TestSession();
    let q = 'g';
    for (let r = 1; r <= MAX_SESSION_ROUNDS + 1; r++) {
      const s = kit.slip(P, r, [red(1 + (r % 5)), straight(r % 37, 1)]);
      const c = kit.close(P, r, q, [s]);
      session.put(s, c, kit.reveal(r, P.pid));
      q = c.hash;
    }
    const t0 = performance.now();
    const f = session.fold(trustAll);
    const res = f.result();
    const ms = performance.now() - t0;
    expect(res.rounds).toHaveLength(MAX_SESSION_ROUNDS);
    expect(res.rounds.every((v) => v.decided === 'reveals')).toBe(true);
    expect(res.open).toBe(MAX_SESSION_ROUNDS + 1);
    expect(res.openCloses.map((c) => c.state)).toEqual(['invalid']); // round 501 is past the cap
    expect(ms).toBeLessThan(1_000);
    // A warm pass after one change re-walks from the memos.
    const extra = kit.slip(P, MAX_SESSION_ROUNDS + 1, [red(2)], { v: 2 });
    const t1 = performance.now();
    f.apply([[extra.key, extra.rec]]);
    f.result();
    expect(performance.now() - t1).toBeLessThan(100);
  });
});

// ── Caps ─────────────────────────────────────────────────────────────────────

describe('the caps on what the fold considers', () => {
  it('closes that could never be valid don\'t crowd a real one out of the cap', () => {
    // The real closer ranks last of 60; the 59 better-ranked closes have no
    // slip of their own signer's in them.
    const cands = Array.from({ length: 60 }, (_, i) => fakeIdentity(`crowd${i}`));
    const [real, ...rest] = [...cands].sort((x, y) => (dutyRank('close', TEST_CTX, 1, x.pub) > dutyRank('close', TEST_CTX, 1, y.pub) ? -1 : 1));
    const s = kit.slip(real, 1, [red(5)]);
    const session = new TestSession().put(s, kit.close(real, 1, SID, [s]), kit.reveal(1, real.pid));
    for (const id of rest) session.put(kit.close(id, 1, SID, [s]));
    const res = session.fold(trustAll).result();
    expect(res.rounds[0]?.decided).toBe('reveals');
    expect(res.rounds[0].closeRec.k).toBe(real.pub);
  });

  it('closes naming a parent that isn\'t an eligible decided close don\'t crowd the cap', () => {
    const solo = fakeIdentity('crowd-solo');
    const s1 = kit.slip(solo, 1, [red(1)]);
    const c1 = kit.close(solo, 1, SID, [s1]);
    const rival = kit.close(fakeIdentity('crowd-rival'), 1, SID, [s1]); // eligible? no slip of its own: never
    const session = new TestSession().put(s1, c1, rival, kit.reveal(1, solo.pid));
    // 40 better-ranked round-2 closes, each with its own slip, naming a
    // parent that isn't eligible and decided; then the real one.
    const ids = Array.from({ length: 80 }, (_, i) => fakeIdentity(`crowd2-${i}`))
      .sort((x, y) => (dutyRank('close', TEST_CTX, 2, x.pub) < dutyRank('close', TEST_CTX, 2, y.pub) ? -1 : 1));
    const real = ids[79];
    const s2 = kit.slip(real, 2, [red(1)]);
    const c2 = kit.close(real, 2, c1.hash, [s2]);
    session.put(s2, c2, kit.reveal(2, real.pid));
    ids.slice(0, 40).forEach((id, i) => {
      const s = kit.slip(id, 2, [red(1)]);
      session.put(s, kit.close(id, 2, i % 2 ? NOBODY : rival.hash, [s]), kit.reveal(2, id.pid));
    });
    const res = session.fold(trustAll).result();
    expect(res.rounds.map((v) => v.close)).toEqual([c1.hash, c2.hash]);
  });

  it('only the 32 best-ranked closes of a round are considered', () => {
    const ids = Array.from({ length: 33 }, (_, i) => fakeIdentity(`cap${i}`))
      .sort((x, y) => (dutyRank('close', TEST_CTX, 1, x.pub) < dutyRank('close', TEST_CTX, 1, y.pub) ? -1 : 1));
    const session = new TestSession();
    const closes = ids.map((id) => {
      const s = kit.slip(id, 1, [red(1)]);
      const c = kit.close(id, 1, SID, [s]);
      session.put(s, c);
      return c;
    });
    // Only the last in line could be decided — but it is past the cap.
    session.put(kit.reveal(1, ids[32].pid));
    const res = session.fold(trustAll).result();
    expect(res.tip?.close).toBe(closes[0].hash);
    expect(res.openCloses.map((c) => c.state)).toEqual([...Array(32).fill('valid'), 'invalid']);
    session.del(closes[0].key);
    expect(session.fold(trustAll).result().rounds[0].close).toBe(closes[32].hash);
  });

  it('forfeits that fail verification take no place in the cap; 32 not checked yet hold it until they are', () => {
    const others = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((n) => testIdentity(n));
    const slips = [A, ...others].map((id) => kit.slip(id, 1, [red(1)]));
    const close = kit.close(A, 1, SID, slips);
    const reveals = [A, ...others].map((id) => kit.reveal(1, id.pid));
    // Every set of seeds that counts alice: 64 forfeits, all by alice (one rank).
    const sets = Array.from({ length: 64 }, (_, m) => ['alice', ...others.filter((_, i) => m & (1 << i)).map((id) => id.pid)]);
    const good = sets.map((n) => kit.forfeit(A, 1, close.hash, n)).sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const best = good[63]; // last by hash: every bad forfeit below it goes first
    const bad = sets.filter((n) => n.join() !== best.rec.n.join()).map((n) => {
      const f = kit.forfeit(B, 1, close.hash, n);
      const rec = { ...f.rec, k: A.pub }; // bob's signature under alice's key
      return { key: `f:1:${recHash(rec)}`, hash: recHash(rec)!, rec };
    });
    const before = bad.filter((f) => f.hash < best.hash);
    expect(before.length).toBeGreaterThan(32);
    const session = new TestSession().put(...slips, close, ...reveals, best, ...before.slice(0, 32));
    // Once checked, the 32 bad ones are out of the running: alice's forfeit decides.
    expect(fold(session).rounds[0].forfeit?.hash).toBe(best.hash);
    // While they wait for their verdicts they might still be valid, so they
    // hold the cap and the best one isn't considered yet.
    const chk = cachingCheck(before.slice(0, 32).map((f) => f.hash));
    const f = session.fold(chk.check);
    let res = f.result();
    expect(res.pending).toBe(true);
    expect(res.rounds[0].decided).toBe('reveals');
    chk.hold.delete(before[0].hash); // one is checked (and fails): a place frees up
    res = f.result();
    expect(res.pending).toBe(true);
    expect(res.rounds[0].forfeit?.hash).toBe(best.hash);
    chk.hold.clear();
    res = f.result();
    expect(res.pending).toBe(false);
    expect(res.rounds[0].forfeit?.hash).toBe(best.hash);
  });
});

// ── Caps against junk that can never verify ──────────────────────────────────
//
// Review regressions: the caps used to be filled by claimed rank BEFORE any
// signature was checked, so records nobody signed (a made-up pub, or a real
// record's copy with garbage in `g`) could push the one valid close, forfeit
// or abandon out of the cap: a round stalled for good, decided rounds were
// erased, or a withholding bettor got its stake back. Now a record whose
// verdict is false takes no place in a cap; it costs one cached check.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A 43-char string that matches the pub shape but is no key anyone holds. */
const fakePub = (i: number): string => `J${i.toString(36).padStart(10, '0')}`.padEnd(43, 'A');
/** A garbage 86-char "signature": the right alphabet, never verifies. */
const junkSig = (i: number): string => {
  let s = '';
  let x = i + 1;
  for (let j = 0; j < 86; j++) { s += B64[x % 64]; x = Math.floor(x / 64) || (j + 7); }
  return s;
};
/** A made-up pub whose dutyRank goes before `than`'s. */
function pubRankedBefore(duty: 'close' | 'abandon', r: number, than: string): string {
  for (let i = 0; ; i++) {
    const p = fakePub(i);
    if (dutyRank(duty, TEST_CTX, r, p) < dutyRank(duty, TEST_CTX, r, than)) return p;
  }
}

describe('the close cap and closes that can never verify', () => {
  /** One junk slip under a made-up pub ranked first for round 1, and 32
   *  junk closes freezing it: 33 records, not one real signature. */
  function closeJunk(session: TestSession, than: string, tag: number): void {
    const J = pubRankedBefore('close', 1, than);
    const junkSlip: SlipRec = { r: 1, p: 'junk', v: 1, b: [red(1)], c: 'ab'.repeat(32), k: J, g: junkSig(tag) };
    session.raw(slipKey(junkSlip)!, junkSlip);
    for (let i = 0; i < 32; i++) {
      const c: CloseRec = { r: 1, q: SID, f: { junk: recHash(junkSlip)! }, k: J, g: junkSig(tag + 1 + i) };
      session.raw(closeKey(c)!, c);
    }
  }

  it('32 unsigned junk closes don\'t stall an honest, fully revealed round', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const b = kit.slip(B, 1, [black(10)]);
    const honest = kit.close(A, 1, SID, [a, b]);
    const session = new TestSession().put(a, b, honest, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    expect(fold(session).rounds[0]?.decided).toBe('reveals');
    closeJunk(session, inLine('close', 1, A, B)[0].pub, 0);
    const res = fold(session);
    expect(res.rounds[0]?.close).toBe(honest.hash);
    expect(res.rounds[0]?.decided).toBe('reveals');
    expect(res.openCloses).toEqual([]); // round 2 is open, and nothing names it
  });

  it('the same 33 records, added later, erase no decided round and move no chip', () => {
    const session = new TestSession();
    let q = SID;
    for (let r = 1; r <= 3; r++) {
      const a = kit.slip(A, r, [red(10)]);
      const b = kit.slip(B, r, [black(10)]);
      const c = kit.close(A, r, q, [a, b]);
      session.put(a, b, c, kit.reveal(r, 'alice'), kit.reveal(r, 'bob'));
      q = c.hash;
    }
    const before = fold(session);
    expect(before.rounds.map((v) => v.decided)).toEqual(['reveals', 'reveals', 'reveals']);
    closeJunk(session, A.pub, 500);
    const after = fold(session);
    expect(after.rounds.map((v) => v.close)).toEqual(before.rounds.map((v) => v.close));
    expect([...after.nets]).toEqual([...before.nets]);
  });

  it('32 copies of the honest close with garbage signatures don\'t crowd it out', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const b = kit.slip(B, 1, [black(10)]);
    const honest = kit.close(A, 1, SID, [a, b]);
    const session = new TestSession().put(a, b, honest, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    for (let i = 0, n = 0; n < 32; i++) {
      const c: CloseRec = { ...honest.rec, f: { ...honest.rec.f }, g: junkSig(900 + i) };
      if (recHash(c)! < honest.hash) { session.raw(closeKey(c)!, c); n++; }
    }
    const res = fold(session);
    expect(res.rounds[0]?.close).toBe(honest.hash);
    expect(res.rounds[0]?.decided).toBe('reveals');
  });
});

describe('the abandon cap and abandons that can never verify', () => {
  const junkAbandons = (session: TestSession, x: string, tag: number): void => {
    const J = pubRankedBefore('abandon', 1, C.pub);
    for (let i = 0; i < 32; i++) {
      const z: AbandonRec = { r: 1, x, k: J, g: junkSig(tag + i) };
      session.raw(abandonKey(z)!, z);
    }
  };

  it('32 unsigned junk abandons don\'t keep a round whose only bettor vanished from being voided', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const close = kit.close(A, 1, SID, [a]); // alice then vanished: no reveal
    const session = new TestSession().put(a, close, kit.abandon(C, 1, close.hash)); // a seated page gives up on it
    expect(fold(session).rounds[0]?.decided).toBe('void');
    junkAbandons(session, close.hash, 100);
    const res = fold(session);
    expect(res.rounds[0]?.decided).toBe('void');
    expect(res.open).toBe(2);
  });

  it('junk abandons added later don\'t un-void a round or erase the rounds played on top of it', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const c1 = kit.close(A, 1, SID, [a]); // alice vanished
    const session = new TestSession().put(a, c1, kit.abandon(C, 1, c1.hash));
    let q = c1.hash;
    for (let r = 2; r <= 4; r++) {
      const b = kit.slip(B, r, [black(10)]);
      const c = kit.close(B, r, q, [b]);
      session.put(b, c, kit.reveal(r, 'bob'));
      q = c.hash;
    }
    const before = fold(session);
    expect(before.rounds.map((v) => v.decided)).toEqual(['void', 'reveals', 'reveals', 'reveals']);
    junkAbandons(session, c1.hash, 700);
    const after = fold(session);
    expect(after.rounds.map((v) => v.decided)).toEqual(['void', 'reveals', 'reveals', 'reveals']);
    expect([...after.nets]).toEqual([...before.nets]);
  });
});

describe('the forfeit cap and forfeits that can never verify', () => {
  it('32 unsigned copies of an honest forfeit don\'t hand a withholding bettor its stake back', () => {
    // alice (honest) and mallory are frozen; alice reveals, mallory withholds.
    const M = testIdentity('mallory');
    const a = kit.slip(A, 1, [red(10)]);
    const m = kit.slip(M, 1, [black(50)]);
    const close = kit.close(A, 1, SID, [a, m]);
    const fa = kit.forfeit(A, 1, close.hash, ['alice']); // alice's honest forfeit
    const session = new TestSession().put(a, m, close, kit.reveal(1, 'alice'), fa, kit.abandon(C, 1, close.hash));
    let res = fold(session);
    expect(res.rounds[0]?.decided).toBe('forfeit');
    expect(res.nets.get('mallory')).toBe(-50n); // mallory's late seed forfeits her stake
    // mallory copies alice's forfeit 32 times with garbage signatures whose
    // hashes sort before the real one (the same k, so the same rank).
    for (let i = 0, n = 0; n < 32; i++) {
      const junk: ForfeitRec = { r: 1, x: close.hash, n: ['alice'], k: A.pub, g: junkSig(1_000 + i) };
      if (recHash(junk)! < fa.hash) { session.raw(forfeitKey(junk)!, junk); n++; }
    }
    res = fold(session);
    expect(res.rounds[0]?.decided).toBe('forfeit');
    expect(res.rounds[0]?.forfeit?.hash).toBe(fa.hash);
    expect(res.nets.get('mallory')).toBe(-50n);
  });
});

// ── Order independence ───────────────────────────────────────────────────────

/** A session with rival closes, forks, forfeits, abandons, a junk reveal and
 *  plain junk: every record a random sequence can draw from. */
function universe(): { records: [string, unknown][]; cp: null } {
  const ids = [A, B, C, D];
  const out: Built<unknown>[] = [];
  const raw: [string, unknown][] = [];
  const s1 = ids.map((id, i) => kit.slip(id, 1, i === 3 ? [] : [red(5 + i), straight(i * 7, 1)]));
  const a1v2 = kit.slip(A, 1, [black(9)], { v: 2 });
  out.push(...s1, a1v2);
  const x1 = kit.close(A, 1, SID, [a1v2, s1[1]]);
  const y1 = kit.close(B, 1, SID, [s1[0], s1[1], s1[2]]);
  const z1 = kit.close(C, 1, SID, { carol: s1[2].hash, dave: s1[3].hash, erin: NOBODY });
  out.push(x1, y1, z1);
  out.push(kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), kit.reveal(1, 'carol'), kit.reveal(1, 'bob', kit.seed('bob', 1, 'junk')));
  out.push(kit.forfeit(A, 1, y1.hash, ['alice', 'bob']), kit.forfeit(C, 1, z1.hash, ['carol']), kit.abandon(D, 1, x1.hash));
  out.push(kit.forfeit(B, 1, y1.hash, ['alice'])); // invalid: its writer isn't counted
  // Round 2 on two forks.
  const a2 = kit.slip(A, 2, [red(4)]);
  const b2 = kit.slip(B, 2, [black(6)]);
  const c2 = kit.slip(C, 2, [straight(17, 2)]);
  const x2 = kit.close(A, 2, x1.hash, [a2, b2]);
  const y2 = kit.close(C, 2, y1.hash, [c2]);
  const z2 = kit.close(C, 2, z1.hash, [c2]);
  out.push(a2, b2, c2, x2, y2, z2, kit.reveal(2, 'alice'), kit.reveal(2, 'carol'));
  out.push(kit.forfeit(A, 2, x2.hash, ['alice']), kit.abandon(B, 2, x2.hash));
  // Round 3 deepens one fork.
  const c3 = kit.slip(C, 3, [red(8)]);
  const y3 = kit.close(C, 3, y2.hash, [c3]);
  out.push(c3, y3, kit.reveal(3, 'carol'), kit.slip(A, 3, [red(1)]), kit.slip(D, 3, []));
  // Round 4 open: an undecided close that left alice's newer version out.
  const a4 = kit.slip(A, 4, [red(2)]);
  const c4 = kit.slip(C, 4, [black(3)]);
  out.push(a4, c4, kit.slip(A, 4, [red(2), red(9)], { v: 2 }), kit.close(C, 4, y3.hash, [a4, c4]), kit.reveal(4, 'carol'));
  // Junk.
  raw.push([`s:1:alice:${'0'.repeat(32)}`, s1[0].rec]);
  raw.push([`c:2:${'1'.repeat(32)}`, { ...x2.rec, r: 2.5 }]);
  raw.push([`f:1:${'2'.repeat(32)}`, { ...kit.forfeit(A, 1, y1.hash, ['alice']).rec, n: ['bob', 'alice'] }]);
  raw.push([`h:1:${'3'.repeat(32)}`, { house: 1 }]);
  raw.push(['note', 'hello']);
  return { records: [...out.map((b) => [b.key, b.rec] as [string, unknown]), ...raw], cp: null };
}

describe('the output depends on the record set only', () => {
  const { records } = universe();
  const cold = (set: Iterable<readonly [string, unknown]>): string => {
    const f = new TableFold(TEST_CTX, sigs.check);
    f.setBase(null);
    f.reset(set);
    return snapshot(f.result());
  };

  it('the universe exercises forks, forfeits, abandons and rival closes', () => {
    const res = new TestSession().fold(sigs.check);
    res.reset(records);
    const out = res.result();
    expect(out.rounds.map((v) => v.decided)).toEqual(['forfeit', 'reveals', 'reveals', null]);
    expect(out.tip?.missing).toEqual([]);
    expect(out.held).toEqual(new Map([['alice', 2n], ['carol', 3n]]));
    expect(out.felts.get('alice')?.rec.v).toBe(2);
    expect(out.records).toBe(records.length - 5); // the five junk entries

  });

  it('200 shuffled insertion orders, in random batches, give the same output', () => {
    const want = cold(records);
    for (let n = 0; n < 200; n++) {
      const rand = rng(n + 1);
      const order = shuffled(records, rand);
      const f = new TableFold(TEST_CTX, sigs.check);
      f.setBase(null);
      for (let i = 0; i < order.length;) {
        const size = 1 + Math.floor(rand() * 5);
        f.apply(order.slice(i, i + size));
        i += size;
        if (rand() < 0.5) f.result(); // warm the memos mid-way
      }
      expect(snapshot(f.result()), `order ${n}`).toBe(want);
    }
  });

  it('an incremental fold equals a cold one after every random insert and delete', () => {
    const rand = rng(77);
    const live = new Map<string, unknown>();
    const f = new TableFold(TEST_CTX, sigs.check);
    f.setBase(null);
    const junkValues: unknown[] = [{ r: 1 }, 'x', 1.5, null];
    for (let step = 0; step < 600; step++) {
      const roll = rand();
      const [key, value] = records[Math.floor(rand() * records.length)];
      if (roll < 0.55) {
        live.set(key, value);
        f.apply([[key, value]]);
      } else if (roll < 0.9) {
        live.delete(key);
        f.apply([[key, undefined]]);
      } else if (roll < 0.97) {
        // A real key overwritten with junk.
        const junk = junkValues[Math.floor(rand() * junkValues.length)];
        live.set(key, junk);
        f.apply([[key, junk]]);
      } else {
        f.reset(live.entries()); // a replaced session map
      }
      if (rand() < 0.8) expect(snapshot(f.result()), `step ${step}`).toBe(cold(live.entries()));
    }
    expect(snapshot(f.result())).toBe(cold(live.entries()));
  });
});

// ── The raw session size ─────────────────────────────────────────────────────

describe('rawBytes: what the live session weighs, junk included', () => {
  const a1 = kit.slip(A, 1, [red(10)]);
  const close = kit.close(A, 1, SID, [a1]);
  const weight = (key: string, value: unknown): number => key.length + canon(value)!.length;

  it('counts a record as bytes does, and every junk key beside it', () => {
    const f = new TableFold(TEST_CTX, sigs.check);
    f.apply([[a1.key, a1.rec], [close.key, close.rec]]);
    const records = weight(a1.key, a1.rec) + weight(close.key, close.rec);
    expect(f.result()).toMatchObject({ bytes: records, rawBytes: records });
    const junk: [string, unknown][] = [
      ['note', 'hello'], // canonical, but no record
      [`c:1:${NOBODY}`, { ...close.rec, r: 1.5 }], // not canonical: its JSON
      ['big', 2n ** 70n], // neither: a flat 64
      ['fn', () => 1],
    ];
    f.apply(junk);
    const res = f.result();
    expect(res.bytes).toBe(records);
    expect(res.records).toBe(2);
    expect(res.rawBytes).toBe(records + 'note'.length + '"hello"'.length
      + `c:1:${NOBODY}`.length + JSON.stringify({ ...close.rec, r: 1.5 }).length + 'big'.length + 64 + 'fn'.length + 64);
  });

  it('a junk key overwritten, then deleted, weighs what it holds now, then nothing', () => {
    const f = new TableFold(TEST_CTX, sigs.check);
    f.apply([['note', 'hello']]);
    const first = f.result();
    expect(first.rawBytes).toBe(4 + 7);
    f.apply([['note', 'hello']]); // the same weight again: nothing changed
    expect(f.result()).toBe(first);
    f.apply([['note', 'hello, world']]);
    expect(f.result().rawBytes).toBe(4 + 14);
    f.apply([['note', undefined]]);
    expect(f.result().rawBytes).toBe(0);
  });

  it('reset and a new session start it afresh; the same sid keeps it', () => {
    const f = new TableFold(TEST_CTX, sigs.check);
    f.apply([['note', 'hello'], [a1.key, a1.rec]]);
    f.reset([['x', 'y']]);
    expect(f.result().rawBytes).toBe(1 + 3);
    f.setBase(null); // 'g' again
    expect(f.result().rawBytes).toBe(1 + 3);
    f.setBase(kit.checkpoint(A, 'g', 1, close.hash, { alice: 5n }));
    expect(f.result()).toMatchObject({ rawBytes: 0, bytes: 0, records: 0 });
  });

  it('an incremental fold weighs what a cold one does after every random insert, delete and junk write', () => {
    const { records } = universe();
    const rand = rng(91);
    const live = new Map<string, unknown>();
    const f = new TableFold(TEST_CTX, sigs.check);
    const junkValues: unknown[] = [{ r: 1 }, 'x', 1.5, null, [1, [2, 'three']], 7n];
    const coldWeight = (): number => {
      const c = new TableFold(TEST_CTX, sigs.check);
      c.reset(live.entries());
      return c.result().rawBytes;
    };
    for (let step = 0; step < 300; step++) {
      const roll = rand();
      const [key, value] = records[Math.floor(rand() * records.length)];
      const write = roll < 0.5 ? value : roll < 0.8 ? undefined : junkValues[Math.floor(rand() * junkValues.length)];
      if (write === undefined) live.delete(key);
      else live.set(key, write);
      f.apply([[key, write]]);
      if (rand() < 0.5) expect(f.result().rawBytes, `step ${step}`).toBe(coldWeight());
    }
    expect(f.result().rawBytes).toBe(coldWeight());
  });
});
