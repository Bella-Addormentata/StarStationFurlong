/**
 * 🛰️ adapter — the far-module projection pose. The part that matters for the
 * docking matcher: a known-size far module's centre sits its TRUE half-extent
 * beyond the chain's end, not the uniform box's (review of #155, round 8).
 */
import { describe, expect, it } from 'vitest';
import { ROOM_HALF, projectionPoseFromWall, type ConnectorSegment } from './adapter';

const CHAIN: ConnectorSegment[] = [{ kind: 'ext', bays: 4, skin: 'solid' }];

describe('projectionPoseFromWall — far module size', () => {
  it('places a 5×5 module (half 15) 15 − ROOM_HALF further out than the uniform box', () => {
    const uniform = projectionPoseFromWall('y-', 0, CHAIN, 'y+', 0);
    const big = projectionPoseFromWall('y-', 0, CHAIN, 'y+', 0, 15);
    expect(Math.hypot(big.x - uniform.x, big.z - uniform.z)).toBeCloseTo(15 - ROOM_HALF, 6);
    // Same heading and rotation — only the centre moves, along the chain.
    expect(big.rotY).toBeCloseTo(uniform.rotY, 9);
    // The move is straight out along the wall normal (y- ⇒ −z).
    expect(big.z).toBeLessThan(uniform.z);
    expect(big.x).toBeCloseTo(uniform.x, 9);
  });

  it('the default keeps today\'s pose bit-for-bit', () => {
    const a = projectionPoseFromWall('x+', 2, CHAIN, 'x-', 1);
    const b = projectionPoseFromWall('x+', 2, CHAIN, 'x-', 1, ROOM_HALF);
    expect(b).toEqual(a);
  });
});
