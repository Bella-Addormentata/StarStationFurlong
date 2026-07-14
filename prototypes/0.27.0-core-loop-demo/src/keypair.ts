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

/** Verify a base64url signature over bytes against a base64url public key. */
export function verifyIdentity(pubB64: string, bytes: Uint8Array, sigB64: string): boolean {
  try {
    return ed.verify(b64urlDecode(sigB64), bytes, b64urlDecode(pubB64));
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
