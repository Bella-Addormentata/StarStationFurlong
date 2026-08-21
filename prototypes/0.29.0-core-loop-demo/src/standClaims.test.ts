// standClaims.ts + standsDoc.ts tests (#76):
//   • shape guard (hostile map contents don't crash the walk-up)
//   • TTL expiry + heartbeat renewal (a live holder keeps their slot)
//   • canPlayerClaim (own / stale / other-live)
//   • pickStandForWalkup tier order (mine → open civilian → reserved)
//   • findExpiredClaims (only offline peers past TTL)
//   • CRDT convergence across two docs (LWW picks one winner on both replicas)
//   • release + reap batch semantics

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  STAND_CLAIM_TTL_MS,
  STAND_CLAIM_HEARTBEAT_MS,
  canPlayerClaim,
  findExpiredClaims,
  isClaimActive,
  isStandClaim,
  pickStandForWalkup,
  type StandClaim,
} from './standClaims';
import {
  bindStandsDoc,
  claimStand,
  readAllStandClaims,
  readStandClaim,
  reapExpiredClaims,
  releaseStand,
} from './standsDoc';
import type { StandSlot } from './furniture';

/** Compact StandSlot factory for the tier tests — id + optional role only,
 *  since pickStandForWalkup ignores front/faceAngle (the caller sorts). */
function slot(id: string, role?: 'wheelHead' | 'stickman'): StandSlot {
  return {
    id,
    front: { x: 0, z: 0 },
    faceAngle: 0,
    ...(role ? { role } : {}),
  };
}

const T0 = 1_700_000_000_000; // fixed clock so the TTL math is legible.
const ALICE = 'alice-uuid';
const BOB = 'bob-uuid';
const OWNER = 'owner-uuid';

describe('isStandClaim (shape guard)', () => {
  it('accepts a plain-JSON claim', () => {
    expect(isStandClaim({ playerId: ALICE, at: T0 })).toBe(true);
  });

  it('rejects null / non-objects / arrays', () => {
    expect(isStandClaim(null)).toBe(false);
    expect(isStandClaim(undefined)).toBe(false);
    expect(isStandClaim('string')).toBe(false);
    expect(isStandClaim(42)).toBe(false);
    expect(isStandClaim([])).toBe(false);
  });

  it('rejects missing or empty playerId', () => {
    expect(isStandClaim({ at: T0 })).toBe(false);
    expect(isStandClaim({ playerId: '', at: T0 })).toBe(false);
    expect(isStandClaim({ playerId: 123, at: T0 })).toBe(false);
  });

  it('rejects a non-finite or missing `at`', () => {
    expect(isStandClaim({ playerId: ALICE })).toBe(false);
    expect(isStandClaim({ playerId: ALICE, at: '0' })).toBe(false);
    expect(isStandClaim({ playerId: ALICE, at: NaN })).toBe(false);
    expect(isStandClaim({ playerId: ALICE, at: Infinity })).toBe(false);
  });

  it('rejects a Y.Map planted under a claim key (hostile write)', () => {
    // A Y.Map is `typeof 'object'` — the shape guard's own-property checks
    // on playerId/at are what actually save us. Confirm here.
    const yMap = new Y.Map();
    yMap.set('playerId', ALICE);
    yMap.set('at', T0);
    expect(isStandClaim(yMap)).toBe(false);
  });
});

describe('isClaimActive (TTL window)', () => {
  it('is active inside the TTL', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 };
    expect(isClaimActive(c, T0)).toBe(true);
    expect(isClaimActive(c, T0 + STAND_CLAIM_TTL_MS - 1)).toBe(true);
  });

  it('is not active AT or past the TTL boundary', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 };
    expect(isClaimActive(c, T0 + STAND_CLAIM_TTL_MS)).toBe(false);
    expect(isClaimActive(c, T0 + STAND_CLAIM_TTL_MS + 1)).toBe(false);
  });

  it('tolerates a future claim (clock skew — never strand a slot)', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 + 5_000 };
    expect(isClaimActive(c, T0)).toBe(true);
  });
});

describe('canPlayerClaim', () => {
  it('allows any player on an empty slot', () => {
    expect(canPlayerClaim(null, ALICE, T0)).toBe(true);
    expect(canPlayerClaim(null, BOB, T0)).toBe(true);
  });

  it('allows the holder to renew (heartbeat)', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 };
    expect(canPlayerClaim(c, ALICE, T0 + STAND_CLAIM_HEARTBEAT_MS)).toBe(true);
    expect(canPlayerClaim(c, ALICE, T0 + STAND_CLAIM_TTL_MS + 1)).toBe(true);
  });

  it('refuses a different live player', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 };
    expect(canPlayerClaim(c, BOB, T0)).toBe(false);
    expect(canPlayerClaim(c, BOB, T0 + STAND_CLAIM_TTL_MS - 1)).toBe(false);
  });

  it('allows a different player once the prior claim is stale', () => {
    const c: StandClaim = { playerId: ALICE, at: T0 };
    expect(canPlayerClaim(c, BOB, T0 + STAND_CLAIM_TTL_MS)).toBe(true);
  });
});

describe('pickStandForWalkup (tier order)', () => {
  const slots = [
    slot('t1:s0', 'wheelHead'), // reserved
    slot('t1:s1'),
    slot('t1:s2'),
    slot('t1:s3'),
  ];

  it('returns every civilian slot when the table is empty (reserved kept for operator)', () => {
    const picked = pickStandForWalkup({
      slots,
      claims: new Map(),
      playerId: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s1', 't1:s2', 't1:s3']);
  });

  it('offers a reserved slot to an owner-equivalent player, LAST', () => {
    const picked = pickStandForWalkup({
      slots,
      claims: new Map(),
      playerId: OWNER,
      now: T0,
      canOperateReserved: true,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s1', 't1:s2', 't1:s3', 't1:s0']);
  });

  it("puts the player's own active claim first (re-focus resume)", () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s2', { playerId: ALICE, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    // Mine (:s2) first, then the other open civilian slots.
    expect(picked[0].id).toBe('t1:s2');
    expect(picked.slice(1).map((s) => s.id).sort()).toEqual(['t1:s1', 't1:s3']);
  });

  it('skips slots held live by other players', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: BOB, at: T0 }],
      ['t1:s2', { playerId: BOB, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s3']);
  });

  it('re-opens a slot once its prior claim has aged past the TTL', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: BOB, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: ALICE,
      now: T0 + STAND_CLAIM_TTL_MS + 1,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id).sort()).toEqual(['t1:s1', 't1:s2', 't1:s3']);
  });

  it('returns an empty list when every civilian slot is held and reserved is off-limits', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: BOB, at: T0 }],
      ['t1:s2', { playerId: BOB, at: T0 }],
      ['t1:s3', { playerId: BOB, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: ALICE,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked).toEqual([]);
  });

  it('falls back to the reserved slot when civilians are all held AND the walker is owner-equivalent', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: BOB, at: T0 }],
      ['t1:s2', { playerId: BOB, at: T0 }],
      ['t1:s3', { playerId: BOB, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: OWNER,
      now: T0,
      canOperateReserved: true,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s0']);
  });

  it('keeps an owner on a reserved slot they already hold (re-focus)', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s0', { playerId: OWNER, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: OWNER,
      now: T0,
      canOperateReserved: true,
    });
    // The reserved slot the owner already holds appears LAST (reserved tier),
    // but it's still there — otherwise the caller would leave the wheel-head.
    expect(picked.map((s) => s.id)).toContain('t1:s0');
    expect(picked[picked.length - 1].id).toBe('t1:s0');
  });
});

describe('findExpiredClaims', () => {
  it('flags claims past TTL whose holder is offline', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: ALICE, at: T0 }],
      ['t1:s2', { playerId: BOB, at: T0 }],
    ]);
    const stale = findExpiredClaims({
      claims,
      onlinePlayerIds: new Set([ALICE]),
      now: T0 + STAND_CLAIM_TTL_MS + 1,
    });
    // Alice is still online → her (silent) claim stays; Bob's is reapable.
    expect(stale).toEqual(['t1:s2']);
  });

  it('never flags a claim inside its TTL, online or not', () => {
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: BOB, at: T0 }],
    ]);
    const stale = findExpiredClaims({
      claims,
      onlinePlayerIds: new Set(), // Bob dropped, but the TTL hasn't fired.
      now: T0 + STAND_CLAIM_TTL_MS - 1,
    });
    expect(stale).toEqual([]);
  });

  it('returns an empty list when nothing is stale', () => {
    expect(
      findExpiredClaims({
        claims: new Map(),
        onlinePlayerIds: new Set(),
        now: T0,
      }),
    ).toEqual([]);
  });
});

describe('standsDoc round-trip and shape guard', () => {
  beforeEach(() => {
    bindStandsDoc(new Y.Doc());
  });

  it('writes and reads a claim; delete clears it', () => {
    const c = claimStand('t1:s1', ALICE, T0);
    expect(c).toEqual({ playerId: ALICE, at: T0 });
    expect(readStandClaim('t1:s1')).toEqual({ playerId: ALICE, at: T0 });
    releaseStand('t1:s1');
    expect(readStandClaim('t1:s1')).toBeNull();
  });

  it('heartbeat overwrites the same key (LWW, no duplicate slot)', () => {
    claimStand('t1:s1', ALICE, T0);
    claimStand('t1:s1', ALICE, T0 + STAND_CLAIM_HEARTBEAT_MS);
    expect(readStandClaim('t1:s1')).toEqual({
      playerId: ALICE,
      at: T0 + STAND_CLAIM_HEARTBEAT_MS,
    });
    expect(readAllStandClaims().size).toBe(1);
  });

  it('skips a hostile plain-object write on read', () => {
    const doc = new Y.Doc();
    bindStandsDoc(doc);
    doc.getMap('stands').set('t1:s1', { junk: true });
    doc.getMap('stands').set('t1:s2', 'not-a-claim');
    expect(readStandClaim('t1:s1')).toBeNull();
    expect(readStandClaim('t1:s2')).toBeNull();
    expect(readAllStandClaims().size).toBe(0);
  });

  it('release is a no-op on a missing key (no observer spam)', () => {
    let notifies = 0;
    const unsub = (() => {
      // Fresh doc to bind a listener that counts fan-outs.
      const doc = new Y.Doc();
      bindStandsDoc(doc);
      // subscribeStands is imported for wiring but we don't need it here —
      // the observe hook is enough. Attach one directly to see writes.
      doc.getMap('stands').observe(() => (notifies += 1));
      return () => doc.destroy();
    })();
    releaseStand('does-not-exist'); // no transact runs → no notify
    expect(notifies).toBe(0);
    unsub();
  });

  it('reapExpiredClaims batches deletes into one transaction', () => {
    const doc = new Y.Doc();
    bindStandsDoc(doc);
    let notifies = 0;
    doc.getMap('stands').observe(() => (notifies += 1));
    claimStand('t1:s1', ALICE, T0);
    claimStand('t1:s2', BOB, T0);
    const beforeReap = notifies;
    reapExpiredClaims(['t1:s1', 't1:s2', 't1:missing']);
    expect(notifies).toBe(beforeReap + 1); // ONE fan-out, not three
    expect(readAllStandClaims().size).toBe(0);
  });
});

describe('CRDT convergence: two peers grab the same slot', () => {
  it('LWW picks exactly one winner and both replicas see the same claim', () => {
    // Two docs — no live sync — each grabs the same slot. Then heal.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    bindStandsDoc(docA);
    claimStand('t1:s1', ALICE, T0);
    bindStandsDoc(docB);
    claimStand('t1:s1', BOB, T0); // same wall-clock, different peer
    // Two-way merge.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    // Every replica surfaces the SAME value — either Alice's or Bob's —
    // but never both, and never a merge/half-write.
    const va = docA.getMap('stands').get('t1:s1');
    const vb = docB.getMap('stands').get('t1:s1');
    expect(va).toEqual(vb);
    expect(isStandClaim(va)).toBe(true);
    expect([ALICE, BOB]).toContain((va as StandClaim).playerId);
    // And each replica reports exactly one active occupant on the slot.
    bindStandsDoc(docA);
    expect(readAllStandClaims().size).toBe(1);
    bindStandsDoc(docB);
    expect(readAllStandClaims().size).toBe(1);
  });

  it('the loser sees the winner via pickStandForWalkup and takes another slot', () => {
    // Small ring so we can inspect what the loser would walk to next.
    const slots = [slot('t1:s1'), slot('t1:s2')];
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    bindStandsDoc(docA);
    claimStand('t1:s1', ALICE, T0);
    bindStandsDoc(docB);
    claimStand('t1:s1', BOB, T0);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    bindStandsDoc(docA);
    const claims = readAllStandClaims();
    const winner = claims.get('t1:s1')!.playerId;
    const loser = winner === ALICE ? BOB : ALICE;
    // The loser now looks at the merged claim map and sees s1 is taken —
    // pickStandForWalkup steers them at s2, the OTHER slot on the ring.
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: loser,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s2']);
  });

  it('a stale peer that crashed is reaped once its TTL fires', () => {
    // Alice claims, then goes offline (never heartbeats). At T0+TTL+1 the
    // reaper on any live client removes the claim.
    bindStandsDoc(new Y.Doc());
    claimStand('t1:s1', ALICE, T0);
    const late = T0 + STAND_CLAIM_TTL_MS + 1;
    const stale = findExpiredClaims({
      claims: readAllStandClaims(),
      onlinePlayerIds: new Set(), // Alice's tab dropped
      now: late,
    });
    expect(stale).toEqual(['t1:s1']);
    reapExpiredClaims(stale);
    // Slot is free — the next player's walk-up now converges on it.
    expect(readStandClaim('t1:s1')).toBeNull();
    const picked = pickStandForWalkup({
      slots: [slot('t1:s1')],
      claims: readAllStandClaims(),
      playerId: BOB,
      now: late,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s1']);
  });
});
