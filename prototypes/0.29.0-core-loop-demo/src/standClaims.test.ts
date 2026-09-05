/**
 * standClaims.ts tests (#76) — the PURE engine.
 *
 * Identities are opaque strings here: the engine compares `pub`s and clocks
 * and never verifies a signature. Signature verification, the Y.Map binding
 * and the memo cache live in standsDoc.ts and are exercised with real
 * Ed25519 keys in standsDoc.test.ts. What this file pins:
 *   • shape guard — including the signed-shape rules (non-empty sig,
 *     safe-integer `at`, legacy { playerId } refused)
 *   • signature bytes — deterministic, `sig`-independent, and sensitive to
 *     every field a forger would want to lift (room, slot, pub, at)
 *   • TTL expiry + heartbeat renewal + bounded clock skew
 *   • canPlayerClaim ownership rule (never displace a live peer)
 *   • pickStandForWalkup tier order (mine → open civilian → reserved fallback)
 *   • shouldReleaseSlot ownership guard
 *   • findExpiredClaims (stale AND not online)
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  STAND_CLAIM_DOMAIN,
  STAND_CLAIM_HEARTBEAT_MS,
  STAND_CLAIM_MAX_SKEW_MS,
  STAND_CLAIM_REAP_MS,
  STAND_CLAIM_TTL_MS,
  canPlayerClaim,
  findExpiredClaims,
  isClaimActive,
  isStandClaim,
  pickStandForWalkup,
  shouldReleaseSlot,
  standClaimSignatureBytes,
} from './standClaims';
import type { StandClaim } from './standClaims';
import { canonicalEncode } from './treasuryTypes';
import type { StandSlot } from './furniture';

const T0 = 1_700_000_000_000;
const ALICE = 'alice-pub';
const BOB = 'bob-pub';
const OWNER = 'owner-pub';

/** Engine-level claim literal — the placeholder sig is never verified here. */
const claim = (pub: string, at: number): StandClaim => ({
  pub,
  at,
  sig: 'sig-not-verified-by-the-pure-engine',
});

const slot = (id: string, role?: StandSlot['role']): StandSlot => ({
  id,
  front: { x: 0, z: 0 },
  faceAngle: 0,
  role,
});

describe('isStandClaim (shape guard)', () => {
  it('accepts a well-formed claim', () => {
    expect(isStandClaim(claim(ALICE, T0))).toBe(true);
  });

  it('rejects null, primitives and arrays', () => {
    expect(isStandClaim(null)).toBe(false);
    expect(isStandClaim(undefined)).toBe(false);
    expect(isStandClaim('alice')).toBe(false);
    expect(isStandClaim(42)).toBe(false);
    expect(isStandClaim([ALICE, T0])).toBe(false);
  });

  it('rejects a legacy unsigned { playerId, at } record', () => {
    expect(isStandClaim({ playerId: 'alice-uuid', at: T0 })).toBe(false);
  });

  it('rejects a missing, empty or non-string pub', () => {
    expect(isStandClaim({ at: T0, sig: 's' })).toBe(false);
    expect(isStandClaim({ pub: '', at: T0, sig: 's' })).toBe(false);
    expect(isStandClaim({ pub: 7, at: T0, sig: 's' })).toBe(false);
  });

  it('rejects a missing, empty or non-string sig', () => {
    expect(isStandClaim({ pub: ALICE, at: T0 })).toBe(false);
    expect(isStandClaim({ pub: ALICE, at: T0, sig: '' })).toBe(false);
    expect(isStandClaim({ pub: ALICE, at: T0, sig: 7 })).toBe(false);
  });

  it('rejects a non-number, non-finite, fractional or unsafe `at`', () => {
    expect(isStandClaim({ pub: ALICE, at: String(T0), sig: 's' })).toBe(false);
    expect(isStandClaim({ pub: ALICE, at: NaN, sig: 's' })).toBe(false);
    expect(isStandClaim({ pub: ALICE, at: Infinity, sig: 's' })).toBe(false);
    // canonicalEncode refuses these — the guard keeps the read path throw-free.
    expect(isStandClaim({ pub: ALICE, at: T0 + 0.5, sig: 's' })).toBe(false);
    expect(isStandClaim({ pub: ALICE, at: 2 ** 53, sig: 's' })).toBe(false);
  });

  it('rejects a planted Y.Map (typeof "object" but not a plain record)', () => {
    const doc = new Y.Doc();
    const hostile = doc.getMap('hostile');
    hostile.set('pub', ALICE);
    hostile.set('at', T0);
    hostile.set('sig', 'x');
    expect(isStandClaim(hostile)).toBe(false);
  });
});

describe('standClaimSignatureBytes', () => {
  it('uses the ssf-stand-claim:v1 domain tag', () => {
    expect(STAND_CLAIM_DOMAIN).toBe('ssf-stand-claim:v1');
  });

  it('is exactly canonicalEncode over { domain, roomId, slotId, claim: { pub, at } }', () => {
    const bytes = standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: T0 });
    const expected = canonicalEncode({
      domain: STAND_CLAIM_DOMAIN,
      roomId: 'room-a',
      slotId: 'tbl-1:s0',
      claim: { pub: ALICE, at: T0 },
    });
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('is deterministic and ignores `sig` on the input', () => {
    const a = standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: T0 });
    const b = standClaimSignatureBytes('room-a', 'tbl-1:s0', claim(ALICE, T0));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('changes when the room, slot, pub or at changes (no lift is possible)', () => {
    const base = Array.from(standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: T0 }));
    expect(Array.from(standClaimSignatureBytes('room-b', 'tbl-1:s0', { pub: ALICE, at: T0 }))).not.toEqual(base);
    expect(Array.from(standClaimSignatureBytes('room-a', 'tbl-1:s1', { pub: ALICE, at: T0 }))).not.toEqual(base);
    expect(Array.from(standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: BOB, at: T0 }))).not.toEqual(base);
    expect(Array.from(standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: T0 + 1 }))).not.toEqual(base);
  });

  it('throws on a non-integer `at` (the encoder rule isStandClaim pins up front)', () => {
    expect(() => standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: T0 + 0.5 })).toThrow();
    expect(() => standClaimSignatureBytes('room-a', 'tbl-1:s0', { pub: ALICE, at: 2 ** 53 })).toThrow();
  });
});

describe('isClaimActive (TTL + heartbeat)', () => {
  it('is active immediately after write', () => {
    expect(isClaimActive(claim(ALICE, T0), T0)).toBe(true);
  });

  it('is active just before the TTL elapses', () => {
    expect(isClaimActive(claim(ALICE, T0), T0 + STAND_CLAIM_TTL_MS - 1)).toBe(true);
  });

  it('expires exactly at the TTL boundary', () => {
    expect(isClaimActive(claim(ALICE, T0), T0 + STAND_CLAIM_TTL_MS)).toBe(false);
  });

  it('survives every heartbeat within the TTL (renewal semantics)', () => {
    // Simulate three heartbeat renewals: each rewrites `at`. The claim must
    // still be active if the last renewal is under a TTL ago.
    let c = claim(ALICE, T0);
    let now = T0;
    for (let i = 0; i < 3; i += 1) {
      now += STAND_CLAIM_HEARTBEAT_MS;
      expect(isClaimActive(c, now)).toBe(true);
      c = claim(ALICE, now);
    }
    // No renewal for a full TTL → expired.
    expect(isClaimActive(c, now + STAND_CLAIM_TTL_MS)).toBe(false);
  });

  it('tolerates modest clock skew (claim slightly in the future)', () => {
    expect(isClaimActive(claim(ALICE, T0 + 2_000), T0)).toBe(true);
  });

  it('refuses a claim dated beyond the skew bound (audit #1: no permanently-active claim)', () => {
    expect(isClaimActive(claim(ALICE, T0 + STAND_CLAIM_MAX_SKEW_MS), T0)).toBe(true);
    expect(isClaimActive(claim(ALICE, T0 + STAND_CLAIM_MAX_SKEW_MS + 1), T0)).toBe(false);
    expect(isClaimActive(claim(ALICE, T0 + 1e12), T0)).toBe(false);
  });

  it('the heartbeat/reap constants are ordered so a heartbeat always beats the TTL', () => {
    // 3 heartbeats before TTL → a laggy transport gets ≥2 retries.
    expect(STAND_CLAIM_HEARTBEAT_MS * 3).toBeLessThanOrEqual(STAND_CLAIM_TTL_MS);
    expect(STAND_CLAIM_REAP_MS).toBeLessThan(STAND_CLAIM_TTL_MS);
  });
});

describe('canPlayerClaim (ownership rule)', () => {
  it('allows a claim on an empty slot', () => {
    expect(canPlayerClaim(null, ALICE, T0)).toBe(true);
  });

  it('allows the holder to renew (heartbeat)', () => {
    expect(canPlayerClaim(claim(ALICE, T0), ALICE, T0 + 1_000)).toBe(true);
  });

  it('refuses a live claim from another identity', () => {
    expect(canPlayerClaim(claim(ALICE, T0), BOB, T0 + 1_000)).toBe(false);
  });

  it('lets anybody claim a stale slot (holder crashed)', () => {
    expect(canPlayerClaim(claim(ALICE, T0), BOB, T0 + STAND_CLAIM_TTL_MS + 1)).toBe(true);
  });

  it('lets another identity reclaim a far-future (skew-bounded) claim', () => {
    // A hostile `at` used to freeze a slot forever; now it reads as stale.
    expect(canPlayerClaim(claim(ALICE, T0 + 1e12), BOB, T0)).toBe(true);
  });
});

describe('pickStandForWalkup (tier order)', () => {
  const s0 = slot('tbl-1:s0');
  const s1 = slot('tbl-1:s1');
  const s2 = slot('tbl-1:s2');
  const wheel = slot('tbl-1:s3', 'wheelHead');
  const allSlots = [s0, s1, s2, wheel];

  it('returns every open civilian slot when nothing is claimed', () => {
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims: new Map(),
      pub: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s0', 'tbl-1:s1', 'tbl-1:s2']);
  });

  it('puts the identity\'s own active claim first (resume)', () => {
    const claims = new Map<string, StandClaim>([['tbl-1:s2', claim(ALICE, T0)]]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: ALICE,
      now: T0 + 1_000,
      canOperateReserved: false,
    });
    expect(picked[0]!.id).toBe('tbl-1:s2');
  });

  it('excludes slots actively held by another identity', () => {
    const claims = new Map<string, StandClaim>([
      ['tbl-1:s0', claim(BOB, T0)],
      ['tbl-1:s1', claim(BOB, T0)],
    ]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: ALICE,
      now: T0 + 1_000,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s2']);
  });

  it('re-includes a slot whose claim has gone stale', () => {
    const claims = new Map<string, StandClaim>([['tbl-1:s0', claim(BOB, T0)]]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: ALICE,
      now: T0 + STAND_CLAIM_TTL_MS + 1,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toContain('tbl-1:s0');
  });

  it('never offers a reserved slot to a non-operator', () => {
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims: new Map(),
      pub: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.find((s) => s.id === 'tbl-1:s3')).toBeUndefined();
  });

  it('offers the reserved slot LAST to an operator on a fresh walk-up', () => {
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims: new Map(),
      pub: OWNER,
      now: T0,
      canOperateReserved: true,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s0', 'tbl-1:s1', 'tbl-1:s2', 'tbl-1:s3']);
  });

  it('operator with every civilian slot taken still gets the reserved slot', () => {
    const claims = new Map<string, StandClaim>([
      ['tbl-1:s0', claim(ALICE, T0)],
      ['tbl-1:s1', claim(BOB, T0)],
      ['tbl-1:s2', claim('carol-pub', T0)],
    ]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: OWNER,
      now: T0 + 1_000,
      canOperateReserved: true,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s3']);
  });

  it('operator RESUMING their own reserved claim gets it FIRST (issue #76 spin-privilege standing)', () => {
    const claims = new Map<string, StandClaim>([['tbl-1:s3', claim(OWNER, T0)]]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: OWNER,
      now: T0 + 1_000,
      canOperateReserved: true,
    });
    // Mine-reserved is tier 1 — resume lands on the SAME spot, ahead of
    // every open civilian slot.
    expect(picked[0]!.id).toBe('tbl-1:s3');
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s3', 'tbl-1:s0', 'tbl-1:s1', 'tbl-1:s2']);
  });

  it('a de-authorised player does NOT resume onto a reserved claim they still hold', () => {
    // Owner grant revoked mid-session: their active reserved claim is skipped
    // (not offered) and they fall back to civilian slots.
    const claims = new Map<string, StandClaim>([['tbl-1:s3', claim(OWNER, T0)]]);
    const picked = pickStandForWalkup({
      slots: allSlots,
      claims,
      pub: OWNER,
      now: T0 + 1_000,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['tbl-1:s0', 'tbl-1:s1', 'tbl-1:s2']);
  });
});

describe('shouldReleaseSlot (ownership guard on delete)', () => {
  it('allows release when the slot is empty', () => {
    expect(shouldReleaseSlot(null, ALICE)).toBe(true);
  });

  it('allows release when the claim is ours', () => {
    expect(shouldReleaseSlot(claim(ALICE, T0), ALICE)).toBe(true);
  });

  it("refuses to delete another identity's claim", () => {
    expect(shouldReleaseSlot(claim(BOB, T0), ALICE)).toBe(false);
  });

  it('"" (no identity bound) can only ever release an EMPTY slot', () => {
    expect(shouldReleaseSlot(null, '')).toBe(true);
    expect(shouldReleaseSlot(claim(ALICE, T0), '')).toBe(false);
  });
});

describe('findExpiredClaims (reaper)', () => {
  it('returns nothing when every claim is fresh', () => {
    const claims = new Map<string, StandClaim>([
      ['tbl-1:s0', claim(ALICE, T0)],
      ['tbl-1:s1', claim(BOB, T0)],
    ]);
    expect(findExpiredClaims({ claims, onlinePubs: new Set(), now: T0 + 1_000 })).toEqual([]);
  });

  it('returns stale claims whose holder is NOT online', () => {
    const claims = new Map<string, StandClaim>([
      ['tbl-1:s0', claim(ALICE, T0)],
      ['tbl-1:s1', claim(BOB, T0)],
    ]);
    const stale = findExpiredClaims({
      claims,
      onlinePubs: new Set([ALICE]),
      now: T0 + STAND_CLAIM_TTL_MS + 1,
    });
    expect(stale).toEqual(['tbl-1:s1']);
  });

  it('keeps a stale claim whose holder is still online (heartbeat will refresh)', () => {
    const claims = new Map<string, StandClaim>([['tbl-1:s0', claim(ALICE, T0)]]);
    const stale = findExpiredClaims({
      claims,
      onlinePubs: new Set([ALICE]),
      now: T0 + STAND_CLAIM_TTL_MS + 1,
    });
    expect(stale).toEqual([]);
  });

  it('reaps a far-future (skew-bounded) claim from an offline holder', () => {
    const claims = new Map<string, StandClaim>([['tbl-1:s0', claim(BOB, T0 + 1e12)]]);
    expect(findExpiredClaims({ claims, onlinePubs: new Set(), now: T0 })).toEqual(['tbl-1:s0']);
  });
});

describe('tierOf alignment (world.ts stable re-sort vs pickStandForWalkup)', () => {
  // world.ts's pickFreeStand re-sorts candidates by (tier, distance) where
  // tier 0 = my active claim, 1 = open civilian, 2 = reserved. Both layers
  // must place "mine" ahead of everything, including a held reserved slot,
  // so the re-sort never disagrees with the picker.
  const tierOf = (s: StandSlot, claims: ReadonlyMap<string, StandClaim>, pub: string, now: number): number => {
    const c = claims.get(s.id);
    if (c && c.pub === pub && isClaimActive(c, now)) return 0;
    return s.role ? 2 : 1;
  };

  it('agrees with pickStandForWalkup on an operator resuming a reserved claim', () => {
    const civ = slot('tbl-1:s0');
    const wheel = slot('tbl-1:s3', 'wheelHead');
    const claims = new Map<string, StandClaim>([['tbl-1:s3', claim(OWNER, T0)]]);
    const picked = pickStandForWalkup({
      slots: [civ, wheel],
      claims,
      pub: OWNER,
      now: T0 + 1_000,
      canOperateReserved: true,
    });
    const sorted = [...picked].sort(
      (a, b) => tierOf(a, claims, OWNER, T0 + 1_000) - tierOf(b, claims, OWNER, T0 + 1_000),
    );
    expect(sorted.map((s) => s.id)).toEqual(picked.map((s) => s.id));
    expect(sorted[0]!.id).toBe('tbl-1:s3');
  });
});
