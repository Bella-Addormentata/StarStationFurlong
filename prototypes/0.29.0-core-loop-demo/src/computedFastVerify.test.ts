/**
 * 🏎 The fast path for signature checks (keypair fastStrictCheck): WebCrypto's
 * Ed25519 under verifyIdentityStrict's byte checks, trusted only for a yes.
 *
 * Every page must reach the same verdict on every record, or pages fold
 * different rounds, so the fast path may never say yes where
 * verifyIdentityStrict says no, and its no by the byte checks must be
 * verifyIdentityStrict's no. WebCrypto's cofactorless equation refuses
 * signatures noble's cofactored one takes (a torsion component in R or the
 * key, a small-order R): those go to noble. And WebCrypto takes an identity
 * R whose S fits the real k, which the byte checks refuse first.
 *
 * Then casinoDoc: checks past a recount's budget go to WebCrypto, their
 * answers land in the verdicts, and a slice counts them; what WebCrypto
 * doesn't say yes to is noble's in a later recount. Node 22's WebCrypto has
 * Ed25519, as the browsers the game runs in do.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import vectors from '../test-vectors/ed25519-strict.json';
import { delegationKey, roomSignBytes } from './computedHouse';
import { b64url, ComputedKit, red, TEST_CTX, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';

type Keypair = typeof import('./keypair');

const realCrypto = globalThis.crypto;
const L = ed.CURVE.n;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fresh load of keypair.ts (its fast path off, nothing cached). */
async function freshKeypair(): Promise<Keypair> {
  vi.resetModules();
  return import('./keypair');
}

/** The fast path's verdict where it has one, else verifyIdentityStrict's,
 *  and which path gave it. */
async function viaFast(kp: Keypair, pub: string, msg: Uint8Array, sig: string): Promise<{ ok: boolean; by: 'bytes' | 'webcrypto' | 'noble' }> {
  const fast = kp.fastStrictCheck(pub, msg, sig);
  expect(fast).not.toBeNull();
  if (fast === false) return { ok: false, by: 'bytes' };
  const yes = await fast;
  return yes ? { ok: true, by: 'webcrypto' } : { ok: kp.verifyIdentityStrict(pub, msg, sig), by: 'noble' };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The same bytes, spelled differently: set a low bit the decoder throws away. */
const strayBit = (s: string): string => s.slice(0, -1) + B64[B64.indexOf(s[s.length - 1]) | 1];
const unb64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const leBytes = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const leNum = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const modL = (n: bigint): bigint => ((n % L) + L) % L;

/** A point of order 8 (one of the curve's torsion points, spelled canonically). */
const T8 = ed.Point.fromBytes(hexToBytes('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'), false);

/** An identity whose key is a·B + T8: not of small order, and its honest
 *  signatures (S = r + k·a) pass noble's cofactored equation but pass the
 *  cofactorless one only when 8 divides k. */
function torsionIdentity(name: string, pid: string = name): TestIdentity & { a: bigint } {
  const a = modL(leNum(sha512(utf8ToBytes(`ssf-fast-torsion|${name}`)))) || 1n;
  const A = ed.Point.BASE.multiply(a).add(T8);
  const Abytes = A.toBytes();
  return {
    a,
    pid,
    pub: b64url(Abytes),
    sign: (bytes) => {
      const r = modL(leNum(sha512(ed.etc.concatBytes(utf8ToBytes(`ssf-fast-torsion-r|${name}`), bytes)))) || 1n;
      const R = ed.Point.BASE.multiply(r).toBytes();
      const k = modL(leNum(sha512(ed.etc.concatBytes(R, Abytes, bytes))));
      return b64url(ed.etc.concatBytes(R, leBytes(modL(r + k * a))));
    },
  };
}

describe('fastStrictCheck', () => {
  it('is off until enabled, and on once the self-test passes', async () => {
    const kp = await freshKeypair();
    const v = vectors.vectors.find((x) => x.name === 'honest')!;
    expect(kp.fastStrictChecksOn()).toBe(false);
    expect(kp.fastStrictCheck(v.pub, hexToBytes(v.msg), v.sig)).toBeNull();
    expect(await kp.enableFastStrictChecks()).toBe(true);
    expect(kp.fastStrictChecksOn()).toBe(true);
    expect(await kp.enableFastStrictChecks()).toBe(true); // again: nothing new
    expect(await kp.enableFastStrictChecks(false)).toBe(false);
    expect(kp.fastStrictCheck(v.pub, hexToBytes(v.msg), v.sig)).toBeNull();
  });

  it('gives every vector its strict verdict: the byte checks refuse what they refuse, and WebCrypto\'s yes only where strict says yes', async () => {
    const kp = await freshKeypair();
    expect(await kp.enableFastStrictChecks()).toBe(true);
    const by: Record<string, string> = {};
    for (const v of vectors.vectors) {
      const got = await viaFast(kp, v.pub, hexToBytes(v.msg), v.sig);
      expect(got.ok, v.name).toBe(v.strict);
      by[v.name] = got.by;
    }
    expect(by).toEqual({
      'honest': 'webcrypto',
      'torsion-r': 'noble', // cofactorless: no; cofactored: yes
      's-plus-l': 'bytes',
      'noncanonical-r': 'bytes',
      'small-order-key': 'bytes',
      'identity-r': 'bytes',
      'identity-r-rfc': 'bytes', // WebCrypto alone would say yes (below)
      'torsion-key': 'noble',
      'small-order-r': 'noble',
      'noncanonical-r-own-k': 'bytes',
    });
  });

  it('refuses an identity R by the byte checks before WebCrypto, which takes it when S fits the real k', async () => {
    const v = vectors.vectors.find((x) => x.name === 'identity-r-rfc')!;
    const unb = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const key = await realCrypto.subtle.importKey('raw', unb(v.pub), { name: 'Ed25519' }, false, ['verify']);
    expect(await realCrypto.subtle.verify({ name: 'Ed25519' }, key, unb(v.sig), hexToBytes(v.msg) as Uint8Array<ArrayBuffer>)).toBe(true);
    const kp = await freshKeypair();
    await kp.enableFastStrictChecks();
    expect(kp.fastStrictCheck(v.pub, hexToBytes(v.msg), v.sig)).toBe(false);
    expect(kp.verifyIdentityStrict(v.pub, hexToBytes(v.msg), v.sig)).toBe(false);
  });

  it('agrees with verifyIdentityStrict on honest signatures, every byte flipped, other spellings, and torsion keys', async () => {
    const kp = await freshKeypair();
    await kp.enableFastStrictChecks();
    const cases: { pub: string; msg: Uint8Array; sig: string }[] = [];
    for (let i = 0; i < 24; i++) {
      const id = testIdentity(`fuzz-${i}`);
      const msg = utf8ToBytes(`ssf-ct-v1|slip|room|t|inc|{"r":${i}}`);
      const sig = id.sign(msg);
      cases.push({ pub: id.pub, msg, sig });
      const raw = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const flipped = raw.slice();
      flipped[i % 64] ^= 1 << (i % 8);
      cases.push({ pub: id.pub, msg, sig: b64url(flipped) });
      const other = msg.slice();
      other[i % other.length] ^= 1;
      cases.push({ pub: id.pub, msg: other, sig });
      cases.push({ pub: testIdentity(`fuzz-other-${i}`).pub, msg, sig });
      cases.push({ pub: id.pub, msg, sig: strayBit(sig) });
      cases.push({ pub: strayBit(id.pub), msg, sig });
      // S + L: the same equation, a spelling strict refuses.
      const sPlusL = raw.slice();
      sPlusL.set(leBytes(leNum(raw.subarray(32)) + L), 32);
      cases.push({ pub: id.pub, msg, sig: b64url(sPlusL) });
      const tor = torsionIdentity(`fuzz-torsion-${i}`);
      cases.push({ pub: tor.pub, msg, sig: tor.sign(msg) });
    }
    const by = { bytes: 0, webcrypto: 0, noble: 0 };
    for (const c of cases) {
      const got = await viaFast(kp, c.pub, c.msg, c.sig);
      expect(got.ok).toBe(kp.verifyIdentityStrict(c.pub, c.msg, c.sig));
      by[got.by] += 1;
    }
    expect(by.webcrypto).toBeGreaterThanOrEqual(24); // the honest ones, and a torsion key's when 8 divides k
    expect(by.noble).toBeGreaterThan(0); // torsion keys mostly
    expect(by.bytes).toBeGreaterThan(0);
  });

  it('is never used with a WebCrypto that says yes to a wrong signature (the self-test)', async () => {
    const kp = await freshKeypair();
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
      subtle: { importKey: () => Promise.resolve({}), verify: () => Promise.resolve(true) },
    });
    expect(await kp.enableFastStrictChecks()).toBe(false);
    expect(kp.fastStrictChecksOn()).toBe(false);
    const v = vectors.vectors.find((x) => x.name === 'honest')!;
    expect(kp.fastStrictCheck(v.pub, hexToBytes(v.msg), v.sig)).toBeNull();
    vi.unstubAllGlobals();
    expect(await kp.enableFastStrictChecks()).toBe(false); // for good on this load
  });

  it('stays off where WebCrypto has no Ed25519, or no WebCrypto at all', async () => {
    let kp = await freshKeypair();
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
      subtle: { importKey: () => Promise.reject(new DOMException('no', 'NotSupportedError')), verify: () => Promise.resolve(true) },
    });
    expect(await kp.enableFastStrictChecks()).toBe(false);
    kp = await freshKeypair();
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) });
    expect(await kp.enableFastStrictChecks()).toBe(false);
  });

  it('stays off after a self-test whose answers didn\'t come in 2 s, and the next enable tests again', async () => {
    const kp = await freshKeypair();
    vi.useFakeTimers();
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
      subtle: {
        importKey: (...a: Parameters<SubtleCrypto['importKey']>) => realCrypto.subtle.importKey(...a),
        verify: () => new Promise<boolean>(() => {}),
      },
    });
    let on: unknown = 'none yet';
    void kp.enableFastStrictChecks().then((x) => { on = x; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(on).toBe(false);
    expect(kp.fastStrictChecksOn()).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(await kp.enableFastStrictChecks()).toBe(true); // not 'broken': tested again, and on
  });

  it('runs one self-test for enables that come while it runs', async () => {
    const kp = await freshKeypair();
    let verifies = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
      subtle: {
        importKey: (...a: Parameters<SubtleCrypto['importKey']>) => realCrypto.subtle.importKey(...a),
        verify: (...a: Parameters<SubtleCrypto['verify']>) => { verifies += 1; return realCrypto.subtle.verify(...a); },
      },
    });
    expect(await Promise.all([kp.enableFastStrictChecks(), kp.enableFastStrictChecks()])).toEqual([true, true]);
    expect(verifies).toBe(3);
  });

  it('takes an answer that never comes for none after 2 s', async () => {
    const kp = await freshKeypair();
    await kp.enableFastStrictChecks();
    vi.useFakeTimers();
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
      subtle: {
        importKey: (...a: Parameters<SubtleCrypto['importKey']>) => realCrypto.subtle.importKey(...a),
        verify: () => new Promise<boolean>(() => {}),
      },
    });
    const id = testIdentity('slow');
    const msg = utf8ToBytes('slow');
    const fast = kp.fastStrictCheck(id.pub, msg, id.sign(msg));
    expect(fast).toBeInstanceOf(Promise);
    let answer: unknown = 'none yet';
    void (fast as Promise<true | undefined>).then((x) => { answer = x; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(answer).toBe('none yet');
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeUndefined();
  });
});

// ── casinoDoc: checks past a recount's budget ────────────────────────────────

type Page = { casino: typeof import('./casinoDoc'); keypair: Keypair; doc: Y.Doc; clockReads: () => number };

const OWNER = 'owner-Alice';
vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

const TABLE = 'roulette-1';
const INC = TEST_CTX.inc;
const kit = new ComputedKit({ room: '', t: TABLE, inc: INC });

/** A page whose check clock moves 0.5 ms a read, so a noble check costs
 *  0.5 ms and so does sending one to WebCrypto (each reads it twice), with a
 *  budget of `budgetMs` a recount (2 ms: four noble checks, then up to 40
 *  sends, COMPUTED_FAST_MS being 20); the fast path on when `fast`. */
async function loadPage(clientID: number, fast: boolean, budgetMs = 2): Promise<Page> {
  vi.stubGlobal('window', { location: { search: '' } });
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const keypair = await import('./keypair');
  if (fast) expect(await keypair.enableFastStrictChecks()).toBe(true);
  const doc = new Y.Doc();
  doc.clientID = clientID;
  let reads = 0;
  casino.setComputedVerifyForTests({ now: () => (reads += 1) * 0.5, budgetMs });
  casino.bindCasinoDoc(doc, '');
  return { casino, keypair, doc, clockReads: () => reads };
}

function syncTo(from: Page, to: Page): void {
  Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
}

async function until(done: () => boolean, tries = 3_000): Promise<boolean> {
  for (let i = 0; i < tries && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  return done();
}

/** The WebCrypto key imports (one as each new key's first check is sent)
 *  and verifies made from here on, counted around the real ones. Installed
 *  after the pages load, so the self-test's aren't counted. */
function countWebCrypto(): { imports: number; verifies: number } {
  const n = { imports: 0, verifies: 0 };
  vi.stubGlobal('crypto', {
    getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
    subtle: {
      importKey: (...a: Parameters<SubtleCrypto['importKey']>) => {
        n.imports += 1;
        return realCrypto.subtle.importKey(...a);
      },
      verify: (...a: Parameters<SubtleCrypto['verify']>) => {
        n.verifies += 1;
        return realCrypto.subtle.verify(...a);
      },
      digest: (...a: Parameters<SubtleCrypto['digest']>) => realCrypto.subtle.digest(...a),
    },
  });
  return n;
}

/** Page w writes the table's switch, its first session, the bettors' keys
 *  and chips, and the records. */
function writeTable(w: Page, ids: TestIdentity[], recs: Built<unknown>[]): void {
  for (const id of ids) w.casino.buyInChips(id.pid, 100);
  w.doc.transact(() => {
    for (const id of ids) w.doc.getMap('players').set(id.pid, { keyB64: id.pub });
    w.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    w.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
  });
  const ses = w.casino.computedSessionForWrite(TABLE)!;
  w.doc.transact(() => {
    for (const r of recs) ses.set(r.key, r.rec);
  });
}

describe('casinoDoc: checks past the budget go to WebCrypto', () => {
  const ids = Array.from({ length: 30 }, (_, i) => testIdentity(`bettor-${i}`, `player-${i}`));
  const slips = ids.map((id, i) => kit.slip(id, 1, [red(1 + (i % 7))]));

  it('counts the same records as noble alone, sooner, with most checks on WebCrypto', async () => {
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, slips);
    const fast = await loadPage(2, true);
    const slow = await loadPage(3, false);
    const calls = countWebCrypto();
    syncTo(w, fast);
    syncTo(w, slow);
    for (const p of [fast, slow]) expect(p.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending && !slow.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    for (let i = 0; i < ids.length; i++) {
      const want = 100 - (1 + (i % 7));
      expect(fast.casino.readChips(ids[i].pid)).toBe(want);
      expect(slow.casino.readChips(ids[i].pid)).toBe(want);
      expect(fast.casino.computedVerdictOf(TABLE, INC, slips[i].hash)).toBe(true);
    }
    // The first recount: four on noble (its 2 ms), the other 26 sent; then
    // every yes counted as it came, nothing checked again on noble.
    expect(calls.verifies).toBe(ids.length - 4);
    expect(fast.clockReads()).toBe(2 * ids.length);
    expect(slow.clockReads()).toBe(2 * ids.length); // all 30 on noble, four a recount
    expect(fast.casino.computedSettled()).toBe(true);
  });

  /** A record signed by `id`'s key, its hash and key its own, with `sig` in place of the signature. */
  const forgedBy = (id: TestIdentity, sig: (bytes: Uint8Array) => string): Built<unknown> => kit.slip({ ...id, sign: sig }, 1, [red(1)]);

  it('refuses past the budget what the byte checks refuse, as noble does, without asking WebCrypto', async () => {
    // Each a real signature by the bettor's key, spelled or changed so the
    // byte checks refuse it: a stray bit, S + L, an identity R with the RFC
    // S (which WebCrypto would take), all-ones (R's y >= p).
    const kinds: ((id: TestIdentity) => (bytes: Uint8Array) => string)[] = [
      (id) => (b) => strayBit(id.sign(b)),
      (id) => (b) => {
        const raw = unb64url(id.sign(b));
        raw.set(leBytes(leNum(raw.subarray(32)) + L), 32);
        return b64url(raw);
      },
      () => () => vectors.vectors.find((x) => x.name === 'identity-r-rfc')!.sig,
      () => () => '_'.repeat(86),
    ];
    const forged = ids.slice(0, 12).map((id, i) => forgedBy(id, kinds[i % kinds.length](id)));
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, forged);
    const fast = await loadPage(2, true);
    const calls = countWebCrypto();
    syncTo(w, fast);
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    expect(calls.imports + calls.verifies).toBe(0);
    expect(fast.clockReads()).toBe(2 * 12); // four on noble, eight refused as they were sent
    for (let i = 0; i < 12; i++) {
      expect(fast.casino.computedVerdictOf(TABLE, INC, forged[i].hash)).toBe(false);
      expect(fast.casino.readChips(ids[i].pid)).toBe(100);
    }
  });

  it('refuses past the budget what WebCrypto says no to and noble refuses after', async () => {
    const forged = ids.slice(0, 12).map((id, i) => forgedBy(id, i % 2 === 0
      ? () => 'A'.repeat(86) // R = 00..00, a point of order 4 (strict decoding takes it), S = 0
      : () => id.sign(utf8ToBytes('another message')))); // a real signature of something else
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, forged);
    const fast = await loadPage(2, true);
    const calls = countWebCrypto();
    syncTo(w, fast);
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    expect(calls.verifies).toBe(8); // past the first four
    for (let i = 0; i < 12; i++) {
      expect(fast.casino.computedVerdictOf(TABLE, INC, forged[i].hash)).toBe(false);
      expect(fast.casino.readChips(ids[i].pid)).toBe(100);
    }
  });

  it('counts a torsion key\'s slips that WebCrypto refuses, once noble has checked them', async () => {
    const tors = Array.from({ length: 10 }, (_, i) => torsionIdentity(`tor-${i}`, `tor-player-${i}`));
    const torSlips = tors.map((id) => kit.slip(id, 1, [red(5)]));
    const w = await loadPage(1, false, 1_000);
    writeTable(w, tors, torSlips);
    const fast = await loadPage(2, true);
    const calls = countWebCrypto();
    syncTo(w, fast);
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    for (const id of tors) expect(fast.casino.readChips(id.pid)).toBe(95);
    expect(calls.verifies).toBe(tors.length - 4); // each past the first four sent once
    expect(fast.clockReads()).toBeGreaterThan(2 * tors.length); // and noble checked those WebCrypto refused
  });

  it('drops answers that come after the page bound another doc', async () => {
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, slips);
    const fast = await loadPage(2, true);
    syncTo(w, fast);
    expect(fast.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    const fresh = new Y.Doc();
    fast.casino.bindCasinoDoc(fresh, '');
    const origins: unknown[] = [];
    w.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    fresh.on('afterTransaction', (tr: Y.Transaction) => { if (typeof tr.origin === 'symbol') origins.push(tr.origin); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(origins).toEqual([]);
    expect(fast.casino.computedVerdictOf(TABLE, INC, slips[29].hash)).toBeUndefined();
  });

  it('counts the same records on a doc bound while their checks were in flight (a rejoin of the room)', async () => {
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, slips);
    const fast = await loadPage(2, true);
    syncTo(w, fast);
    expect(fast.casino.computedFoldOf(TABLE)!.pending).toBe(true); // 26 in flight
    const again = new Y.Doc();
    Y.applyUpdate(again, Y.encodeStateAsUpdate(w.doc));
    fast.casino.bindCasinoDoc(again, '');
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    for (let i = 0; i < ids.length; i++) expect(fast.casino.readChips(ids[i].pid)).toBe(100 - (1 + (i % 7)));
  });

  it('leaves every check to a spec\'s own check when one is swapped in, past the budget too', async () => {
    const w = await loadPage(1, false, 1_000);
    writeTable(w, ids, slips);
    const fast = await loadPage(2, true);
    let asked = 0;
    let reads = 0;
    fast.casino.setComputedVerifyForTests({ verify: () => { asked += 1; return true; }, now: () => (reads += 1) * 0.5, budgetMs: 2 });
    const calls = countWebCrypto();
    syncTo(w, fast);
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    expect(asked).toBe(ids.length);
    expect(calls.imports + calls.verifies).toBe(0);
  });

  it('sends at most 20 ms of checks a recount, and the rest in the recounts after', async () => {
    const many = Array.from({ length: 100 }, (_, i) => testIdentity(`crowd-${i}`, `crowd-player-${i}`));
    const crowd = many.map((id, i) => kit.slip(id, 1, [red(1 + (i % 5))]));
    const w = await loadPage(1, false, 10_000);
    writeTable(w, many, crowd);
    const fast = await loadPage(2, true);
    const calls = countWebCrypto();
    syncTo(w, fast);
    expect(calls.imports).toBe(40); // 20 ms at 0.5 ms a send, each a new key
    expect(await until(() => !fast.casino.computedFoldOf(TABLE)!.pending)).toBe(true);
    expect(calls.imports).toBe(88); // three recounts: 4 + 40, 4 + 40, 4 + 8
    for (let i = 0; i < many.length; i++) expect(fast.casino.readChips(many[i].pid)).toBe(100 - (1 + (i % 5)));
  });

  it('checks the room records past the budget there too: a flood of forged delegations, then the real one', async () => {
    const owner = testIdentity('deed-holder', 'player-deed');
    const houseKey = testIdentity('the-house').pub;
    const w = await loadPage(1, false, 1_000);
    w.doc.transact(() => {
      w.doc.getMap('players').set(owner.pid, { keyB64: owner.pub });
      w.doc.getMap('roomInfo').set('owner', owner.pid);
    });
    const fast = await loadPage(2, true);
    syncTo(w, fast);
    const calls = countWebCrypto();
    const deleg = { v: 1 as const, h: houseKey, k: owner.pub };
    const realSig = owner.sign(roomSignBytes('hkey', '', '', deleg));
    // A flood of delegations signed over another house's bytes, and the
    // real one spelled with a stray bit: none counts.
    w.doc.transact(() => {
      const top = w.doc.getMap('casinoComputed');
      for (let i = 0; i < 30; i++) {
        const junk = testIdentity(`junk-house-${i}`).pub;
        const body = { v: 1 as const, h: junk, k: owner.pub };
        top.set(delegationKey(junk), { ...body, g: owner.sign(roomSignBytes('hkey', '', '', { ...body, h: houseKey })) });
      }
      top.set(delegationKey(houseKey), { ...deleg, g: strayBit(realSig) });
    });
    syncTo(w, fast);
    await until(() => false, 100);
    expect(fast.casino.houseSetUp()).toBe(false);
    expect(calls.verifies).toBeGreaterThan(10);
    // Spelled right, it counts.
    w.doc.transact(() => w.doc.getMap('casinoComputed').set(delegationKey(houseKey), { ...deleg, g: realSig }));
    syncTo(w, fast);
    expect(await until(() => fast.casino.houseSetUp())).toBe(true);
  });
});

