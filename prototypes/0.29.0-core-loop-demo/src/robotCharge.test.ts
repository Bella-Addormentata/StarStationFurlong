/**
 * 🔋 robotCharge tests — validators + tracker + dock claim (#77 charge slice).
 *
 * These tests cover the ENGINE-PURE side (no THREE, no Y.js) of the robot
 * charge model: shape+bounds guards on hostile ChargeParams, deterministic
 * charge/discharge derivation from a dt sequence, low-charge trigger,
 * dt-clamp safety, and the multi-dock claim's nearest+stable-tie-break rule.
 */

import { describe, expect, it } from 'vitest';
import {
  CHARGE_SECS_MAX,
  CHARGE_SECS_MIN,
  DEFAULT_CHARGE_PARAMS,
  DISCHARGE_SECS_MAX,
  DISCHARGE_SECS_MIN,
  LOW_PERCENT_MAX,
  LOW_PERCENT_MIN,
  RobotChargeTracker,
  isChargeParams,
  pickDockForRobot,
  type ChargeParams,
  type DockCandidate,
} from './robotCharge';

// ── isChargeParams — the doc-boundary guard ─────────────────────────────────

describe('isChargeParams', () => {
  it('accepts the module defaults', () => {
    expect(isChargeParams(DEFAULT_CHARGE_PARAMS)).toBe(true);
  });
  it('accepts a legal owner-tuned triple', () => {
    expect(isChargeParams({ dischargeSecs: 600, chargeSecs: 120, lowPercent: 15 })).toBe(true);
  });
  it('accepts the exact-bound values', () => {
    expect(isChargeParams({
      dischargeSecs: DISCHARGE_SECS_MIN, chargeSecs: CHARGE_SECS_MIN, lowPercent: LOW_PERCENT_MIN,
    })).toBe(true);
    expect(isChargeParams({
      dischargeSecs: DISCHARGE_SECS_MAX, chargeSecs: CHARGE_SECS_MAX, lowPercent: LOW_PERCENT_MAX,
    })).toBe(true);
  });
  it('rejects a field outside its bounds', () => {
    expect(isChargeParams({ dischargeSecs: DISCHARGE_SECS_MIN - 1, chargeSecs: 60, lowPercent: 20 })).toBe(false);
    expect(isChargeParams({ dischargeSecs: 300, chargeSecs: CHARGE_SECS_MAX + 1, lowPercent: 20 })).toBe(false);
    expect(isChargeParams({ dischargeSecs: 300, chargeSecs: 60, lowPercent: LOW_PERCENT_MAX + 1 })).toBe(false);
    expect(isChargeParams({ dischargeSecs: 300, chargeSecs: 60, lowPercent: 0 })).toBe(false);
  });
  it('rejects non-finite / non-numeric fields', () => {
    expect(isChargeParams({ dischargeSecs: NaN, chargeSecs: 60, lowPercent: 20 })).toBe(false);
    expect(isChargeParams({ dischargeSecs: Infinity, chargeSecs: 60, lowPercent: 20 })).toBe(false);
    expect(isChargeParams({ dischargeSecs: '300', chargeSecs: 60, lowPercent: 20 })).toBe(false);
    expect(isChargeParams(null)).toBe(false);
    expect(isChargeParams('none')).toBe(false);
  });
  it('rejects an object missing any field', () => {
    expect(isChargeParams({ dischargeSecs: 300, chargeSecs: 60 })).toBe(false);
    expect(isChargeParams({ chargeSecs: 60, lowPercent: 20 })).toBe(false);
    expect(isChargeParams({})).toBe(false);
  });
});

// ── Tracker — dt-driven determinism + clamps ────────────────────────────────

describe('RobotChargeTracker — construction + reading', () => {
  it('starts at 100 % and reports full when docked', () => {
    const t = new RobotChargeTracker();
    expect(t.percent()).toBe(100);
    expect(t.reading()).toEqual({ percent: 100, charging: false, full: false, low: false });
    // docked=true at 100 % ⇒ full (LED green), not charging
    t.advance(1, true);
    const r = t.reading();
    expect(r.percent).toBe(100);
    expect(r.full).toBe(true);
    expect(r.charging).toBe(false);
    expect(r.low).toBe(false);
  });
  it('snaps an out-of-range startPercent into [0,100]', () => {
    expect(new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, -5).percent()).toBe(0);
    expect(new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, 250).percent()).toBe(100);
    expect(new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, NaN).percent()).toBe(100);
  });
  it('falls back to defaults when handed hostile params', () => {
    const t = new RobotChargeTracker({ bad: 'stuff' } as unknown as ChargeParams);
    // Should discharge at DEFAULT_CHARGE_PARAMS rate — 100/300 %/s. Fed in
    // 1 s ticks so DT_CEILING (5 s) doesn't clamp any single call short of the
    // 30 s the test intends.
    for (let i = 0; i < 30; i++) t.advance(1, false);
    expect(t.percent()).toBeCloseTo(90, 5);
  });
});

describe('RobotChargeTracker — discharge / charge derivation', () => {
  const params: ChargeParams = { dischargeSecs: 100, chargeSecs: 50, lowPercent: 20 };

  it('discharges linearly at 100/dischargeSecs %/s', () => {
    const t = new RobotChargeTracker(params);
    // 10 s undocked, discharge rate 1 %/s → 10 % lost
    t.advance(1, false); t.advance(1, false); t.advance(1, false); t.advance(1, false); t.advance(1, false);
    t.advance(1, false); t.advance(1, false); t.advance(1, false); t.advance(1, false); t.advance(1, false);
    expect(t.percent()).toBeCloseTo(90, 5);
  });

  it('charges linearly at 100/chargeSecs %/s', () => {
    const t = new RobotChargeTracker(params);
    t.reset(0, false);
    // 5 s docked, charge rate 2 %/s → 10 %
    for (let i = 0; i < 5; i++) t.advance(1, true);
    expect(t.percent()).toBeCloseTo(10, 5);
  });

  it('produces the SAME percent for the same dt+docked sequence (determinism)', () => {
    const seq: Array<[number, boolean]> = [
      [0.5, false], [0.7, false], [1, true], [0.3, false], [2, true], [1.5, false],
    ];
    const a = new RobotChargeTracker(params, 50);
    const b = new RobotChargeTracker(params, 50);
    for (const [dt, docked] of seq) {
      a.advance(dt, docked);
      b.advance(dt, docked);
    }
    expect(a.percent()).toEqual(b.percent());
  });

  it('clamps percent at 0 no matter how long undocked', () => {
    const t = new RobotChargeTracker(params, 5);
    for (let i = 0; i < 1000; i++) t.advance(1, false);
    expect(t.percent()).toBe(0);
  });

  it('clamps percent at 100 no matter how long docked', () => {
    const t = new RobotChargeTracker(params, 95);
    for (let i = 0; i < 1000; i++) t.advance(1, true);
    expect(t.percent()).toBe(100);
  });
});

describe('RobotChargeTracker — safety and edge cases', () => {
  it('clamps a huge dt to DT_CEILING (a tab-freeze cannot brick the battery)', () => {
    const params: ChargeParams = { dischargeSecs: 60, chargeSecs: 60, lowPercent: 20 };
    const t = new RobotChargeTracker(params, 100);
    // 1000 s undocked would nominally drain past 0 many times; the clamp
    // must confine one tick to at most DT_CEILING (5 s) → at most 5/60 * 100
    // ≈ 8.33 % drained per call.
    t.advance(1000, false);
    expect(t.percent()).toBeCloseTo(100 - (5 * 100) / 60, 4);
  });

  it('treats negative dt as zero (defensive against caller bug)', () => {
    const t = new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, 50);
    t.advance(-999, false);
    expect(t.percent()).toBe(50);
    t.advance(-1, true);
    expect(t.percent()).toBe(50);
  });

  it('isLow triggers exactly when percent drops below params.lowPercent', () => {
    const params: ChargeParams = { dischargeSecs: 100, chargeSecs: 50, lowPercent: 20 };
    const t = new RobotChargeTracker(params, 25);
    expect(t.isLow()).toBe(false);
    // Discharge 5 s (5 %) → 20 % — NOT strictly < 20
    t.advance(5, false);
    expect(t.percent()).toBeCloseTo(20, 5);
    expect(t.isLow()).toBe(false);
    // Discharge one more tick — now under 20
    t.advance(0.01, false);
    expect(t.isLow()).toBe(true);
    expect(t.reading().low).toBe(true);
  });

  it('reading marks charging while docked and under 100', () => {
    const t = new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, 60);
    t.advance(1, true);
    const r = t.reading();
    expect(r.charging).toBe(true);
    expect(r.full).toBe(false);
    expect(r.low).toBe(false);
  });

  it('setParams updates the envelope without wiping percent', () => {
    const t = new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, 40);
    t.setParams({ dischargeSecs: 100, chargeSecs: 100, lowPercent: 50 });
    expect(t.percent()).toBe(40);
    expect(t.isLow()).toBe(true); // 40 < new threshold 50
  });

  it('setParams falls back to defaults on rejection', () => {
    const t = new RobotChargeTracker(DEFAULT_CHARGE_PARAMS, 100);
    t.setParams({ foo: 'bar' });
    // Should discharge at defaults (300 s → 100 %) — 30 s should drop ~10 %.
    // Split into 1 s ticks so DT_CEILING (5 s) doesn't clamp the total.
    for (let i = 0; i < 30; i++) t.advance(1, false);
    expect(t.percent()).toBeCloseTo(90, 5);
  });
});

// ── pickDockForRobot — deterministic multi-dock claim ────────────────────────

describe('pickDockForRobot', () => {
  const A: DockCandidate = { id: 'a', x: 0, z: 0 };
  const B: DockCandidate = { id: 'b', x: 4, z: 0 };
  const C: DockCandidate = { id: 'c', x: 0, z: 4 };

  it('returns null when there are no candidates', () => {
    expect(pickDockForRobot(0, 0, [])).toBeNull();
  });

  it('honours an assigned dock even when it is not the nearest', () => {
    // Robot standing on top of B; assigned is A → A wins.
    expect(pickDockForRobot(4, 0, [A, B, C], 'a')?.id).toBe('a');
  });

  it('ignores an assigned id that no longer exists in the candidate list', () => {
    // Assigned "gone" — falls through to nearest.
    expect(pickDockForRobot(4, 0, [A, B, C], 'gone')?.id).toBe('b');
  });

  it('picks the nearest candidate when no assignment is given', () => {
    // Robot at (0, 4) → C is on top, distance 0.
    expect(pickDockForRobot(0, 4, [A, B, C])?.id).toBe('c');
  });

  it('breaks ties by id (stable, deterministic across clients)', () => {
    // Two docks equidistant from the robot (dist 5 each).
    const d1: DockCandidate = { id: 'zeta', x: 3, z: 4 };
    const d2: DockCandidate = { id: 'alpha', x: -3, z: 4 };
    const picked = pickDockForRobot(0, 0, [d1, d2]);
    expect(picked?.id).toBe('alpha');
  });

  it('picks the same dock regardless of candidate array order (same input set)', () => {
    const set = [A, B, C];
    const orderings = [
      [A, B, C],
      [A, C, B],
      [B, A, C],
      [B, C, A],
      [C, A, B],
      [C, B, A],
    ];
    const robot = { x: 1, z: 1 };
    const first = pickDockForRobot(robot.x, robot.z, set)?.id;
    for (const o of orderings) {
      expect(pickDockForRobot(robot.x, robot.z, o)?.id).toBe(first);
    }
  });

  it('returns the assigned dock even when it is far and there is a nearer alternative', () => {
    const near: DockCandidate = { id: 'near', x: 1, z: 1 };
    const far: DockCandidate = { id: 'far', x: 20, z: 20 };
    expect(pickDockForRobot(0, 0, [near, far], 'far')?.id).toBe('far');
    expect(pickDockForRobot(0, 0, [near, far])?.id).toBe('near');
  });
});
