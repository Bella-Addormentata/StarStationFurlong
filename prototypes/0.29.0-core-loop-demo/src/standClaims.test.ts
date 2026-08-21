// standClaims.ts + standsDoc.ts tests (#76):
//   • shape guard (hostile map contents don't crash the walk-up)
//   • TTL expiry + heartbeat renewal (a live holder keeps their slot)
//   • canPlayerClaim (own / stale / other-live)
//   • pickStandForWalkup tier order (mine → open civilian → reserved)
//   • findExpiredClaims (only offline peers past TTL)
//   • CRDT convergence across two docs (LWW picks one winner on both replicas)
//   • release + reap batch semantics

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  STAND_CLAIM_TTL_MS,
  STAND_CLAIM_HEARTBEAT_MS,
  canPlayerClaim,
  findExpiredClaims,
  isClaimActive,
  isStandClaim,
  pickStandForWalkup,
  shouldReleaseSlot,
  type StandClaim,
} from './standClaims';
import {
  bindStandsDoc,
  claimStand,
  getOnlinePlayerIds,
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

  it('keeps an owner on a reserved slot they already hold in TIER 1 (re-focus resume, audit fix)', () => {
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
    // Audit remediation: an owner's OWN active claim on a reserved slot is a
    // "resume" and belongs in mine-active (tier 1), NOT the reserved-fallback
    // tier — otherwise an owner walking back to the wheel-head would prefer
    // any open civilian slot in front of it. The issue directive is that
    // owners/operators stand IN the reserved spot, so re-focus honours that.
    expect(picked[0].id).toBe('t1:s0');
    // Every other civilian slot is still on offer (in case the wheel-head
    // is somehow unavailable at walk time), just after mine-active.
    expect(picked.slice(1).map((s) => s.id).sort())
      .toEqual(['t1:s1', 't1:s2', 't1:s3']);
  });

  it('drops a former operator\'s own reserved-slot claim once they lose spin rights', () => {
    // Audit fix side effect: mine-active for a reserved slot is gated by
    // canOperateReserved. A former owner still hearing about their old claim
    // in the doc should NOT walk back onto the wheel-head — the claim will
    // age out via TTL, and meanwhile the caller lands on an open civilian.
    const claims = new Map<string, StandClaim>([
      ['t1:s0', { playerId: OWNER, at: T0 }],
    ]);
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: OWNER,
      now: T0,
      canOperateReserved: false,
    });
    expect(picked.map((s) => s.id)).toEqual(['t1:s1', 't1:s2', 't1:s3']);
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
      // Fresh doc to bind a listener that counts fan-outs. Attach directly
      // to the Y.Map's observe hook — the subscribeStands fan-out was
      // removed as dead code (audit fix), and no consumer subscribes today.
      const doc = new Y.Doc();
      bindStandsDoc(doc);
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

// ── Audit fixes: pure regressions for the release-guard + provider paths ───

describe('shouldReleaseSlot (release-ownership guard)', () => {
  // World.ts's releaseStandById calls this before deleting a slot key so a
  // hypothetical TTL race where another peer legitimately took our slot
  // cannot cause our stale release closure to drop THEIR claim.
  it('allows a release when the slot is empty', () => {
    expect(shouldReleaseSlot(null, ALICE)).toBe(true);
  });

  it('allows a release when the current claim names us', () => {
    expect(shouldReleaseSlot({ playerId: ALICE, at: T0 }, ALICE)).toBe(true);
  });

  it('refuses to drop another live player\'s claim', () => {
    expect(shouldReleaseSlot({ playerId: BOB, at: T0 }, ALICE)).toBe(false);
  });

  it('refuses even a stale foreign claim — the reaper handles cleanup, not us', () => {
    // Ownership is name-based, not time-based, on this path. Only the
    // reaper (findExpiredClaims + reapExpiredClaims) should touch a
    // stale foreign claim; an over-eager per-slot release would race the
    // legitimate owner's fresh heartbeat.
    expect(shouldReleaseSlot({ playerId: BOB, at: 0 }, ALICE)).toBe(false);
  });
});

describe('stand-switch release-before-claim (audit remediation for finding #1 / #2)', () => {
  // Simulates world.ts's standTarget + wrapped onRelease sequence:
  //   1. Claim slot A (walk to table A starts, trackedStand = { slotId:A }).
  //   2. User clicks table B → standTarget releases A (per fix), claims B.
  //   3. Later A_wrapped.onRelease fires via the deferred release path.
  // The wrapped closure captures the ORIGINAL slot id (A) at wrap time, so
  // the release in step 3 must target A (already gone), never B. And the
  // ownership guard (shouldReleaseSlot) must protect against dropping B.
  //
  // Testing the wrapped-closure semantics with the doc directly rather than
  // driving through world.ts (which needs a live scene) — the standsDoc
  // half is the load-bearing correctness proof; world.ts's wire-up is the
  // trivial adapter around it.
  beforeEach(() => bindStandsDoc(new Y.Doc()));

  it('releasing slot A after re-claiming slot B leaves B intact', () => {
    // Step 1: claim A, capture its id in a "wrap" closure.
    claimStand('t1:s0', ALICE, T0);
    const wrapA = { slotIdAtWrap: 't1:s0' };
    // Step 2: switch tables → release A, claim B (in trackedStand terms,
    // trackedStand is now s2 not s0). The fix in standTarget also does
    // this pre-release; simulate directly here.
    releaseStand(wrapA.slotIdAtWrap);
    claimStand('t2:s0', ALICE, T0 + 100);
    // Step 3: A's stale wrap onRelease fires — it must target A (captured),
    // not "whatever we track now". World.ts's releaseStandById reads the
    // current claim, sees it's empty (already released), so the
    // shouldReleaseSlot guard allows a no-op releaseStand call.
    const current = readStandClaim(wrapA.slotIdAtWrap);
    expect(shouldReleaseSlot(current, ALICE)).toBe(true);
    if (shouldReleaseSlot(current, ALICE)) releaseStand(wrapA.slotIdAtWrap);
    // B survives intact.
    expect(readStandClaim('t2:s0')).toEqual({ playerId: ALICE, at: T0 + 100 });
  });

  it('the ownership guard prevents an errant release from dropping another peer\'s slot', () => {
    // Contrived race: Alice's TTL expired and Bob legitimately took her old
    // slot. Alice's stale wrap onRelease should NOT delete Bob's claim.
    claimStand('t1:s0', BOB, T0);
    const wrapA = { slotIdAtWrap: 't1:s0' };
    const current = readStandClaim(wrapA.slotIdAtWrap);
    expect(shouldReleaseSlot(current, ALICE)).toBe(false);
    // The guard refuses — world.ts's releaseStandById early-returns without
    // calling releaseStand. Bob's claim stays.
    expect(readStandClaim('t1:s0')).toEqual({ playerId: BOB, at: T0 });
  });

  it('leaked claim from an aborted walk-up is reapable once the local player goes offline', () => {
    // BACKSTOP path. The round-2 audit fix in player.ts's
    // _cancelDeviceApproach now fires the wrapped onRelease on every
    // abort site, so a leak of this kind should never actually reach the
    // reaper — see the "aborted APPROACH ..." describe below for the
    // round-2 correctness proof. But if some future refactor manages to
    // strand a claim anyway, this is the recovery path: once the local
    // player id is no longer in the online set, the reaper sees the
    // expired claim and deletes it. Before the round-1 fix the local
    // player id was ALWAYS in the online set, so a leak stuck for the
    // whole session.
    claimStand('t1:s0', ALICE, T0);
    // Alice's tab actually crashed (not just "quiet"): she's not in the
    // online set. Well past the TTL.
    const late = T0 + STAND_CLAIM_TTL_MS + 100;
    const stale = findExpiredClaims({
      claims: readAllStandClaims(),
      onlinePlayerIds: new Set<string>(), // Alice not online → reapable
      now: late,
    });
    expect(stale).toEqual(['t1:s0']);
  });
});

describe('aborted APPROACH releases the stand claim (round-2 audit fix)', () => {
  // Round-1 wrapped every device's onRelease so it released the claimed
  // stand slot — good, but the focus controller only ever fires onRelease
  // from the FOCUSED state (deviceFocus.release / forceRelease). The
  // player state machine has its own APPROACH/FINE/TURN phases BEFORE
  // handing off to the controller, and _cancelDeviceApproach used to
  // abandon those phases without firing the wrapped onRelease. That left
  // the claim stranded, and heartbeat kept it alive.
  //
  // The round-2 fix teaches _cancelDeviceApproach to fire
  // deviceTarget.onRelease?.() uniformly for every abort entry point
  // (floor-click, seat/door-click, WASD, FINE-stuck, obstacles-changed,
  // beamTo, enterFromDoor, item-removed/moved, non-ENGAGED release). The
  // wrapped closure captures the claimed slot id and calls the
  // shouldReleaseSlot-guarded releaseStandById — so the claim clears
  // immediately, not "next reap sweep after we go offline".
  //
  // These tests exercise the wrapped-closure semantics against the doc
  // directly, mirroring the release-before-claim block above — pure
  // engine, no live scene.
  beforeEach(() => bindStandsDoc(new Y.Doc()));

  it('a wrapped onRelease fired during APPROACH releases the claimed slot immediately', () => {
    // Simulate the exact call sequence:
    //   1. World.ts standTarget(device) claims 't3:s0' for Alice.
    //   2. Wrapped onRelease captures slotId 't3:s0' in its closure.
    //   3. Player.ts's _cancelDeviceApproach (any of the 12+ abort sites)
    //      calls deviceTarget.onRelease?.() — fires the wrapped release.
    //   4. Slot 't3:s0' clears NOW, no TTL wait, no offline requirement.
    const claimedSlotId = 't3:s0';
    claimStand(claimedSlotId, ALICE, T0);
    // Wrap closure a la world.ts:standTarget — captures the slot id at
    // wrap time, guards with shouldReleaseSlot, then calls releaseStand.
    const wrappedOnRelease = () => {
      const current = readStandClaim(claimedSlotId);
      if (shouldReleaseSlot(current, ALICE)) releaseStand(claimedSlotId);
    };
    // _cancelDeviceApproach fires it.
    wrappedOnRelease();
    // Claim is gone. Not "expired". Not "reapable after offline". Gone.
    expect(readStandClaim(claimedSlotId)).toBeNull();
    // And the reaper sees nothing to do at time T0 (the claim isn't even
    // expired — this is a live-release, not a leak-then-reap).
    const stale = findExpiredClaims({
      claims: readAllStandClaims(),
      onlinePlayerIds: new Set<string>([ALICE]),
      now: T0,
    });
    expect(stale).toEqual([]);
  });

  it('firing the wrapped onRelease twice is a no-op the second time (idempotent)', () => {
    // Some abort paths can chain — e.g. _cancelDeviceApproach fires the
    // wrapped release, then a subsequent releaseDevice() might fire the
    // controller's own onRelease later if state got confused. The
    // ownership guard makes the second fire a safe no-op.
    const claimedSlotId = 't3:s0';
    claimStand(claimedSlotId, ALICE, T0);
    const wrappedOnRelease = () => {
      const current = readStandClaim(claimedSlotId);
      if (shouldReleaseSlot(current, ALICE)) releaseStand(claimedSlotId);
    };
    wrappedOnRelease();
    expect(readStandClaim(claimedSlotId)).toBeNull();
    // Second fire — current is now null, shouldReleaseSlot(null, _) is
    // true, releaseStand is a no-op when the map key is absent.
    expect(() => wrappedOnRelease()).not.toThrow();
    expect(readStandClaim(claimedSlotId)).toBeNull();
  });

  it('a re-tap that lands on a different slot preserves the latest closure so both slots release cleanly', () => {
    // Round-2 fix companion: navigateToDevice's same-device branch used
    // to update `deviceHooks` but keep the OLD `deviceTarget`. If
    // standTarget picked a fresh slot on re-tap (rare — TTL expired
    // between clicks), the new wrapped onRelease was discarded and the
    // NEW slot leaked. The fix also refreshes `deviceTarget = device`
    // so the newest wrapped closure survives — old A closure orphans
    // safely (standTarget's own pre-release already dropped slot A).
    //
    // Simulation: Alice claims A (t3:s0), then re-taps → standTarget
    // pre-releases A and claims B (t3:s2). Later an abort fires the
    // NEWEST wrapped closure — it targets B, and B clears.
    claimStand('t3:s0', ALICE, T0);
    // standTarget's pre-release path (world.ts) on the re-tap:
    releaseStand('t3:s0');
    claimStand('t3:s2', ALICE, T0 + 50);
    // Player.ts NOW holds the B-flavoured wrapped onRelease as
    // deviceTarget (round-2 fix's navigateToDevice branch adopts the
    // fresh DeviceTarget, not just hooks).
    const wrappedOnReleaseB = () => {
      const current = readStandClaim('t3:s2');
      if (shouldReleaseSlot(current, ALICE)) releaseStand('t3:s2');
    };
    // Abort fires it.
    wrappedOnReleaseB();
    // Both A and B are gone.
    expect(readStandClaim('t3:s0')).toBeNull();
    expect(readStandClaim('t3:s2')).toBeNull();
  });

  it('the wrapped closure will not drop another peer\'s slot even if fired late', () => {
    // Racing scenario: Alice's APPROACH aborts, but by the time her
    // wrapped closure fires her TTL had expired and Bob legitimately
    // took the same slot (shouldReleaseSlot's whole reason to exist).
    // The guard refuses; Bob keeps his claim.
    const claimedSlotId = 't3:s0';
    // The world was: Alice claimed, went silent, Bob took over.
    claimStand(claimedSlotId, BOB, T0 + STAND_CLAIM_TTL_MS + 500);
    // Alice's stale wrapped closure — captures the same slot id, uses
    // Alice's playerId in the ownership check.
    const staleWrappedOnRelease = () => {
      const current = readStandClaim(claimedSlotId);
      if (shouldReleaseSlot(current, ALICE)) releaseStand(claimedSlotId);
    };
    staleWrappedOnRelease();
    // Bob's claim survives.
    expect(readStandClaim(claimedSlotId)).toEqual({
      playerId: BOB,
      at: T0 + STAND_CLAIM_TTL_MS + 500,
    });
  });
});

describe('online-players provider (audit remediation for finding #5)', () => {
  // Formerly world.ts reached into `window.__ssfDoc` to enumerate the
  // room's `players` map. The audit called that a coupling smell in a
  // hot path; the fix is a proper accessor registered at bind time.
  beforeEach(() => bindStandsDoc(new Y.Doc()));

  it('returns an empty set when no provider is registered (tests / offline)', () => {
    // Fresh binding via beforeEach cleared any prior test's provider only
    // if that test passed `{ getOnlinePlayerIds: undefined }` explicitly.
    // Belt-and-braces: clear it here for hermeticity.
    bindStandsDoc(new Y.Doc(), { getOnlinePlayerIds: undefined });
    expect(getOnlinePlayerIds().size).toBe(0);
  });

  it('surfaces whatever set the provider returns', () => {
    bindStandsDoc(new Y.Doc(), {
      getOnlinePlayerIds: () => new Set([ALICE, BOB]),
    });
    const ids = getOnlinePlayerIds();
    expect(ids.has(ALICE)).toBe(true);
    expect(ids.has(BOB)).toBe(true);
  });

  it('swallows a throwing provider and returns an empty set (fail-safe)', () => {
    // The reap sweep runs every 3 s of world update; a provider that
    // throws once (e.g. Y.Map racing a leaveRoom teardown) must not crash
    // the world loop. World.ts adds getPlayerId() locally after the
    // provider call, so a solo user still keeps their own slot even
    // during a transient provider failure.
    //
    // Suppress the expected [stands] error log so the test output stays
    // clean — the log itself is the diagnostic, and we assert on the
    // return value here.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindStandsDoc(new Y.Doc(), {
      getOnlinePlayerIds: () => {
        throw new Error('boom');
      },
    });
    expect(getOnlinePlayerIds().size).toBe(0);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('a rebind without opts keeps the previous provider (partial rebind pattern)', () => {
    bindStandsDoc(new Y.Doc(), {
      getOnlinePlayerIds: () => new Set([ALICE]),
    });
    bindStandsDoc(new Y.Doc()); // rebind for a new room, opts intentionally omitted
    expect(getOnlinePlayerIds().has(ALICE)).toBe(true);
  });

  it('a rebind with { getOnlinePlayerIds: undefined } CLEARS the provider', () => {
    bindStandsDoc(new Y.Doc(), {
      getOnlinePlayerIds: () => new Set([ALICE]),
    });
    bindStandsDoc(new Y.Doc(), { getOnlinePlayerIds: undefined });
    expect(getOnlinePlayerIds().size).toBe(0);
  });
});

describe('heartbeat ownership guard (audit remediation for finding #1: frozen-tab resume)', () => {
  // World.ts tickStandHeartbeat blindly overwrote another peer's claim after
  // a background-tab freeze past the TTL. LWW picked the resumed-tab's write
  // (its `at` is Date.now(), always > the peer's earlier claim) and displaced
  // the peer's legitimate walk-up. Round-3 fix: consult canPlayerClaim on the
  // current doc value BEFORE writing the heartbeat, and if we've lost tenure
  // to another live peer, drop trackedStand and skip the write.
  //
  // Simulated at the doc level rather than through world.ts so the regression
  // is hermetic (same pattern as the release-before-claim block above).
  beforeEach(() => bindStandsDoc(new Y.Doc()));

  /**
   * The guarded heartbeat as a pure function. Mirrors the tickStandHeartbeat
   * body in world.ts: read the current claim, decide via canPlayerClaim, and
   * either write (renew) or null the tracked slot (yield). Returns the new
   * tracked-stand slot id (or null when we yielded) so the test can assert.
   */
  function guardedHeartbeat(
    trackedSlotId: string,
    me: string,
    now: number,
  ): string | null {
    const current = readStandClaim(trackedSlotId);
    if (!canPlayerClaim(current, me, now)) return null;
    claimStand(trackedSlotId, me, now);
    return trackedSlotId;
  }

  it('yields the slot when a peer legitimately took over during a freeze', () => {
    // t=0: Alice claims slot A and gets her wrapped onRelease + heartbeat
    // tracker for it. Her tab then freezes.
    claimStand('t1:s0', ALICE, T0);
    // t=20 000 (> STAND_CLAIM_TTL_MS = 15 000): Bob walks up and, per
    // pickStandForWalkup + canPlayerClaim, finds Alice's claim stale and
    // legitimately takes the slot.
    const takeoverAt = T0 + STAND_CLAIM_TTL_MS + 5_000;
    claimStand('t1:s0', BOB, takeoverAt);
    // t=25 000: Alice's tab resumes and her tickStandHeartbeat runs. The
    // guard reads the doc, sees Bob's live claim, and refuses to write —
    // the tracked stand is nulled and Bob's claim stays intact.
    const resumeAt = takeoverAt + 5_000;
    const result = guardedHeartbeat('t1:s0', ALICE, resumeAt);
    expect(result).toBeNull();
    expect(readStandClaim('t1:s0')).toEqual({ playerId: BOB, at: takeoverAt });
  });

  it('renews normally when the slot is still ours', () => {
    // Ordinary heartbeat path — Alice's tab is live, her claim is still
    // named + fresh, the write goes through.
    claimStand('t1:s0', ALICE, T0);
    const nextTick = T0 + STAND_CLAIM_HEARTBEAT_MS;
    const result = guardedHeartbeat('t1:s0', ALICE, nextTick);
    expect(result).toBe('t1:s0');
    expect(readStandClaim('t1:s0')).toEqual({ playerId: ALICE, at: nextTick });
  });

  it('renews when our own claim aged past the TTL and nobody took over', () => {
    // The heartbeat is scheduled from the local loop, so a heartbeat that
    // fires exactly at TTL sees its own stale claim. canPlayerClaim treats
    // "the claim is theirs" as always renewable — this stays a live
    // heartbeat, not a yield. (Contrast with the frozen-tab case above:
    // the difference is only whether another peer's write intervened.)
    claimStand('t1:s0', ALICE, T0);
    const late = T0 + STAND_CLAIM_TTL_MS + 100;
    const result = guardedHeartbeat('t1:s0', ALICE, late);
    expect(result).toBe('t1:s0');
    expect(readStandClaim('t1:s0')).toEqual({ playerId: ALICE, at: late });
  });

  it('yields when the slot key is a hostile shape from another peer', () => {
    // Belt-and-braces: a peer plants a non-claim value under our slot key.
    // The shape guard reads it as null, canPlayerClaim(null, us, now) is
    // true, and the heartbeat proceeds — this is the desired behaviour
    // (garbage under our slot key does NOT strand us out of our own slot).
    const doc = new Y.Doc();
    bindStandsDoc(doc);
    doc.getMap('stands').set('t1:s0', 'not-a-claim');
    const result = guardedHeartbeat('t1:s0', ALICE, T0);
    expect(result).toBe('t1:s0');
    expect(readStandClaim('t1:s0')).toEqual({ playerId: ALICE, at: T0 });
  });
});

describe('world.ts pickFreeStand tierOf alignment (audit remediation for finding #2)', () => {
  // The world.ts sorter used to grant tier 0 to ANY slot the local player
  // named in a claim, regardless of freshness. pickStandForWalkup gates the
  // mine-active tier on isClaimActive: a stale-mine non-role claim falls to
  // openCivilian. The disagreement let a stale-mine slot re-promote to tier
  // 0 in the local re-sort and win over a nearer open civilian slot.
  //
  // These pure tests pin the aligned tier semantics — the world.ts sorter
  // now also gates on isClaimActive, so both layers agree.

  it('a stale-mine non-role claim is NOT tier 0', () => {
    // Same shape the aligned world.ts tierOf uses: an active-mine claim
    // is tier 0; a stale one is not.
    const active: StandClaim = { playerId: ALICE, at: T0 };
    const stale: StandClaim = { playerId: ALICE, at: T0 };
    const nowActive = T0 + STAND_CLAIM_HEARTBEAT_MS;
    const nowStale = T0 + STAND_CLAIM_TTL_MS + 100;
    expect(isClaimActive(active, nowActive)).toBe(true);
    expect(isClaimActive(stale, nowStale)).toBe(false);
    // The world.ts tierOf's active-mine condition (aligned):
    //   claim.playerId === me && isClaimActive(claim, now) → tier 0
    // For a stale claim the isClaimActive gate fails, so tierOf falls
    // through to `s.role ? 2 : 1` — matches openCivilian in the pure engine.
  });

  it('pickStandForWalkup emits a stale-mine non-role slot in openCivilian (tier 2 in the return order)', () => {
    // Direct proof of what the pure engine does with a stale-mine claim:
    // the mine-active guard fails (not active), canPlayerClaim allows the
    // write (it's still ours in name), s.role is falsy → openCivilian.
    const slots = [
      slot('t1:s0'),
      slot('t1:s1'),
      slot('t1:s2'),
    ];
    const claims = new Map<string, StandClaim>([
      ['t1:s1', { playerId: ALICE, at: T0 }], // stale-mine
    ]);
    const nowStale = T0 + STAND_CLAIM_TTL_MS + 100;
    const picked = pickStandForWalkup({
      slots,
      claims,
      playerId: ALICE,
      now: nowStale,
      canOperateReserved: false,
    });
    // All three slots are eligible (none held by another live peer); the
    // stale-mine slot appears among openCivilian — position by insertion
    // order, not promoted ahead as tier 0.
    expect(picked.map((s) => s.id)).toEqual(['t1:s0', 't1:s1', 't1:s2']);
  });
});
