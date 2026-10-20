/**
 * 🤖↔🦊 Robot personal space — robotSpace.ts.
 *
 * The drink server used to walk straight through a player standing on its
 * route (owner report 2026-10-20, at the craps rail). These cases pin the
 * rules: swerve round a player ahead, wait when there's no room, never step
 * closer to someone already too close, and back off to the serve standoff.
 */
import { describe, expect, it } from 'vitest';
import {
  LOOKAHEAD,
  PERSONAL_SPACE,
  SERVE_STANDOFF,
  backOffStep,
  occupied,
  steerStep,
  type XZ,
} from './robotSpace';

const open = (): boolean => true;
const EAST: XZ = { x: 1, z: 0 };

/** Walk a robot along +x for `secs`, steering round `avatars`; returns the
 *  closest it ever got to any of them. */
function walkPast(
  start: XZ,
  avatars: XZ[],
  isFree: (x: number, z: number) => boolean = open,
  secs = 6,
): number {
  const pos = { ...start };
  let closest = Infinity;
  const dt = 1 / 60;
  for (let t = 0; t < secs; t += dt) {
    const dir = steerStep(pos, EAST, avatars, isFree);
    if (dir) {
      pos.x += dir.x * 1.15 * dt;
      pos.z += dir.z * 1.15 * dt;
    }
    for (const a of avatars) closest = Math.min(closest, Math.hypot(a.x - pos.x, a.z - pos.z));
  }
  return closest;
}

describe('steerStep', () => {
  it('walks straight on when nobody is in the way', () => {
    expect(steerStep({ x: 0, z: 0 }, EAST, [], open)).toEqual(EAST);
    expect(steerStep({ x: 0, z: 0 }, EAST, [{ x: 0, z: 3 }], open)).toEqual(EAST);
  });

  it('swerves round a player standing on the route, never entering their space', () => {
    const player = { x: 2, z: 0 };
    const dir = steerStep({ x: 2 - PERSONAL_SPACE - LOOKAHEAD * 0.5, z: 0 }, EAST, [player], open);
    expect(dir).not.toBeNull();
    expect(dir).not.toEqual(EAST);
    expect(walkPast({ x: 0, z: 0 }, [player])).toBeGreaterThanOrEqual(PERSONAL_SPACE - 0.05);
  });

  it('swerves away from the side the player is on', () => {
    const dir = steerStep({ x: 0.5, z: 0 }, EAST, [{ x: 1.5, z: 0.2 }], open)!;
    expect(dir.z).toBeLessThan(0);
  });

  it('stands and waits when the aisle is blocked and there is no room to swerve', () => {
    const corridor = (_x: number, z: number): boolean => Math.abs(z) < 0.2;
    const player = { x: 2, z: 0 };
    expect(steerStep({ x: 2 - PERSONAL_SPACE, z: 0 }, EAST, [player], corridor)).toBeNull();
    expect(walkPast({ x: 0, z: 0 }, [player], corridor)).toBeGreaterThanOrEqual(PERSONAL_SPACE - 0.05);
  });

  it('never steps closer to a player who walked up inside its space', () => {
    const pos = { x: 0, z: 0 };
    const player = { x: 0.5, z: 0 };
    const dir = steerStep(pos, EAST, [player], open);
    if (dir) {
      const before = Math.hypot(player.x - pos.x, player.z - pos.z);
      const after = Math.hypot(player.x - (pos.x + dir.x * LOOKAHEAD), player.z - (pos.z + dir.z * LOOKAHEAD));
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });
});

describe('occupied', () => {
  it('flags a route point somebody stands on', () => {
    expect(occupied({ x: 0, z: 0 }, [{ x: 0.4, z: 0.3 }])).toBe(true);
    expect(occupied({ x: 0, z: 0 }, [{ x: 2, z: 0 }])).toBe(false);
    expect(occupied({ x: 0, z: 0 }, [])).toBe(false);
  });
});

describe('backOffStep', () => {
  it('steps straight back from a fox closer than the standoff', () => {
    const dir = backOffStep({ x: 0, z: 0 }, { x: 0.6, z: 0 }, open, 0.01)!;
    expect(dir.x).toBeCloseTo(-1);
    expect(dir.z).toBeCloseTo(0);
  });

  it('holds still once at the standoff', () => {
    expect(backOffStep({ x: 0, z: 0 }, { x: SERVE_STANDOFF, z: 0 }, open, 0.01)).toBeNull();
  });

  it('does not back into furniture', () => {
    const wallBehind = (x: number): boolean => x > -0.1;
    expect(backOffStep({ x: 0, z: 0 }, { x: 0.6, z: 0 }, wallBehind, 0.01)).toBeNull();
  });
});
