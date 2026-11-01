/**
 * 🔏 Signatures on computed-table records (keypair.verifyIdentityStrict).
 *
 * Every page must reach the same verdict on every record, or pages fold
 * different rounds. So the verifier is pinned: @noble/ed25519 2.3.0 with
 * zip215:false, after a check that the key and signature are spelled the one
 * canonical base64url way and that R isn't the identity point.
 * test-vectors/ed25519-strict.json holds the edge cases (made by a throwaway
 * script from fixed seeds and scalars; see its note) with the strict
 * verdict, noble's zip215:false verdict on its own, and noble's default
 * ("loose") one.
 */

import { readFileSync } from 'node:fs';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import vectors from '../test-vectors/ed25519-strict.json';
import { signBytes, TableFold } from './computedFold';
import type { FoldCtx, SlipRec } from './computedFold';
import { b64url, cachingCheck, ComputedKit, red, TEST_CTX, TestSession, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import { verifyIdentity, verifyIdentityStrict, ysyncSigner } from './keypair';

const unb64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The same bytes, spelled differently: set a low bit the decoder throws away. */
const strayBit = (s: string): string => s.slice(0, -1) + B64[B64.indexOf(s[s.length - 1]) | 1];

const honest = vectors.vectors.find((v) => v.name === 'honest')!;

describe('the pinned verifier', () => {
  it('is @noble/ed25519 2.3.0, pinned exactly', () => {
    const app = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lib = JSON.parse(readFileSync(new URL('../node_modules/@noble/ed25519/package.json', import.meta.url), 'utf8'));
    expect(app.dependencies['@noble/ed25519']).toBe('2.3.0');
    expect(lib.version).toBe('2.3.0');
  });

  it('gives every vector its pinned verdict: strict, noble\'s zip215:false alone, and loose', () => {
    expect(vectors.vectors.map((v) => v.name)).toEqual([
      'honest', 'torsion-r', 's-plus-l', 'noncanonical-r', 'small-order-key', 'identity-r', 'identity-r-rfc',
      'torsion-key', 'small-order-r', 'noncanonical-r-own-k',
    ]);
    for (const v of vectors.vectors) {
      const msg = hexToBytes(v.msg);
      expect(verifyIdentityStrict(v.pub, msg, v.sig), `${v.name} strict`).toBe(v.strict);
      expect(ed.verify(unb64url(v.sig), msg, unb64url(v.pub), { zip215: false }), `${v.name} noble zip215:false`).toBe(v.noble);
      expect(ed.verify(unb64url(v.sig), msg, unb64url(v.pub)), `${v.name} noble default`).toBe(v.loose);
      // The vectors are spelled canonically, so verifyIdentity (the strict point
      // checks, a forgiving spelling) gives the strict verdict on every one.
      expect(verifyIdentity(v.pub, msg, v.sig), `${v.name} verifyIdentity`).toBe(v.strict);
    }
  });

  it('accepts a torsion component in R or the key, or a small-order R (the cofactored equation), and refuses a small-order key\'s universal signature', () => {
    // The node's house checks these the same way (house_bytes.rs verify).
    for (const name of ['torsion-r', 'torsion-key', 'small-order-r']) {
      const v = vectors.vectors.find((x) => x.name === name)!;
      expect(verifyIdentityStrict(v.pub, hexToBytes(v.msg), v.sig), name).toBe(true);
    }
    const small = vectors.vectors.find((v) => v.name === 'small-order-key')!;
    for (const msg of [hexToBytes(small.msg), new TextEncoder().encode('cash out everything')]) {
      expect(ed.verify(unb64url(small.sig), msg, unb64url(small.pub))).toBe(true); // noble's default takes it
      expect(verifyIdentityStrict(small.pub, msg, small.sig)).toBe(false);
      expect(verifyIdentity(small.pub, msg, small.sig)).toBe(false);
    }
  });

  it('gives the room sync\'s envelope check (ysyncSigner().verify) the same point checks', () => {
    const { verify } = ysyncSigner();
    for (const v of vectors.vectors) {
      expect(verify(unb64url(v.pub), hexToBytes(v.msg), unb64url(v.sig)), v.name).toBe(v.strict);
    }
    const small = vectors.vectors.find((v) => v.name === 'small-order-key')!;
    expect(verify(unb64url(small.pub), new TextEncoder().encode('any envelope at all'), unb64url(small.sig))).toBe(false);
    expect(verify(unb64url(honest.pub), hexToBytes(honest.msg), new Uint8Array(10))).toBe(false); // short junk: false, no throw
  });

  it('refuses a key or signature spelled any way but the canonical one', () => {
    const msg = hexToBytes(honest.msg);
    expect(verifyIdentityStrict(honest.pub, msg, honest.sig)).toBe(true);
    const pubs = [
      strayBit(honest.pub), `${honest.pub}=`, honest.pub.replace(/_/g, '/').replace(/-/g, '+'),
      `${honest.pub.slice(0, 10)} ${honest.pub.slice(10)}`, honest.pub.slice(0, -1),
      b64url(unb64url(honest.pub).subarray(0, 31)), b64url(new Uint8Array([...unb64url(honest.pub), 0])),
    ];
    for (const pub of pubs) {
      expect(pub).not.toBe(honest.pub);
      expect(verifyIdentityStrict(pub, msg, honest.sig), pub).toBe(false);
    }
    expect(verifyIdentity(strayBit(honest.pub), msg, honest.sig)).toBe(true); // the lenient decode reads the same key
    const sigs = [
      strayBit(honest.sig), `${honest.sig}==`, honest.sig.replace(/_/g, '/').replace(/-/g, '+'),
      `\n${honest.sig}`, b64url(unb64url(honest.sig).subarray(0, 63)),
    ];
    for (const sig of sigs) {
      expect(sig).not.toBe(honest.sig);
      expect(verifyIdentityStrict(honest.pub, msg, sig), sig).toBe(false);
    }
    expect(verifyIdentity(honest.pub, msg, strayBit(honest.sig))).toBe(true);
  });

  it('answers false, never throws, on junk', () => {
    const msg = hexToBytes(honest.msg);
    const junk: unknown[] = [undefined, null, 42, {}, '', '!!!', 'é'.repeat(43)];
    for (const j of junk) {
      expect(verifyIdentityStrict(j as string, msg, honest.sig)).toBe(false);
      expect(verifyIdentityStrict(honest.pub, msg, j as string)).toBe(false);
    }
    expect(verifyIdentityStrict(honest.pub, 'not bytes' as unknown as Uint8Array, honest.sig)).toBe(false);
  });

  it('keeps working past its key cache', () => {
    const msg = hexToBytes(honest.msg);
    for (let i = 0; i < 1_100; i++) verifyIdentityStrict(b64url(new Uint8Array(32).fill(i % 256)).slice(0, 42) + i, msg, honest.sig);
    expect(verifyIdentityStrict(honest.pub, msg, honest.sig)).toBe(true);
    expect(verifyIdentityStrict(strayBit(honest.pub), msg, honest.sig)).toBe(false);
  });
});

// ── R = the identity point ───────────────────────────────────────────────────
//
// Review regression. noble 2.3.0's _verify hashes R‖A‖M inside a try, after
// it has computed S·B; R.toBytes() throws on the identity point (01 00…00,
// which strict decoding accepts), so k becomes SHA-512("") mod L with no
// message in it. A key's owner sets S = k·a once, and that one g verified
// every message under an ordinary full-order key: any kind, room, table or
// incarnation, any body. verifyIdentityStrict now refuses an identity R
// before calling noble (the identity-r vectors).

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const le = (b: Uint8Array): bigint => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const toLE = (n: bigint): Uint8Array => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++) { o[i] = Number(n & 255n); n >>= 8n; } return o; };

/** A real, full-order key whose every "signature" is the one identity-R g. */
function universalIdentity(name: string): TestIdentity {
  const { scalar, pointBytes } = ed.utils.getExtendedPublicKey(sha256(utf8ToBytes(`ssf-ct-test-identity|${name}`)));
  const sig = new Uint8Array(64);
  sig[0] = 1; // R = the identity point, canonically encoded
  sig.set(toLE(((le(sha512(new Uint8Array(0))) % L) * scalar) % L), 32);
  const g = b64url(sig);
  return { pid: name, pub: b64url(pointBytes), sign: () => g };
}

describe('a signature whose R is the identity point', () => {
  const kit = new ComputedKit();
  const M = universalIdentity('mallory');
  const slip = kit.slip(M, 1, [red(10)]);
  const close = kit.close(M, 1, 'g', [slip]);
  const session = new TestSession().put(slip, close, kit.reveal(1, 'mallory'));

  it('is made under an ordinary key, and noble on its own accepts it for any message', () => {
    expect(ed.Point.fromHex(unb64url(M.pub)).isSmallOrder()).toBe(false);
    for (const msg of [signBytes('slip', TEST_CTX, slip.rec), utf8ToBytes('cash out everything')]) {
      expect(ed.verify(unb64url(slip.rec.g), msg, unb64url(M.pub), { zip215: false })).toBe(true); // why the byte check exists
      expect(verifyIdentityStrict(M.pub, msg, slip.rec.g)).toBe(false);
    }
  });

  it('decides nothing and holds nothing, here or copied anywhere else', () => {
    const places: [string, FoldCtx][] = [
      ['here', TEST_CTX],
      ['room', { ...TEST_CTX, room: 'room-other' }],
      ['table', { ...TEST_CTX, t: 'roulette-2' }],
      ['incarnation', { ...TEST_CTX, inc: 'c'.padEnd(25, 'f') }],
    ];
    for (const [what, ctx] of places) {
      expect(verifyIdentityStrict(slip.rec.k, signBytes('slip', ctx, slip.rec), slip.rec.g), `slip verifies ${what}`).toBe(false);
      const f = new TableFold(ctx, cachingCheck().check);
      f.setBase(null);
      f.reset(session.records.entries());
      const res = f.result();
      expect(res.rounds, `a round decided ${what}`).toEqual([]);
      expect([...res.held], `chips held ${what}`).toEqual([]);
    }
    for (const kind of ['close', 'forfeit', 'abandon', 'sum'] as const) {
      expect(verifyIdentityStrict(slip.rec.k, signBytes(kind, TEST_CTX, slip.rec), slip.rec.g), `slip g as a ${kind}`).toBe(false);
    }
  });

  it('can\'t carry a body nobody signed', () => {
    const forged: SlipRec = { r: 1, p: 'mallory', v: 9, b: [red(1_000_000_000)], c: slip.rec.c, k: M.pub, g: slip.rec.g };
    expect(verifyIdentityStrict(M.pub, signBytes('slip', TEST_CTX, forged), forged.g)).toBe(false);
  });

  it('is refused even when RFC 8032 would accept it (S = k·a for the real k)', () => {
    // So a later WebCrypto fast path, which accepts this one, must run the
    // same byte check first, or pages would disagree.
    const v = vectors.vectors.find((x) => x.name === 'identity-r-rfc')!;
    expect(verifyIdentityStrict(v.pub, hexToBytes(v.msg), v.sig)).toBe(false);
  });
});

describe('a record signed for one place', () => {
  const kit = new ComputedKit();
  const alice = testIdentity('alice');
  const slip = kit.slip(alice, 1, [red(10)]);

  it('fails under another room, table, incarnation or kind', () => {
    const { g, k } = slip.rec;
    expect(verifyIdentityStrict(k, signBytes('slip', TEST_CTX, slip.rec), g)).toBe(true);
    const elsewhere: [string, FoldCtx][] = [
      ['room', { ...TEST_CTX, room: 'room-other' }],
      ['offline', { ...TEST_CTX, room: '' }],
      ['table', { ...TEST_CTX, t: 'roulette-2' }],
      ['incarnation', { ...TEST_CTX, inc: 'c'.padEnd(25, 'f') }],
    ];
    for (const [what, ctx] of elsewhere) expect(verifyIdentityStrict(k, signBytes('slip', ctx, slip.rec), g), what).toBe(false);
    for (const kind of ['close', 'forfeit', 'abandon', 'sum'] as const) {
      expect(verifyIdentityStrict(k, signBytes(kind, TEST_CTX, slip.rec), g), kind).toBe(false);
    }
  });

  it('signs everything but g, k included', () => {
    const { g } = slip.rec;
    expect(verifyIdentityStrict(alice.pub, signBytes('slip', TEST_CTX, { ...slip.rec, v: 2 }), g)).toBe(false);
    expect(verifyIdentityStrict(alice.pub, signBytes('slip', TEST_CTX, { ...slip.rec, g: 'x' }), g)).toBe(true);
  });

  it('replayed into another table\'s session, decides nothing there', () => {
    const close = kit.close(alice, 1, 'g', [slip]);
    const session = new TestSession().put(slip, close, kit.reveal(1, 'alice'));
    const here = session.fold(cachingCheck().check).result();
    expect(here.rounds[0]?.decided).toBe('reveals');
    const other = new TableFold({ ...TEST_CTX, t: 'roulette-2' }, cachingCheck().check);
    other.setBase(null);
    other.reset(session.records.entries());
    const there = other.result();
    expect(there.rounds).toEqual([]);
    expect(there.openCloses.map((c) => c.state)).toEqual(['invalid']);
    expect(there.felts.size).toBe(0);
  });
});
