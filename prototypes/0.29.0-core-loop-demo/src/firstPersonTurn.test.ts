import { describe, expect, it } from 'vitest';
import { isTurnKey, turnYawStep, TURN_SPEED } from './firstPersonTurn';

describe('first-person Q/E turning', () => {
  it('Q turns left (yaw up), E turns right (yaw down)', () => {
    expect(turnYawStep(new Set(['KeyQ']), 0.5)).toBeCloseTo(TURN_SPEED * 0.5);
    expect(turnYawStep(new Set(['KeyE']), 0.5)).toBeCloseTo(-TURN_SPEED * 0.5);
  });

  it('both held, nothing held, or no time passed leaves the view still', () => {
    expect(turnYawStep(new Set(['KeyQ', 'KeyE']), 0.1)).toBe(0);
    expect(turnYawStep(new Set(), 0.1)).toBe(0);
    expect(turnYawStep(new Set(['KeyQ']), 0)).toBe(0);
    expect(turnYawStep(new Set(['KeyQ']), NaN)).toBe(0);
  });

  it('only Q and E are turn keys', () => {
    expect(isTurnKey('KeyQ')).toBe(true);
    expect(isTurnKey('KeyE')).toBe(true);
    expect(isTurnKey('KeyW')).toBe(false);
    expect(turnYawStep(new Set(['KeyW']), 1)).toBe(0);
  });
});

describe('room view Q/E turn direction', () => {
  it('Q is left (1), E is right (-1), other keys 0', async () => {
    const { turnKeyDirection } = await import('./firstPersonTurn');
    expect(turnKeyDirection('KeyQ')).toBe(1);
    expect(turnKeyDirection('KeyE')).toBe(-1);
    expect(turnKeyDirection('KeyW')).toBe(0);
  });
});
