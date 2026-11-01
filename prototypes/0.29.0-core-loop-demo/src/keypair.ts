/**
 * 🔑 Cryptographic identity keypair (keyed-identity Slice 1)
 *
 * Every install mints a 32-byte Ed25519 seed, persisted in localStorage beside
 * the legacy UUID player id (getPlayerId, identity.ts) — ADDITIVE, no wire
 * change yet. The PUBLIC KEY is your durable cryptographic identity: the
 * sign/verify-before-apply seam (Slice 2) and signed contact cards (Slice 3)
 * build on it, and the players map now carries a self-signed name↔key cert so
 * a display name can be cryptographically tied to a key.
 *
 * The seed is EXPORTABLE — a recovery credential you alone hold. The sovereign
 * "no recovery service" stance means there is no reset; that is also why we use
 * @noble (a dependency-free, in-browser, auditable lib) and NOT a WebCrypto
 * non-extractable key, which could never be backed up.
 *
 * See brainstorming/keyed-identity-contacts-plan.md (Slice 1).
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Enable @noble's synchronous API (sign/verify/getPublicKey) by wiring the hash
// once — the self-cert write below is simpler synchronous. Async variants exist.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const SEED_STORAGE_KEY = 'ssf-identity-seed'; // base64url of the 32-byte seed
let cachedSeed: Uint8Array | null = null;
let cachedPub: Uint8Array | null = null;

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Load or mint the 32-byte seed (localStorage, privacy-mode fallback —
 *  mirrors getOrCreateRoomKeyB64 / getPlayerId). Minted once, cached. */
function getSeed(): Uint8Array {
  if (cachedSeed) return cachedSeed;
  try {
    const stored = localStorage.getItem(SEED_STORAGE_KEY);
    if (stored) {
      const seed = b64urlDecode(stored);
      if (seed.length === 32) { cachedSeed = seed; return seed; }
    }
  } catch { /* privacy mode — fall through to a session-only seed */ }
  const seed = ed.etc.randomBytes(32);
  cachedSeed = seed;
  try { localStorage.setItem(SEED_STORAGE_KEY, b64urlEncode(seed)); } catch { /* session-only */ }
  return seed;
}

function getPubBytes(): Uint8Array {
  if (cachedPub) return cachedPub;
  cachedPub = ed.getPublicKey(getSeed());
  return cachedPub;
}

/** Our durable cryptographic identity — base64url of the 32-byte public key. */
export function getIdentityPub(): string {
  return b64urlEncode(getPubBytes());
}

/**
 * 🆕 #79: is there ALREADY a stored identity seed? True ⇒ a returning install.
 * READ-ONLY — never mints (unlike getIdentityPub), so the boot can detect a
 * genuine first run before anything lazily creates the seed. In privacy mode
 * (no localStorage) we can't tell, so treat it as "not stored" (first run).
 */
export function hasStoredIdentity(): boolean {
  if (cachedSeed) return true;
  try {
    return localStorage.getItem(SEED_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Short human fingerprint of our identity (first 8 hex chars of the pubkey). */
export function getIdentityFingerprint(): string {
  return ed.etc.bytesToHex(getPubBytes()).slice(0, 8);
}

/** Fingerprint any base64url public key (for showing other people's keys). */
export function fingerprintOf(pubB64: string): string {
  try { return ed.etc.bytesToHex(b64urlDecode(pubB64)).slice(0, 8); } catch { return '????????'; }
}

/** Sign bytes with our identity key → base64url signature. */
export function signIdentity(bytes: Uint8Array): string {
  return b64urlEncode(ed.sign(bytes, getSeed()));
}

/** Verify a base64url signature over bytes against a base64url public key.
 *  Refuses what verifyIdentityStrict refuses about the points: a small-order
 *  public key (noble's `zip215: false`; such a key's "signatures" verify any
 *  message, so anyone could sign as it) and an identity R (identityR: one
 *  signature that verifies every message under its key). It still forgives
 *  the spelling (b64urlDecode reads padded or stray-bit base64 as the same
 *  bytes); records that hash their spelling use verifyIdentityStrict. */
export function verifyIdentity(pubB64: string, bytes: Uint8Array, sigB64: string): boolean {
  try {
    const sig = b64urlDecode(sigB64);
    return !identityR(sig) && ed.verify(sig, bytes, b64urlDecode(pubB64), { zip215: false });
  } catch {
    return false;
  }
}

/** Public keys verifyIdentityStrict has decoded, by their base64url string:
 *  the 32 bytes, or null for a string that isn't a key's one encoding. Kept
 *  to MAX_STRICT_PUBS, oldest dropped first: a room holds a few dozen keys,
 *  and a page fed junk keys must not grow without bound. */
const strictPubs = new Map<string, Uint8Array | null>();
const MAX_STRICT_PUBS = 1_024;

/** The bytes `s` encodes, only if `s` is exactly how b64urlEncode writes
 *  `len` bytes. atob forgives a lot (padding, whitespace, the +/ alphabet
 *  after the swap, stray low bits in the last character), so one key or
 *  signature could be spelled several ways; computed tables hash the
 *  spelling into the record, so only one spelling may verify. */
function strictB64(s: string, len: number): Uint8Array | null {
  try {
    const bytes = b64urlDecode(s);
    return bytes.length === len && b64urlEncode(bytes) === s ? bytes : null;
  } catch {
    return null; // not base64 at all
  }
}

/** True when a signature's R (its first 32 bytes) is the identity point,
 *  01 00…00: the one spelling of it that strict decoding accepts. noble
 *  2.3.0's verify hashes R‖A‖M inside a try that R.toBytes() escapes on the
 *  identity, leaving k = SHA-512("") with no message in it, so a key's owner
 *  could make ONE signature that verifies every message (any record, room,
 *  table or incarnation). No honest signer ever produces this R. */
function identityR(sig: Uint8Array): boolean {
  if (sig[0] !== 1) return false;
  for (let i = 1; i < 32; i++) if (sig[i] !== 0) return false;
  return true;
}

/**
 * 🧮 verifyIdentity, but with ONE answer for every page
 * and every encoding — what the computed-table fold (computedFold.ts) uses.
 * The key and the signature must be the canonical base64url of 32 and 64
 * bytes, R may not be the identity point (identityR), and noble checks with
 * `zip215: false`: a strict point decoding, no small-order public key (whose
 * "signatures" verify any message), S < L, and the cofactored equation.
 * That last part means a signature whose R carries a torsion component
 * still passes; it does so on every page that runs this pinned noble
 * version (package.json), so pages agree. The fast path (fastStrictCheck,
 * WebCrypto) makes the same byte checks first, since WebCrypto accepts an
 * identity R whose S fits the real k, which noble and this refuse.
 * Any throw is a false. verifyIdentity makes the same point checks but
 * forgives the spelling.
 */
export function verifyIdentityStrict(pubB64: string, bytes: Uint8Array, sigB64: string): boolean {
  try {
    if (typeof pubB64 !== 'string' || typeof sigB64 !== 'string') return false;
    let pub = strictPubs.get(pubB64);
    if (pub === undefined) {
      pub = strictB64(pubB64, 32);
      strictPubs.set(pubB64, pub);
      while (strictPubs.size > MAX_STRICT_PUBS) strictPubs.delete(strictPubs.keys().next().value as string);
    }
    const sig = strictB64(sigB64, 64);
    if (!pub || !sig || identityR(sig)) return false;
    return ed.verify(sig, bytes, pub, { zip215: false });
  } catch {
    return false;
  }
}

// ── 🏎 The fast path: WebCrypto under verifyIdentityStrict's byte checks ─────
//
// noble's verify is about 1.7 ms of the page's own time; WebCrypto's Ed25519
// is about 0.05 to 0.3 ms and runs off the page's thread, but it doesn't say
// what verifyIdentityStrict says for every signature: it uses the
// cofactorless equation ([S]B = R + [k]A), so it refuses a signature whose R
// or key carries a torsion component that noble's cofactored one forgives,
// and some implementations accept an identity R whose S fits the real k, or
// spellings and points strict decoding refuses. So fastStrictCheck makes
// every check verifyIdentityStrict makes besides the equation itself (the one
// spelling, no identity R, strict decoding of the key and of R, no
// small-order key, S < L) and trusts only WebCrypto's yes: an equation that
// holds without the cofactor holds with it, so a yes is noble's yes. Its no
// says nothing, and the caller runs verifyIdentityStrict. Answers are the
// same on every page, whichever path a page took.

/** Off until enableFastStrictChecks (the app's boot); specs keep noble alone. */
let fastState: 'off' | 'testing' | 'on' | 'broken' = 'off';
/** Each key's WebCrypto handle (null: WebCrypto wouldn't take it), by base64url. */
const fastKeys = new Map<string, Promise<CryptoKey | null>>();
/** Keys whose strict decoding was made: true when it decodes and isn't of small order. */
const strictPoints = new Map<string, boolean>();
/** A WebCrypto answer that hasn't come in this long counts as no answer. */
const FAST_TIMEOUT_MS = 2_000;

function subtleOf(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && c.subtle && typeof c.subtle.verify === 'function' ? c.subtle : null;
}

function fastKeyOf(subtle: SubtleCrypto, pubB64: string, pub: Uint8Array): Promise<CryptoKey | null> {
  let key = fastKeys.get(pubB64);
  if (!key) {
    key = subtle.importKey('raw', pub as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']).catch(() => null);
    fastKeys.set(pubB64, key);
    while (fastKeys.size > MAX_STRICT_PUBS) fastKeys.delete(fastKeys.keys().next().value as string);
  }
  return key;
}

/** WebCrypto's answer (true or false), or undefined for no answer: a throw,
 *  a key it wouldn't import, or a wait past FAST_TIMEOUT_MS. */
async function subtleVerify(subtle: SubtleCrypto, pubB64: string, pub: Uint8Array, bytes: Uint8Array, sig: Uint8Array): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), FAST_TIMEOUT_MS); });
  try {
    const run = (async () => {
      const key = await fastKeyOf(subtle, pubB64, pub);
      if (!key) return undefined;
      return (await subtle.verify({ name: 'Ed25519' }, key, sig as Uint8Array<ArrayBuffer>, bytes as Uint8Array<ArrayBuffer>)) === true;
    })().catch(() => undefined);
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The page's WebCrypto must say yes to a good signature and no to bad ones
 *  before its yes counts: an implementation that says yes to everything
 *  would otherwise let forgeries in. 'on' when it does; 'broken' when it has
 *  no Ed25519 or gives a wrong answer (never asked again on this load);
 *  'off' when an answer didn't come (a page too busy for 2 s, say): the next
 *  enableFastStrictChecks tries again. */
async function fastSelfTest(subtle: SubtleCrypto): Promise<'on' | 'off' | 'broken'> {
  try {
    const seed = new Uint8Array(32).fill(0x5c);
    const pub = ed.getPublicKey(seed);
    const pubB64 = b64urlEncode(pub);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = await Promise.race([
      fastKeyOf(subtle, pubB64, pub),
      new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), FAST_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (key === 'late') return 'off';
    if (!key) return 'broken'; // no Ed25519 here
    const msg = new TextEncoder().encode('ssf-fast-verify-self-test-v1');
    const sig = ed.sign(msg, seed);
    const otherMsg = new TextEncoder().encode('ssf-fast-verify-self-test-v2');
    const badSig = sig.slice();
    badSig[40] ^= 1;
    const answers = await Promise.all([
      subtleVerify(subtle, pubB64, pub, msg, sig),
      subtleVerify(subtle, pubB64, pub, otherMsg, sig),
      subtleVerify(subtle, pubB64, pub, msg, badSig),
    ]);
    const [good, wrongMsg, wrongSig] = answers;
    if (good === true && wrongMsg === false && wrongSig === false) return 'on';
    return answers.includes(undefined) && good !== false && wrongMsg !== true && wrongSig !== true ? 'off' : 'broken';
  } catch {
    return 'broken';
  }
}

/** The self-test running, if one is. */
let fastTesting: Promise<boolean> | null = null;

/** 🏎 Let fastStrictCheck use the page's WebCrypto once a self-test passes
 *  (fastStrictChecksOn); a page without Ed25519 in WebCrypto stays on noble
 *  alone. Resolves to whether the fast path is on. `false` turns it off
 *  again (specs). */
export function enableFastStrictChecks(on = true): Promise<boolean> {
  if (!on) {
    fastState = 'off';
    fastTesting = null;
    fastKeys.clear();
    return Promise.resolve(false);
  }
  if (fastState === 'on') return Promise.resolve(true);
  if (fastState === 'broken') return Promise.resolve(false);
  if (fastState === 'testing' && fastTesting) return fastTesting;
  const subtle = subtleOf();
  if (!subtle) {
    fastState = 'broken';
    return Promise.resolve(false);
  }
  fastState = 'testing';
  const testing: Promise<boolean> = fastSelfTest(subtle).then((got) => {
    if (fastTesting !== testing) return fastState === 'on'; // turned off meanwhile
    fastTesting = null;
    fastState = got;
    if (got !== 'on') fastKeys.clear();
    return got === 'on';
  });
  fastTesting = testing;
  return testing;
}

/** The fast path is on: fastStrictCheck can answer. */
export function fastStrictChecksOn(): boolean {
  return fastState === 'on';
}

/** Little-endian bytes as a number (a signature's S). */
function leNumber(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

/** Key `pubB64` (its 32 bytes `pub`) decodes strictly and isn't of small
 *  order: noble's own checks of it (zip215: false), made once per key. */
function strictPointOk(pubB64: string, pub: Uint8Array): boolean {
  let ok = strictPoints.get(pubB64);
  if (ok === undefined) {
    try {
      ok = !ed.Point.fromBytes(pub, false).isSmallOrder();
    } catch {
      ok = false;
    }
    strictPoints.set(pubB64, ok);
    while (strictPoints.size > MAX_STRICT_PUBS) strictPoints.delete(strictPoints.keys().next().value as string);
  }
  return ok;
}

/**
 * 🏎 verifyIdentityStrict's answer by WebCrypto, where it can be had:
 * - `null`: the fast path is off (enableFastStrictChecks, its self-test);
 * - `false`: the byte checks refuse it, as verifyIdentityStrict does (the
 *   spelling, an identity R, a key or R that doesn't decode strictly, a key
 *   of small order, S >= L), at once;
 * - a Promise of `true`: verifyIdentityStrict says true; of `undefined`:
 *   WebCrypto didn't say yes (a torsion component, a WebCrypto that can't,
 *   a wait past 2 s), so only verifyIdentityStrict can say.
 * The byte checks cost about 0.1 ms here (R's strict decoding; the key's is
 * kept). `bytes` must not change until the answer is in.
 */
export function fastStrictCheck(pubB64: string, bytes: Uint8Array, sigB64: string): false | null | Promise<true | undefined> {
  if (fastState !== 'on') return null;
  const subtle = subtleOf();
  if (!subtle) return null;
  try {
    if (typeof pubB64 !== 'string' || typeof sigB64 !== 'string') return false;
    let pub = strictPubs.get(pubB64);
    if (pub === undefined) {
      pub = strictB64(pubB64, 32);
      strictPubs.set(pubB64, pub);
      while (strictPubs.size > MAX_STRICT_PUBS) strictPubs.delete(strictPubs.keys().next().value as string);
    }
    const sig = strictB64(sigB64, 64);
    if (!pub || !sig || identityR(sig) || !strictPointOk(pubB64, pub)) return false;
    ed.Point.fromBytes(sig.subarray(0, 32), false); // R decodes strictly (throws otherwise)
    if (leNumber(sig.subarray(32, 64)) >= ed.CURVE.n) return false; // S < L
    return subtleVerify(subtle, pubB64, pub, bytes, sig).then((ok) => (ok === true ? true : undefined));
  } catch {
    return false;
  }
}

/** Canonical bytes binding a display name to our key — what the self-cert signs
 *  (`ssf-id-cert:v1:<name>:<pubB64>`). Domain-tagged + versioned so it can't be
 *  replayed as a different message kind. */
export function nameCertBytes(name: string, pubB64: string): Uint8Array {
  return new TextEncoder().encode(`ssf-id-cert:v1:${name}:${pubB64}`);
}

/** Self-signed cert that this identity key claims `name` (base64url sig). */
export function signNameCert(name: string): string {
  return signIdentity(nameCertBytes(name, getIdentityPub()));
}

/** Verify a name↔key self-cert (peer-supplied — untrusted). */
export function verifyNameCert(name: string, pubB64: string, sigB64: string): boolean {
  return verifyIdentity(pubB64, nameCertBytes(name, pubB64), sigB64);
}

/**
 * Export the seed as a recovery credential (base64url). The user alone holds
 * this — losing it loses the identity (sovereign: no recovery service). Slice 3
 * surfaces it prominently in Contacts; a BIP39 24-word phrase is a later polish
 * (adds @scure/bip39).
 */
export function exportRecoveryKey(): string {
  return b64urlEncode(getSeed());
}

/**
 * Restore the identity from an exported recovery credential. Returns the new
 * public key (base64url) on success, or null if the input isn't a 32-byte seed.
 */
export function importRecoveryKey(recovery: string): string | null {
  let seed: Uint8Array;
  try { seed = b64urlDecode(recovery.trim()); } catch { return null; }
  if (seed.length !== 32) return null;
  cachedSeed = seed;
  cachedPub = null;
  try { localStorage.setItem(SEED_STORAGE_KEY, b64urlEncode(seed)); } catch { /* session-only */ }
  return getIdentityPub();
}

/**
 * The identity signer YjsSync wires in for the Slice-2 sign/verify-before-apply
 * seam. Operates on RAW bytes (YjsSync owns the base64 on the wire): authorPub
 * is our 32-byte pubkey, sign signs the canonical envelope bytes, verify checks
 * a peer's signature. Live-reads the seed each call so an identity restore is
 * reflected without re-wiring.
 */
export function ysyncSigner(): {
  authorPub: () => Uint8Array;
  sign: (bytes: Uint8Array) => Promise<Uint8Array>;
  verify: (authorBytes: Uint8Array, bytes: Uint8Array, sigBytes: Uint8Array) => boolean;
} {
  return {
    authorPub: () => getPubBytes(),
    sign: (bytes: Uint8Array) => Promise.resolve(ed.sign(bytes, getSeed())),
    verify: (authorBytes: Uint8Array, bytes: Uint8Array, sigBytes: Uint8Array): boolean => {
      // The same point checks as verifyIdentity: no small-order author key, no identity R.
      try { return !identityR(sigBytes) && ed.verify(sigBytes, bytes, authorBytes, { zip215: false }); } catch { return false; }
    },
  };
}
