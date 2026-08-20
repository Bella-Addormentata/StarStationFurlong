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
 *
 * The recovery key IS the private identity: it is stored ONLY here (via
 * localStorage, exactly like a returning install's already-persisted seed).
 * Callers must NEVER log it, transmit it, or write it anywhere else — treat
 * it exactly as the pre-existing seed handling in this module.
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
 * 🧬 Per-identity CLONE-VAT SPAWN PREFERENCE (#79 P2/P4).
 *
 * The room a given identity wants to boot back into — their "clone-vat
 * preference" in owner-speak. Distinct from the install-scoped `ssf-last-room`
 * (which is keyed to the local install, not the identity): a restore-from-
 * backup on a fresh install lands with no ssf-last-room but IS the same
 * identity, and we want them to arrive at their preference if we know it.
 *
 * Storage: localStorage keyed by identity public key. LOCAL-ONLY (never
 * networked): if a mesh-published preference lands later (Phase 2 presence),
 * that lookup is layered on top of this without changing the shape here.
 *
 * Shape: a minimal `{ roomId, roomKeyB64 }` — enough to key the boot fallback
 * without embedding the identity's ephemeral wtUrl/certHash (loopback cert
 * drift is the whole reason ssf-last-room is skipped for `home-*` rooms). The
 * bootstrap networking rebuilds the WT half from the LIVE local node.
 *
 * KEY BOUNDARY: this stores a ROOM POINTER only — never the recovery/private
 * key material. The record is a plain, replay-safe hint (any writer could
 * plant it); the room doc's own owner/policy checks remain the authority.
 */
export interface CloneVatPreference {
  roomId: string;
  /** Base64url of 32 raw bytes — the room-doc encryption key. */
  roomKeyB64: string;
}

/** Storage key namespace for per-identity spawn preferences. */
const SPAWN_PREF_KEY_PREFIX = 'ssf-spawn:';

/** Compose the localStorage key for a given identity pubkey. */
function spawnPrefStorageKey(pubB64: string): string {
  return `${SPAWN_PREF_KEY_PREFIX}${pubB64}`;
}

/**
 * Shape-guarded read: rejects malformed / non-shaped stored data.
 * A hostile writer of localStorage could plant anything; the reader must
 * treat every stored value as untrusted data.
 */
function isCloneVatPreference(v: unknown): v is CloneVatPreference {
  if (!v || typeof v !== 'object') return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.roomId !== 'string' || rec.roomId.length === 0) return false;
  if (typeof rec.roomKeyB64 !== 'string' || rec.roomKeyB64.length === 0) return false;
  return true;
}

/**
 * Fetch the current identity's clone-vat preference from local storage.
 * Returns null when unset, absent, or malformed — the caller should fall back
 * to the shared station or the install's per-install home in that case.
 *
 * `pubB64` MUST be a base64url identity pubkey (from `getIdentityPub` or a
 * restore return value); it is trusted to be a stable, safe map key.
 */
export function getCloneVatPreference(pubB64: string): CloneVatPreference | null {
  if (typeof pubB64 !== 'string' || pubB64.length === 0) return null;
  try {
    const raw = localStorage.getItem(spawnPrefStorageKey(pubB64));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isCloneVatPreference(parsed)) return null;
    return { roomId: parsed.roomId, roomKeyB64: parsed.roomKeyB64 };
  } catch {
    return null;
  }
}

/**
 * Persist the current identity's clone-vat preference. A whole-value WRITE
 * (no partial merges) — mirrors the whole-value-LWW discipline the room docs
 * use, so an unauthenticated reader is never surprised by a half-updated
 * record. `pref === null` deletes the record.
 */
export function setCloneVatPreference(
  pubB64: string,
  pref: CloneVatPreference | null,
): void {
  if (typeof pubB64 !== 'string' || pubB64.length === 0) return;
  const key = spawnPrefStorageKey(pubB64);
  try {
    if (pref === null) {
      localStorage.removeItem(key);
      return;
    }
    if (!isCloneVatPreference(pref)) return; // silently reject malformed input
    localStorage.setItem(
      key,
      JSON.stringify({ roomId: pref.roomId, roomKeyB64: pref.roomKeyB64 }),
    );
  } catch {
    /* privacy mode / quota — preference is best-effort */
  }
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
      try { return ed.verify(sigBytes, bytes, authorBytes); } catch { return false; }
    },
  };
}
