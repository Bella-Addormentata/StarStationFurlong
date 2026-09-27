/**
 * 🔍 robotDoc shape-guard tests — isRobotConfig at the room-doc trust boundary
 * (#77 charge slice).
 *
 * The dock config `robot` map crosses the CRDT boundary: a hostile peer's write
 * lands on every reader's client, and the guard is what keeps a nonsense field
 * out of the render layer. These tests cover:
 *   • the new `chargeParams` branch — refused wholesale when the envelope fails
 *   • the pre-existing branches (routine / script / parked / wheelTiming) still
 *     survive alongside a valid chargeParams payload
 *   • hostile shapes (extra fields, wrong types, missing fields) are refused
 *
 * The module writes a debugging handle to window at load; robotDoc guards that
 * against a missing `window` so this node-env test can import it safely.
 */

import { describe, expect, it } from 'vitest';
import { isRobotConfig } from './robotDoc';
import { DEFAULT_CHARGE_PARAMS } from './robotCharge';

describe('isRobotConfig — routine baseline', () => {
  it('accepts a minimal serve config', () => {
    expect(isRobotConfig({ routine: 'serve' })).toBe(true);
  });
  it('accepts every canonical routine name', () => {
    for (const r of ['serve', 'croupier', 'idle', 'custom'] as const) {
      expect(isRobotConfig({ routine: r })).toBe(true);
    }
  });
  it('rejects a bogus routine name', () => {
    expect(isRobotConfig({ routine: 'sabotage' })).toBe(false);
    expect(isRobotConfig({ routine: '' })).toBe(false);
    expect(isRobotConfig({})).toBe(false);
    expect(isRobotConfig(null)).toBe(false);
  });
});

describe('isRobotConfig — chargeParams branch (#77 charge slice)', () => {
  it('accepts an omitted chargeParams field (owner never tuned)', () => {
    expect(isRobotConfig({ routine: 'serve' })).toBe(true);
    expect(isRobotConfig({ routine: 'idle', chargeParams: undefined })).toBe(true);
  });

  it('accepts the module DEFAULT_CHARGE_PARAMS triple', () => {
    expect(isRobotConfig({ routine: 'idle', chargeParams: DEFAULT_CHARGE_PARAMS })).toBe(true);
  });

  it('accepts a legal owner-tuned chargeParams triple', () => {
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: 600, chargeSecs: 120, lowPercent: 15 },
      }),
    ).toBe(true);
  });

  it('rejects a chargeParams outside its envelope (hostile peer)', () => {
    // dischargeSecs < DISCHARGE_SECS_MIN — battery-in-seconds attack.
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: 5, chargeSecs: 60, lowPercent: 20 },
      }),
    ).toBe(false);
    // chargeSecs > CHARGE_SECS_MAX — battery-never-charges attack.
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: 300, chargeSecs: 999999, lowPercent: 20 },
      }),
    ).toBe(false);
    // lowPercent = 0 — trigger-never attack.
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: 300, chargeSecs: 60, lowPercent: 0 },
      }),
    ).toBe(false);
  });

  it('rejects a chargeParams that is not an object', () => {
    expect(isRobotConfig({ routine: 'serve', chargeParams: 'oops' })).toBe(false);
    expect(isRobotConfig({ routine: 'serve', chargeParams: 42 })).toBe(false);
    expect(isRobotConfig({ routine: 'serve', chargeParams: null })).toBe(false);
    expect(isRobotConfig({ routine: 'serve', chargeParams: [] })).toBe(false);
  });

  it('rejects a chargeParams missing any field', () => {
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: 300, chargeSecs: 60 },
      }),
    ).toBe(false);
  });

  it('rejects a chargeParams whose fields are non-finite', () => {
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: NaN, chargeSecs: 60, lowPercent: 20 },
      }),
    ).toBe(false);
    expect(
      isRobotConfig({
        routine: 'serve',
        chargeParams: { dischargeSecs: Infinity, chargeSecs: 60, lowPercent: 20 },
      }),
    ).toBe(false);
  });
});

describe('isRobotConfig — script/parked/wheelTiming coexistence with chargeParams', () => {
  it('accepts every optional field together (a fully-tuned dock)', () => {
    expect(
      isRobotConfig({
        routine: 'custom',
        script: [
          { kind: 'goto', x: 1, z: 1 },
          { kind: 'say', text: 'hi' },
          { kind: 'wait', secs: 3 },
          { kind: 'dock' }, // 🔋 charge-slice step composes with the loop
        ],
        parked: false,
        wheelTiming: { betSecs: 18, closingSecs: 3, showSecs: 9 },
        chargeParams: { dischargeSecs: 300, chargeSecs: 60, lowPercent: 20 },
      }),
    ).toBe(true);
  });

  it('rejects the whole config when chargeParams is bad, even if other fields are valid', () => {
    expect(
      isRobotConfig({
        routine: 'custom',
        script: [{ kind: 'dock' }],
        parked: false,
        wheelTiming: { betSecs: 18, closingSecs: 3, showSecs: 9 },
        chargeParams: { dischargeSecs: 1, chargeSecs: 60, lowPercent: 20 },
      }),
    ).toBe(false);
  });
});
