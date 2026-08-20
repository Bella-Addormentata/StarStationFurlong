// keypair.ts tests (#79 P2): recovery-key restore path + per-identity
// clone-vat spawn preference (shape-guard, whole-value LWW, null-delete).
//
// The three invariants the boot flow leans on:
//   1. importRecoveryKey rejects anything that isn't a 32-byte seed. A restore
//      button that ever accepted a garbage string would strand the identity.
//   2. getCloneVatPreference is shape-guarded — any non-shape stored under the
//      key returns null (a hostile writer of localStorage can plant anything).
//   3. setCloneVatPreference is a whole-value LWW write; passing null deletes.
//
// keypair.ts touches localStorage at module load (getSeed lazy-mints on first
// public-key access), so we install an in-memory Storage shim BEFORE importing
// the module and reset it between tests. This keeps the test node-only (no
// jsdom / happy-dom dep) while faithfully exercising the localStorage paths.

import { beforeEach, describe, expect, it } from 'vitest';

// ─── Minimal in-memory Storage shim (mirrors the Web Storage contract we use)
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

// Install before ANY keypair import — the module reads localStorage during its
// first getSeed() call, and the recovery-key/preference APIs touch it too.
(globalThis as any).localStorage = new MemoryStorage();

// Dynamic import AFTER the shim is in place, so keypair.ts binds to it.
const {
  exportRecoveryKey,
  getCloneVatPreference,
  getIdentityPub,
  hasStoredIdentity,
  importRecoveryKey,
  setCloneVatPreference,
} = await import('./keypair');

beforeEach(() => {
  // Fresh in-memory storage each test — recovery-key tests would otherwise
  // leak seeds into the preference tests through the shared getIdentityPub.
  (globalThis as any).localStorage = new MemoryStorage();
});

// ─── importRecoveryKey ───────────────────────────────────────────────────────

describe('keypair.importRecoveryKey — restore-from-backup input validation', () => {
  it('accepts a valid exported seed and returns the derived pubkey', () => {
    // Round-trip: export a real seed (mints one on first access), reset the
    // in-memory store to simulate a fresh install, then import — the pubkey
    // that comes back MUST equal the seed's public key.
    const originalPub = getIdentityPub();
    const recovery = exportRecoveryKey();
    (globalThis as any).localStorage = new MemoryStorage();
    const restoredPub = importRecoveryKey(recovery);
    expect(restoredPub).toBe(originalPub);
    // hasStoredIdentity flips true because importRecoveryKey persists the seed
    // just like getSeed would on first access.
    expect(hasStoredIdentity()).toBe(true);
  });

  it('trims whitespace so a copy-paste with newlines still works', () => {
    // Paste boxes commonly ride a trailing newline; a UX-visible restore must
    // still succeed. The trim is documented on the function.
    const recovery = exportRecoveryKey();
    (globalThis as any).localStorage = new MemoryStorage();
    const restored = importRecoveryKey(`\n  ${recovery}  \n`);
    expect(restored).not.toBeNull();
  });

  it('rejects a non-base64url string', () => {
    // btoa/atob throw on non-b64 input; the guard catches that and returns
    // null instead of poisoning the cached seed.
    expect(importRecoveryKey('this is not a key')).toBeNull();
  });

  it('rejects the empty string', () => {
    // atob('') is 0 bytes; the length gate below catches it, but this locks
    // the empty case in explicitly since a naive paste of nothing must fail.
    expect(importRecoveryKey('')).toBeNull();
  });

  it('rejects a valid-base64 blob of the WRONG length', () => {
    // 31 bytes → not an Ed25519 seed. The length gate is the second line of
    // defence after decode-succeeded.
    const wrong = new Uint8Array(31);
    // base64url encode manually (same alphabet as the module)
    let bin = '';
    for (const b of wrong) bin += String.fromCharCode(b);
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(importRecoveryKey(b64)).toBeNull();
  });

  it('a rejected input MUST NOT overwrite the current identity', () => {
    // Guard against a subtle regression: a failing importRecoveryKey could
    // partially update the cached seed if the guard came AFTER the assignment.
    // We prove the pubkey is unchanged.
    const before = getIdentityPub();
    expect(importRecoveryKey('garbage')).toBeNull();
    const after = getIdentityPub();
    expect(after).toBe(before);
  });
});

// ─── getCloneVatPreference / setCloneVatPreference ──────────────────────────

describe('keypair.getCloneVatPreference — shape-guarded read', () => {
  const pub = 'AAAA1111BBBB2222CCCC3333DDDD4444'; // stand-in pubkey (only used as a map key)

  it('returns null when nothing is stored for that pubkey', () => {
    expect(getCloneVatPreference(pub)).toBeNull();
  });

  it('returns null for a malformed stored value (not JSON)', () => {
    // A hostile / stale writer could plant raw text under the key.
    localStorage.setItem(`ssf-spawn:${pub}`, 'not-json');
    expect(getCloneVatPreference(pub)).toBeNull();
  });

  it('returns null for JSON that lacks the required fields', () => {
    // Wrong shape → the guard rejects and the caller falls back to the shared
    // station default (which is the safe boot target).
    localStorage.setItem(`ssf-spawn:${pub}`, JSON.stringify({ nope: true }));
    expect(getCloneVatPreference(pub)).toBeNull();
    localStorage.setItem(`ssf-spawn:${pub}`, JSON.stringify({ roomId: 'x' })); // missing key
    expect(getCloneVatPreference(pub)).toBeNull();
    localStorage.setItem(`ssf-spawn:${pub}`, JSON.stringify({ roomKeyB64: 'y' })); // missing id
    expect(getCloneVatPreference(pub)).toBeNull();
  });

  it('returns null for wrong-typed fields (defence-in-depth)', () => {
    // A number under a string field must be treated as malformed, not coerced.
    localStorage.setItem(
      `ssf-spawn:${pub}`,
      JSON.stringify({ roomId: 42, roomKeyB64: 'k' }),
    );
    expect(getCloneVatPreference(pub)).toBeNull();
  });

  it('returns null for empty string fields (the gate rejects empty ids/keys)', () => {
    localStorage.setItem(
      `ssf-spawn:${pub}`,
      JSON.stringify({ roomId: '', roomKeyB64: 'k' }),
    );
    expect(getCloneVatPreference(pub)).toBeNull();
    localStorage.setItem(
      `ssf-spawn:${pub}`,
      JSON.stringify({ roomId: 'r', roomKeyB64: '' }),
    );
    expect(getCloneVatPreference(pub)).toBeNull();
  });

  it('returns null when pubB64 is empty (defensive on caller shape)', () => {
    expect(getCloneVatPreference('')).toBeNull();
  });

  it('reads back a well-shaped stored value verbatim', () => {
    // The shape reads through unchanged.
    const pref = { roomId: 'room-abc', roomKeyB64: 'k-def' };
    localStorage.setItem(`ssf-spawn:${pub}`, JSON.stringify(pref));
    expect(getCloneVatPreference(pub)).toEqual(pref);
  });

  it('strips extra fields on read (returns only the shape)', () => {
    // A future writer that plants extra keys must not leak through the reader
    // — the boot flow relies on a minimal, predictable object shape.
    localStorage.setItem(
      `ssf-spawn:${pub}`,
      JSON.stringify({ roomId: 'r', roomKeyB64: 'k', evil: 'x' }),
    );
    const out = getCloneVatPreference(pub);
    expect(out).toEqual({ roomId: 'r', roomKeyB64: 'k' });
    expect((out as any).evil).toBeUndefined();
  });
});

describe('keypair.setCloneVatPreference — whole-value LWW write + null-delete', () => {
  const pub = 'AAAA1111BBBB2222CCCC3333DDDD4444';

  it('round-trips through get for a valid preference', () => {
    const pref = { roomId: 'room-x', roomKeyB64: 'key-x' };
    setCloneVatPreference(pub, pref);
    expect(getCloneVatPreference(pub)).toEqual(pref);
  });

  it('is a whole-value REPLACE — a second write clobbers the first', () => {
    // LWW discipline (mirrors the room-doc whole-value convention).
    setCloneVatPreference(pub, { roomId: 'first', roomKeyB64: 'k1' });
    setCloneVatPreference(pub, { roomId: 'second', roomKeyB64: 'k2' });
    expect(getCloneVatPreference(pub)).toEqual({ roomId: 'second', roomKeyB64: 'k2' });
  });

  it('null deletes the record entirely (not just clears fields)', () => {
    setCloneVatPreference(pub, { roomId: 'x', roomKeyB64: 'k' });
    setCloneVatPreference(pub, null);
    expect(getCloneVatPreference(pub)).toBeNull();
    // localStorage should not carry a leftover empty string.
    expect(localStorage.getItem(`ssf-spawn:${pub}`)).toBeNull();
  });

  it('silently rejects a malformed input (does not corrupt the record)', () => {
    // A stale caller passing a half-formed pref must NOT wipe / poison the
    // stored good value.
    setCloneVatPreference(pub, { roomId: 'good', roomKeyB64: 'k' });
    setCloneVatPreference(pub, { roomId: '', roomKeyB64: 'k' } as any);
    expect(getCloneVatPreference(pub)).toEqual({ roomId: 'good', roomKeyB64: 'k' });
  });

  it('scopes writes to the pubkey — different identities have independent preferences', () => {
    const other = 'ZZZZ9999YYYY8888XXXX7777WWWW6666';
    setCloneVatPreference(pub, { roomId: 'mine', roomKeyB64: 'k1' });
    setCloneVatPreference(other, { roomId: 'theirs', roomKeyB64: 'k2' });
    expect(getCloneVatPreference(pub)).toEqual({ roomId: 'mine', roomKeyB64: 'k1' });
    expect(getCloneVatPreference(other)).toEqual({ roomId: 'theirs', roomKeyB64: 'k2' });
  });

  it('no-ops when pubB64 is empty (defensive on caller shape)', () => {
    // The boot flow could conceivably call this before getIdentityPub()
    // returned — the write must not blow up or plant garbage.
    setCloneVatPreference('', { roomId: 'r', roomKeyB64: 'k' });
    // Nothing under an empty-key namespace.
    expect(localStorage.getItem('ssf-spawn:')).toBeNull();
  });
});
