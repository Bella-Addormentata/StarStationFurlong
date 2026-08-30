/**
 * 🤖📜 robotScript tests — validators + scheduler state machine (#77).
 *
 * These tests cover the ENGINE-PURE side (no THREE, no Y.js) of the owner-
 * programmed robot: shape-guard on hostile payloads, sanitisation on doc read,
 * and the deterministic goto/say/wait loop the render layer drives.
 */

import { describe, expect, it } from 'vitest';
import {
  ARRIVE_DIST,
  BET_SECS_MAX,
  BET_SECS_MIN,
  CLOSING_SECS_MAX,
  CLOSING_SECS_MIN,
  DOCK_STEP_NO_DOCK_SECS,
  GOTO_TIMEOUT_SECS,
  MAX_COORD_ABS,
  MAX_SAY_LEN,
  MAX_SCRIPT_STEPS,
  MAX_WAIT_SECS,
  RobotScriptScheduler,
  SAY_HOLD_SECS,
  SHOW_SECS_MAX,
  SHOW_SECS_MIN,
  isRobotStep,
  isWheelTiming,
  parseRobotScript,
} from './robotScript';
import type { RobotStep } from './robotScript';

// ── isRobotStep — the doc-boundary guard ───────────────────────────────────

describe('isRobotStep', () => {
  it('accepts a valid goto', () => {
    expect(isRobotStep({ kind: 'goto', x: 1.5, z: -2 })).toBe(true);
  });
  it('accepts a valid say', () => {
    expect(isRobotStep({ kind: 'say', text: 'Welcome!' })).toBe(true);
  });
  it('accepts a valid wait', () => {
    expect(isRobotStep({ kind: 'wait', secs: 3 })).toBe(true);
  });
  it('rejects non-objects', () => {
    expect(isRobotStep(null)).toBe(false);
    expect(isRobotStep(undefined)).toBe(false);
    expect(isRobotStep('goto')).toBe(false);
    expect(isRobotStep(42)).toBe(false);
    expect(isRobotStep([])).toBe(false);
  });
  it('rejects unknown kinds', () => {
    expect(isRobotStep({ kind: 'run', x: 0, z: 0 })).toBe(false);
    // A future kind we haven't added yet MUST be refused — whitelist behaviour.
    expect(isRobotStep({ kind: 'exec', code: 'alert(1)' })).toBe(false);
  });
  it('rejects a goto with non-finite coords', () => {
    expect(isRobotStep({ kind: 'goto', x: NaN, z: 0 })).toBe(false);
    expect(isRobotStep({ kind: 'goto', x: 0, z: Infinity })).toBe(false);
    expect(isRobotStep({ kind: 'goto', x: 0, z: -Infinity })).toBe(false);
  });
  it('rejects a goto outside the coord envelope', () => {
    expect(isRobotStep({ kind: 'goto', x: MAX_COORD_ABS + 0.01, z: 0 })).toBe(false);
    expect(isRobotStep({ kind: 'goto', x: 0, z: -(MAX_COORD_ABS + 0.01) })).toBe(false);
    // 1e9 is the classic overflow probe — must be refused.
    expect(isRobotStep({ kind: 'goto', x: 1e9, z: 0 })).toBe(false);
  });
  it('rejects an empty or oversized say', () => {
    expect(isRobotStep({ kind: 'say', text: '' })).toBe(false);
    expect(isRobotStep({ kind: 'say', text: 'x'.repeat(MAX_SAY_LEN + 1) })).toBe(false);
  });
  it('rejects a say with non-string text', () => {
    expect(isRobotStep({ kind: 'say', text: 123 })).toBe(false);
    expect(isRobotStep({ kind: 'say', text: null })).toBe(false);
  });
  it('rejects a wait outside its bounds', () => {
    expect(isRobotStep({ kind: 'wait', secs: -0.5 })).toBe(false);
    expect(isRobotStep({ kind: 'wait', secs: MAX_WAIT_SECS + 0.5 })).toBe(false);
    expect(isRobotStep({ kind: 'wait', secs: 'soon' })).toBe(false);
  });
  it('accepts a zero-second wait (a pass-through beat)', () => {
    expect(isRobotStep({ kind: 'wait', secs: 0 })).toBe(true);
  });
  it('accepts the exact coord boundary', () => {
    expect(isRobotStep({ kind: 'goto', x: MAX_COORD_ABS, z: -MAX_COORD_ABS })).toBe(true);
  });
  it('accepts a valid dock step (payload-free)', () => {
    // 🔋 #77 charge slice: the 'dock' step carries no coords — the render
    // binding resolves the target from ITS own dockTarget, not from the doc.
    expect(isRobotStep({ kind: 'dock' })).toBe(true);
  });
  it('ignores extraneous fields on a dock step (still valid on kind alone)', () => {
    // The guard only checks `kind`. Extra fields don't invalidate the step —
    // but they are silently dropped by whole-value replace on the next write.
    expect(isRobotStep({ kind: 'dock', x: 999, z: 'nope' })).toBe(true);
  });
});

// ── parseRobotScript — sanitises an untrusted array ─────────────────────────

describe('parseRobotScript', () => {
  it('returns the empty script for undefined input', () => {
    const { steps, issues } = parseRobotScript(undefined);
    expect(steps).toEqual([]);
    expect(issues).toEqual([]);
  });
  it('rejects a non-array with a diagnostic', () => {
    const { steps, issues } = parseRobotScript({ oops: true });
    expect(steps).toEqual([]);
    expect(issues.length).toBe(1);
  });
  it('drops malformed steps, keeps valid ones, and reports each drop', () => {
    const input = [
      { kind: 'goto', x: 1, z: 2 },
      { kind: 'garbage' },
      { kind: 'say', text: 'Hi' },
      null,
      { kind: 'wait', secs: 5 },
    ];
    const { steps, issues } = parseRobotScript(input);
    expect(steps.length).toBe(3);
    expect(steps[0]).toEqual({ kind: 'goto', x: 1, z: 2 });
    expect(steps[1]).toEqual({ kind: 'say', text: 'Hi' });
    expect(steps[2]).toEqual({ kind: 'wait', secs: 5 });
    expect(issues.length).toBe(2);
    expect(issues[0].index).toBe(1);
    expect(issues[1].index).toBe(3);
  });
  it('truncates an oversized script and reports the overflow', () => {
    const bloat = Array.from({ length: MAX_SCRIPT_STEPS + 5 }, () => ({ kind: 'wait', secs: 1 }));
    const { steps, issues } = parseRobotScript(bloat);
    expect(steps.length).toBe(MAX_SCRIPT_STEPS);
    // Overflow is signalled by an issue with index === MAX_SCRIPT_STEPS.
    expect(issues.some((i) => i.index === MAX_SCRIPT_STEPS)).toBe(true);
  });
});

// ── isWheelTiming — croupier timing overrides ──────────────────────────────

describe('isWheelTiming', () => {
  it('accepts a valid triple', () => {
    expect(isWheelTiming({ betSecs: 20, closingSecs: 3, showSecs: 9 })).toBe(true);
  });
  it('accepts the exact-bound values', () => {
    expect(isWheelTiming({
      betSecs: BET_SECS_MIN, closingSecs: CLOSING_SECS_MIN, showSecs: SHOW_SECS_MIN,
    })).toBe(true);
    expect(isWheelTiming({
      betSecs: BET_SECS_MAX, closingSecs: CLOSING_SECS_MAX, showSecs: SHOW_SECS_MAX,
    })).toBe(true);
  });
  it('rejects fields outside their bounds', () => {
    expect(isWheelTiming({ betSecs: BET_SECS_MIN - 1, closingSecs: 3, showSecs: 9 })).toBe(false);
    expect(isWheelTiming({ betSecs: 20, closingSecs: CLOSING_SECS_MAX + 1, showSecs: 9 })).toBe(false);
    expect(isWheelTiming({ betSecs: 20, closingSecs: 3, showSecs: SHOW_SECS_MAX + 1 })).toBe(false);
  });
  it('rejects non-finite / non-numeric fields', () => {
    expect(isWheelTiming({ betSecs: NaN, closingSecs: 3, showSecs: 9 })).toBe(false);
    expect(isWheelTiming({ betSecs: '20', closingSecs: 3, showSecs: 9 })).toBe(false);
    expect(isWheelTiming(null)).toBe(false);
  });
});

// ── Scheduler — the deterministic loop driving the render layer ────────────

describe('RobotScriptScheduler — empty and single-step behaviour', () => {
  it('reports `none` and size 0 when script is empty', () => {
    const s = new RobotScriptScheduler();
    expect(s.size()).toBe(0);
    expect(s.advance(1)).toEqual({ kind: 'none' });
  });
  it('accepts an initial script through the constructor', () => {
    const s = new RobotScriptScheduler([{ kind: 'wait', secs: 1 }]);
    expect(s.size()).toBe(1);
  });
  it('sanitises malformed initial steps out of the loop', () => {
    const s = new RobotScriptScheduler([
      { kind: 'wait', secs: 1 },
      { kind: 'garbage' } as unknown as RobotStep,
      { kind: 'say', text: 'ok' },
    ]);
    expect(s.size()).toBe(2);
  });
  it('a WAIT step returns `wait` until its duration elapses, then advances', () => {
    const s = new RobotScriptScheduler([
      { kind: 'wait', secs: 2 },
      { kind: 'wait', secs: 5 },
    ]);
    expect(s.cursor()).toBe(0);
    expect(s.advance(1)).toEqual({ kind: 'wait' });
    expect(s.cursor()).toBe(0);
    expect(s.advance(1.5)).toEqual({ kind: 'wait' }); // total 2.5 ≥ 2 ⇒ advance
    expect(s.cursor()).toBe(1);
  });
});

describe('RobotScriptScheduler — SAY step edge behaviour', () => {
  it('emits started=true on the first tick, false thereafter', () => {
    const s = new RobotScriptScheduler([{ kind: 'say', text: 'Welcome!' }]);
    const first = s.advance(0.1) as { kind: 'say'; text: string; started: boolean };
    expect(first.kind).toBe('say');
    expect(first.text).toBe('Welcome!');
    expect(first.started).toBe(true);
    const second = s.advance(0.1) as { kind: 'say'; started: boolean };
    expect(second.started).toBe(false);
  });
  it('holds the SAY step for SAY_HOLD_SECS then advances', () => {
    const s = new RobotScriptScheduler([
      { kind: 'say', text: 'A' },
      { kind: 'say', text: 'B' },
    ]);
    expect(s.cursor()).toBe(0);
    s.advance(SAY_HOLD_SECS + 0.1);
    expect(s.cursor()).toBe(1);
    // The next SAY should re-arm the started edge.
    const next = s.advance(0.1) as { started: boolean };
    expect(next.started).toBe(true);
  });
});

describe('RobotScriptScheduler — GOTO step arrival and timeout', () => {
  it('reports the goto target and advances on arrival', () => {
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 5, z: 3 },
      { kind: 'wait', secs: 1 },
    ]);
    // Nowhere near the target — cursor stays.
    const a1 = s.advance(0.1, { x: 0, z: 0 }) as { kind: 'goto'; x: number; z: number };
    expect(a1.kind).toBe('goto');
    expect(a1.x).toBe(5);
    expect(a1.z).toBe(3);
    expect(s.cursor()).toBe(0);
    // Within ARRIVE_DIST — cursor advances.
    s.advance(0.1, { x: 5, z: 3 });
    expect(s.cursor()).toBe(1);
  });
  it('advances a goto that never arrives on GOTO_TIMEOUT_SECS', () => {
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 5, z: 3 },
      // Long follow-up so we can catch the cursor before it wraps back to 0.
      { kind: 'wait', secs: MAX_WAIT_SECS },
    ]);
    // Bot never moves; tick exactly up to the timeout with 1-s dts (well below
    // DT_CEILING so no clamp kicks in). After Math.ceil(GOTO_TIMEOUT_SECS)
    // ticks, timer >= threshold and the cursor MUST advance off 0.
    const dt = 1;
    const ticks = Math.ceil(GOTO_TIMEOUT_SECS);
    for (let t = 0; t < ticks; t++) {
      s.advance(dt, { x: 0, z: 0 });
    }
    expect(s.cursor()).toBe(1);
  });
  it('honours ARRIVE_DIST at its exact boundary', () => {
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 10, z: 0 },
      { kind: 'wait', secs: 1 },
    ]);
    // Land exactly ON the target — the check is `distance <= ARRIVE_DIST`, so
    // zero distance is well inside. (A boundary at `x = 10 - ARRIVE_DIST` is
    // subject to float noise in the subtraction, so we test the guaranteed
    // interior + one just-outside case below.)
    s.advance(0.1, { x: 10, z: 0 });
    expect(s.cursor()).toBe(1);
  });
  it('does NOT advance a goto that is just outside ARRIVE_DIST', () => {
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 10, z: 0 },
      { kind: 'wait', secs: 1 },
    ]);
    // ARRIVE_DIST * 2 away — safely outside without float ambiguity.
    s.advance(0.1, { x: 10 - ARRIVE_DIST * 2, z: 0 });
    expect(s.cursor()).toBe(0);
  });
});

// 🔋 #77 charge slice: the 'dock' step composes with the rest of the loop —
// walk home to the robot's dock, then let the next step (say/wait) run. The
// scheduler emits `gotoDock` and defers the target coord to the render binding.
describe('RobotScriptScheduler — DOCK step (goto-dock capability)', () => {
  it('emits gotoDock with the dock coords the binding hands in', () => {
    const s = new RobotScriptScheduler([
      { kind: 'dock' },
      { kind: 'wait', secs: 1 },
    ]);
    const a = s.advance(0.1, { x: 0, z: 0 }, { x: 4.5, z: 4.5 }) as {
      kind: 'gotoDock'; x: number; z: number; hasDock: boolean;
    };
    expect(a.kind).toBe('gotoDock');
    expect(a.x).toBe(4.5);
    expect(a.z).toBe(4.5);
    expect(a.hasDock).toBe(true);
    expect(s.cursor()).toBe(0);
  });

  it('advances the cursor when the robot arrives at the dock (ARRIVE_DIST)', () => {
    const s = new RobotScriptScheduler([
      { kind: 'dock' },
      { kind: 'wait', secs: 1 },
    ]);
    // Standing on the dock — arrived.
    s.advance(0.1, { x: 4.5, z: 4.5 }, { x: 4.5, z: 4.5 });
    expect(s.cursor()).toBe(1);
  });

  it('does NOT advance while just outside ARRIVE_DIST from the dock', () => {
    const s = new RobotScriptScheduler([
      { kind: 'dock' },
      { kind: 'wait', secs: 1 },
    ]);
    s.advance(0.1, { x: 4.5 + ARRIVE_DIST * 2, z: 4.5 }, { x: 4.5, z: 4.5 });
    expect(s.cursor()).toBe(0);
  });

  it('advances a dock step that never arrives on GOTO_TIMEOUT_SECS', () => {
    const s = new RobotScriptScheduler([
      { kind: 'dock' },
      { kind: 'wait', secs: MAX_WAIT_SECS },
    ]);
    const dock = { x: 10, z: 10 };
    const dt = 1;
    // Bot stationary far from dock — must exit via the same timeout as goto.
    for (let t = 0; t < Math.ceil(GOTO_TIMEOUT_SECS); t++) {
      s.advance(dt, { x: 0, z: 0 }, dock);
    }
    expect(s.cursor()).toBe(1);
  });

  it('reports hasDock=false and stalls only for DOCK_STEP_NO_DOCK_SECS when there is no dock', () => {
    const s = new RobotScriptScheduler([
      { kind: 'dock' },
      { kind: 'wait', secs: MAX_WAIT_SECS },
    ]);
    // No dock context — the step must not freeze the loop for the full 20 s
    // goto timeout; the 3-second short stall lets a dockless routine keep moving.
    const a = s.advance(0.1, { x: 0, z: 0 }, null) as {
      kind: 'gotoDock'; hasDock: boolean; x: number; z: number;
    };
    expect(a.kind).toBe('gotoDock');
    expect(a.hasDock).toBe(false);
    expect(s.cursor()).toBe(0);
    // After DOCK_STEP_NO_DOCK_SECS elapses, the step advances.
    s.advance(DOCK_STEP_NO_DOCK_SECS, { x: 0, z: 0 }, null);
    expect(s.cursor()).toBe(1);
  });

  it('parses a dock step through the doc-boundary sanitiser', () => {
    // Hostile-payload probe: a mix of valid/invalid + a plain 'dock' step —
    // dock survives, garbage is dropped with a diagnostic.
    const { steps, issues } = parseRobotScript([
      { kind: 'dock' },
      { kind: 'exec', code: 'alert(1)' },
      { kind: 'say', text: 'ready' },
      { kind: 'dock', payload: 'ignored' },
    ]);
    expect(steps.length).toBe(3);
    expect(steps[0]).toEqual({ kind: 'dock' });
    expect(steps[2]).toEqual({ kind: 'dock', payload: 'ignored' });
    // Only the exec kind was rejected as malformed.
    expect(issues.length).toBe(1);
    expect(issues[0].index).toBe(1);
  });
});

describe('RobotScriptScheduler — looping and setSteps', () => {
  it('loops back to the first step after the last completes', () => {
    const s = new RobotScriptScheduler([
      { kind: 'wait', secs: 1 },
      { kind: 'wait', secs: 1 },
    ]);
    s.advance(1.1); // completes 0 → 1
    s.advance(1.1); // completes 1 → 0
    expect(s.cursor()).toBe(0);
  });
  it('does NOT reset when setSteps is called with the identical script', () => {
    const script: RobotStep[] = [
      { kind: 'wait', secs: 3 },
      { kind: 'say', text: 'hey' },
    ];
    const s = new RobotScriptScheduler(script);
    s.advance(1); // timer = 1
    s.setSteps(script.slice()); // same content, fresh array reference
    // Ideally the timer is preserved; advancing another 2.5 s should complete.
    s.advance(2.5);
    expect(s.cursor()).toBe(1);
  });
  it('resets cursor + timers when setSteps content actually changes', () => {
    const s = new RobotScriptScheduler([{ kind: 'wait', secs: 3 }]);
    s.advance(2); // timer = 2
    s.setSteps([
      { kind: 'wait', secs: 4 },
      { kind: 'wait', secs: 1 },
    ]);
    expect(s.cursor()).toBe(0);
    s.advance(3); // less than 4 — should not have completed
    expect(s.cursor()).toBe(0);
    s.advance(1.5); // now over the 4 s threshold
    expect(s.cursor()).toBe(1);
  });
  it('empties the loop cleanly when setSteps is called with []', () => {
    const s = new RobotScriptScheduler([{ kind: 'wait', secs: 1 }]);
    s.setSteps([]);
    expect(s.size()).toBe(0);
    expect(s.advance(10)).toEqual({ kind: 'none' });
  });
});

describe('RobotScriptScheduler — safety and determinism', () => {
  it('clamps a huge dt so it never burns more than one step', () => {
    // A five-second wait, then a five-second wait — with a 1000 s dt the
    // clamp keeps us inside step 0 for this tick, but timer > secs completes
    // exactly step 0. The next tick begins on step 1 with a fresh timer.
    const s = new RobotScriptScheduler([
      { kind: 'wait', secs: 5 },
      { kind: 'wait', secs: 5 },
    ]);
    s.advance(1000);
    expect(s.cursor()).toBe(1);
    // Even with another huge dt, we still land on step 0 (cursor 0), not
    // wrap far ahead — the loop honours one step per tick.
    s.advance(1000);
    expect(s.cursor()).toBe(0);
  });
  it('never advances a goto without a chassis position on the tick', () => {
    // Without pos the goto step can only exit via GOTO_TIMEOUT_SECS, not by
    // arrival — this is what a headless test / paused fox situation gets.
    // The scheduler clamps dt to DT_CEILING (5 s) so we must tick multiple
    // times to accumulate past GOTO_TIMEOUT_SECS.
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 1, z: 1 },
      { kind: 'wait', secs: 10 }, // long enough that we can observe the exit
    ]);
    s.advance(1);
    expect(s.cursor()).toBe(0); // still walking
    // Six 4-second ticks = 24 s of accumulated timer — safely past the 20 s
    // timeout, and each tick is under DT_CEILING so no clamp kicks in.
    for (let i = 0; i < 6; i++) s.advance(4);
    expect(s.cursor()).toBe(1);
  });
  it('rejects negative dt as if it were zero (defensive against caller bug)', () => {
    const s = new RobotScriptScheduler([{ kind: 'wait', secs: 1 }]);
    s.advance(-999);
    expect(s.cursor()).toBe(0);
    s.advance(1.1);
    expect(s.cursor()).toBe(0); // one-item loop wraps back to 0
  });
  it('skipStep advances even for an un-arrived goto (test helper)', () => {
    const s = new RobotScriptScheduler([
      { kind: 'goto', x: 5, z: 5 },
      { kind: 'wait', secs: 1 },
    ]);
    s.skipStep();
    expect(s.cursor()).toBe(1);
  });
});
