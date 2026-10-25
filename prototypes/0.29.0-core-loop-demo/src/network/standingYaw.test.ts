import { describe, expect, it } from 'vitest';
import { decodeStandingYaw, encodeStandingYaw, packTick, unpackTick } from './protocol';

const roundTrip = (facing: number): number =>
  unpackTick(packTick({ flags: 0, x: 0, z: 0, yaw: encodeStandingYaw(facing), seq: 0 })).yaw;

describe('standing facing in the tick yaw', () => {
  it("an old sender's 0 means no facing", () => {
    expect(decodeStandingYaw(0)).toBeNull();
  });

  it('every 8-way facing survives the wire and is never read as "none"', () => {
    for (let i = -8; i <= 8; i++) {
      const facing = (i * Math.PI) / 4;
      const got = decodeStandingYaw(roundTrip(facing));
      expect(got).not.toBeNull();
      const snapped = Math.round(got! / (Math.PI / 4)) * (Math.PI / 4);
      expect(Math.cos(snapped - facing)).toBeCloseTo(1);
    }
  });

  it('a facing just under a full turn does not wrap to 0', () => {
    expect(decodeStandingYaw(roundTrip(2 * Math.PI - 1e-6))).not.toBeNull();
  });
});
