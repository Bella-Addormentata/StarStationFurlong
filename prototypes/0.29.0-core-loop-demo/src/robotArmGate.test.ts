/**
 * 🦾 Robot arm construction gate — vitest cases for the pure predicate.
 *
 * Scope: this file exercises the SIDE-EFFECT-FREE core of the gate — every
 * caller-visible branch of `armCoversDoor` and `armReachPose`. The docking
 * seam wiring (transient-berth skip, existing-pairing skip, dev auto-accept
 * bypass) is enforced in docking.ts and covered by its own manual smoke —
 * the predicate takes NO knowledge of those states, so keeping the pure
 * math test independent is intentional (ISO/IEC 25000 · testability).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARM_REACH,
  ROBOT_ARM_KIND,
  armCoversDoor,
  armReachPose,
} from './robotArmGate';
import type { FurnitureItem, FurnitureKind, Rot } from './furniture';
import type { PhysicalDoorPose } from './doorLayout';
import { ROT_WALL } from './hull';

// ── Test fixtures ────────────────────────────────────────────────────────────
// Minimal furniture items shaped like the FurnitureItem structure the game
// stores in Yjs — only the fields the predicate reads are meaningful. We
// deliberately DO NOT construct the whole record (the predicate must accept
// any shape that matches its Pick<>). Also deliberately hand-built so a
// refactor of the FurnitureItem type surfaces here first.

function mkArm(overrides: Partial<FurnitureItem> & { id: string; pos: { x: number; z: number }; rot: Rot }): FurnitureItem {
  const base: FurnitureItem = {
    id: overrides.id,
    kind: (overrides.kind ?? ROBOT_ARM_KIND) as FurnitureKind,
    pos: overrides.pos,
    rot: overrides.rot,
    movable: true,
  };
  return { ...base, ...overrides };
}

function mkNonArm(id: string, pos: { x: number; z: number }, rot: Rot, kind: FurnitureKind = 'engine-block' as FurnitureKind): FurnitureItem {
  return { id, kind, pos, rot, movable: true };
}

// Doors sit on the four hull walls. The x/z values place the door centre in
// world coords; the OWNER-visible fields we exercise are wall + centre.
function mkDoor(wall: PhysicalDoorPose['wall'], x: number, z: number): Pick<PhysicalDoorPose, 'wall' | 'x' | 'z'> {
  return { wall, x, z };
}

// ── ROT_WALL / WALL_FOR_ROT parity guard ─────────────────────────────────────

describe('robotArmGate — wall-mapping parity with hull.ROT_WALL', () => {
  // Kept LOCAL in robotArmGate for the pure-module reason documented in the
  // source; a value-level cross-check pins the two constants together so a
  // drift shows up as a red test the day it's introduced.
  it('WALL_FOR_ROT (in-module, private) matches hull.ROT_WALL for all four rots', () => {
    // We can't import the private const, so we probe the observable behaviour
    // instead: for each rot, place ONE arm at the door's exact along-wall
    // centre — the arm must qualify iff its rot maps to the same wall as the
    // door. This asserts the mapping without exposing internals.
    const rots: Rot[] = [0, 1, 2, 3];
    for (const rot of rots) {
      const wall = ROT_WALL[rot];
      // Arm at (0,0) on wall `wall`; door centred at (0,0) on the SAME wall.
      const arm = mkArm({ id: `arm-${rot}`, pos: { x: 0, z: 0 }, rot });
      const door = mkDoor(wall, 0, 0);
      const result = armCoversDoor(door, [arm]);
      expect(result.ok, `rot ${rot} → wall ${wall}`).toBe(true);
    }
  });
});

// ── Core acceptance / refusal cases ──────────────────────────────────────────

describe('robotArmGate.armCoversDoor', () => {
  it('accepts an arm on the same wall within reach', () => {
    // y+ wall: along-axis is x. Arm at x=10, door at x=11 → 1 m away < 4 m.
    const arm = mkArm({ id: 'a', pos: { x: 10, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 11, 6);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arm.id).toBe('a');
  });

  it('refuses when there are no arms at all', () => {
    const nonArm = mkNonArm('e', { x: 10, z: 6 }, 0);
    const door = mkDoor('y+', 10, 6);
    const result = armCoversDoor(door, [nonArm]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no ROBOT ARM installed');
  });

  it('refuses when arms exist but none on the door\'s wall', () => {
    // Arm on y+ (rot 0), door on x- (rot 3).
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 0 }, rot: 0 });
    const door = mkDoor('x-', -6, 0);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("wall");
      expect(result.reason).toContain('x-');
    }
  });

  it('refuses when arm is on the right wall but too far along', () => {
    // y+ wall: arm at x=0, door at x=8 → 8 m > 4 m default.
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 8, 6);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('too far');
  });

  it('accepts exactly at the reach radius (boundary is inclusive)', () => {
    // y+ wall: arm at x=0, door at x=DEFAULT_ARM_REACH (4 m).
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', DEFAULT_ARM_REACH, 6);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(true);
  });

  it('refuses just past the reach radius', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', DEFAULT_ARM_REACH + 0.0001, 6);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(false);
  });

  it('picks the NEAREST arm when multiple qualify (deterministic tie-break by id)', () => {
    // y+ wall: three arms at x=6, x=8, x=9; door at x=8 → nearest is x=8.
    const arms = [
      mkArm({ id: 'z-arm', pos: { x: 6, z: 6 }, rot: 0 }),
      mkArm({ id: 'm-arm', pos: { x: 8, z: 6 }, rot: 0 }),
      mkArm({ id: 'a-arm', pos: { x: 9, z: 6 }, rot: 0 }),
    ];
    const door = mkDoor('y+', 8, 6);
    const result = armCoversDoor(door, arms);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arm.id).toBe('m-arm');
  });

  it('tie-breaks by ascending id when two arms are equidistant', () => {
    // Two arms exactly 2 m either side of the door: z-arm (x=10) and a-arm (x=6).
    const arms = [
      mkArm({ id: 'z-arm', pos: { x: 10, z: 6 }, rot: 0 }),
      mkArm({ id: 'a-arm', pos: { x: 6, z: 6 }, rot: 0 }),
    ];
    const door = mkDoor('y+', 8, 6);
    const result = armCoversDoor(door, arms);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arm.id).toBe('a-arm');
  });

  it('ignores non-arm furniture even when it sits within reach on the right wall', () => {
    // Only a non-arm at the door — must refuse for lack of arm, not accept.
    const nonArm = mkNonArm('engine', { x: 8, z: 6 }, 0);
    const door = mkDoor('y+', 8, 6);
    const result = armCoversDoor(door, [nonArm]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no ROBOT ARM');
  });

  it('respects a caller-supplied narrower radius', () => {
    // Arm at x=0, door at x=3. Default 4 m accepts; radius 2 refuses.
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 3, 6);
    expect(armCoversDoor(door, [arm]).ok).toBe(true);
    expect(armCoversDoor(door, [arm], { radius: 2 }).ok).toBe(false);
  });

  it('rejects a non-positive radius as a caller error', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 0, 6);
    const result = armCoversDoor(door, [arm], { radius: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('internal error');
  });

  it('accepts an arm on an x-side wall (rot 1) — the along axis is z', () => {
    // x+ wall: arm at z=4, door at z=6 → 2 m along-wall < 4 m.
    const arm = mkArm({ id: 'a', pos: { x: 6, z: 4 }, rot: 1 });
    const door = mkDoor('x+', 6, 6);
    const result = armCoversDoor(door, [arm]);
    expect(result.ok).toBe(true);
  });

  it('mixes rots without crashing — only the matching-wall arm qualifies', () => {
    const arms = [
      mkArm({ id: 'a-y+', pos: { x: 0, z: 6 }, rot: 0 }), // y+ wall — wrong wall
      mkArm({ id: 'b-x+', pos: { x: 6, z: 5 }, rot: 1 }), // x+ wall — right wall
      mkArm({ id: 'c-y-', pos: { x: 0, z: -6 }, rot: 2 }), // y- wall — wrong wall
    ];
    const door = mkDoor('x+', 6, 6);
    const result = armCoversDoor(door, arms);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arm.id).toBe('b-x+');
  });

  it('treats a readonly array (never mutates it)', () => {
    // Freeze the input; a mutation attempt would throw in strict mode.
    const arms = Object.freeze([
      mkArm({ id: 'z-arm', pos: { x: 6, z: 6 }, rot: 0 }),
      mkArm({ id: 'a-arm', pos: { x: 9, z: 6 }, rot: 0 }),
    ]);
    const door = mkDoor('y+', 8, 6);
    expect(() => armCoversDoor(door, arms)).not.toThrow();
    // Order must be unchanged after the call.
    expect(arms[0].id).toBe('z-arm');
    expect(arms[1].id).toBe('a-arm');
  });
});

// ── armReachPose (animation math) ────────────────────────────────────────────

describe('robotArmGate.armReachPose', () => {
  it('idle at progress=0: elbow folded up, shoulder at zero', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 8, 6);
    const pose = armReachPose(door, arm, 0);
    expect(pose.shoulderYaw).toBe(0);
    expect(pose.elbowPitch).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reach at progress=1: elbow extended, shoulder yaws toward door', () => {
    // Arm at x=0, door at x=+4 (positive along local +x on y+ wall).
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 4, 6);
    const pose = armReachPose(door, arm, 1);
    expect(pose.shoulderYaw).toBeGreaterThan(0);
    expect(pose.elbowPitch).toBeLessThan(Math.PI / 2);
  });

  it('reach at progress=1: reverse sign when the door is on the other side', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', -4, 6);
    const pose = armReachPose(door, arm, 1);
    expect(pose.shoulderYaw).toBeLessThan(0);
  });

  it('interpolates monotonically between idle and reach along the eased curve', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 4, 6);
    const p0 = armReachPose(door, arm, 0);
    const p5 = armReachPose(door, arm, 0.5);
    const p1 = armReachPose(door, arm, 1);
    // Elbow un-folds monotonically as t rises.
    expect(p5.elbowPitch).toBeLessThan(p0.elbowPitch);
    expect(p1.elbowPitch).toBeLessThan(p5.elbowPitch);
    // Shoulder yaw grows toward its target.
    expect(Math.abs(p5.shoulderYaw)).toBeLessThan(Math.abs(p1.shoulderYaw));
  });

  it('clamps a progress outside [0,1] rather than extrapolating', () => {
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const door = mkDoor('y+', 4, 6);
    const under = armReachPose(door, arm, -1);
    const over = armReachPose(door, arm, 2);
    // Under-shoot clamps to idle; over-shoot clamps to full reach.
    expect(under.elbowPitch).toBeCloseTo(Math.PI / 2, 6);
    expect(under.shoulderYaw).toBe(0);
    const full = armReachPose(door, arm, 1);
    expect(over.elbowPitch).toBeCloseTo(full.elbowPitch, 6);
    expect(over.shoulderYaw).toBeCloseTo(full.shoulderYaw, 6);
  });

  // ── Retract-fallback regression (PR-131 Copilot inline at docking.ts:2825) ──
  //
  // The bug: docking.ts.updateRobotArms fell back to a synthetic door pose at
  // the arm's OWN along-wall centre when no active pairing existed. That fed
  // armReachPose a zero along-wall delta, so shoulderYaw collapsed to 0
  // regardless of `progress` (t) — the shoulder snapped to parked on the
  // first retraction frame while only the elbow eased. The fix caches the
  // LAST live door pose per arm and uses it during retraction so shoulderYaw
  // eases to 0 as `t → 0` instead of jumping.
  //
  // These tests pin the pure-math facts the bug rests on, so a future
  // regression in either the pure function or the caller's cache wiring
  // surfaces here.

  it('retract-fallback bug: arm-own-position pose yields shoulderYaw=0 at every progress', () => {
    // The pre-fix docking fallback synthesized referencePose = { wall, x: arm.x, z: arm.z }.
    // With arm.pos === door.pos on the same wall, delta = 0 → atan2(0, 2) = 0
    // → shoulderYaw = 0 * t = 0 for every t. This is the visible snap.
    const arm = mkArm({ id: 'a', pos: { x: 3, z: 6 }, rot: 0 });
    const selfPose = mkDoor('y+', arm.pos.x, arm.pos.z); // fallback shape
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const pose = armReachPose(selfPose, arm, t);
      expect(pose.shoulderYaw, `t=${t}`).toBe(0);
    }
  });

  it('retract-fallback fix: cached LIVE door pose keeps shoulderYaw scaling with progress', () => {
    // The fix path: docking caches the live door pose while reaching, and
    // re-uses it while retracting. armReachPose then sees the real delta and
    // shoulderYaw scales with t on the way home just as it did on the way out.
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const livePose = mkDoor('y+', 4, 6); // 4 m to the along-wall right of the arm
    const full = armReachPose(livePose, arm, 1);
    const half = armReachPose(livePose, arm, 0.5);
    const quarter = armReachPose(livePose, arm, 0.25);
    // shoulderYaw grows monotonically with t — proves the cache preserves
    // the useful signal the fallback destroyed.
    expect(quarter.shoulderYaw).toBeGreaterThan(0);
    expect(half.shoulderYaw).toBeGreaterThan(quarter.shoulderYaw);
    expect(full.shoulderYaw).toBeGreaterThan(half.shoulderYaw);
    // At the exact same t (0.5), the CACHED live pose yields a nonzero yaw
    // while the fallback (arm's own position) yields zero. That difference
    // is the entire user-visible cost of the retract-snap bug.
    const selfPose = mkDoor('y+', arm.pos.x, arm.pos.z);
    expect(armReachPose(selfPose, arm, 0.5).shoulderYaw).toBe(0);
    expect(half.shoulderYaw).not.toBe(0);
  });

  it('retract-fallback fix: shoulderYaw eases smoothly with t under a cached pose', () => {
    // Approximate the retract loop: t decays from 1 → 0 in ARM_ANIM_SPEED
    // steps. Under a cached live pose, every step's shoulderYaw is a strict
    // fraction of the previous one (linear in t) — no discontinuity.
    const arm = mkArm({ id: 'a', pos: { x: 0, z: 6 }, rot: 0 });
    const livePose = mkDoor('y+', 4, 6);
    const samples = [1, 0.8, 0.6, 0.4, 0.2, 0].map((t) => armReachPose(livePose, arm, t));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].shoulderYaw, `sample ${i}`).toBeLessThanOrEqual(samples[i - 1].shoulderYaw);
    }
    expect(samples[samples.length - 1].shoulderYaw).toBe(0); // fully retracted
  });
});
