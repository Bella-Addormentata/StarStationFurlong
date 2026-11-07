import { describe, expect, it } from 'vitest';
import {
  blocksRoomView,
  boxCorners,
  EntryReveal,
  HOVER_OPACITY,
  isoCameraDir,
  isoModuleTarget,
  isoVestibuleTarget,
  poseFootprint,
  REVEAL_HOLD_MS,
  type XZPoint,
} from './isoSurroundings';

const ROOM = { halfX: 6, halfZ: 6 };
/** A straight tube out of a wall at lateral 0 (2.4 m across, 3 m long). */
const tube = (wall: 'x+' | 'x-' | 'z+' | 'z-', lateral = 0, half = 6): XZPoint[] => {
  switch (wall) {
    case 'x+': return boxCorners(half, half + 3, lateral - 1.2, lateral + 1.2);
    case 'x-': return boxCorners(-half - 3, -half, lateral - 1.2, lateral + 1.2);
    case 'z+': return boxCorners(lateral - 1.2, lateral + 1.2, half, half + 3);
    case 'z-': return boxCorners(lateral - 1.2, lateral + 1.2, -half - 3, -half);
  }
};
const bounds = (pts: XZPoint[]) => ({
  minX: Math.min(...pts.map((p) => p.x)),
  maxX: Math.max(...pts.map((p) => p.x)),
  minZ: Math.min(...pts.map((p) => p.z)),
  maxZ: Math.max(...pts.map((p) => p.z)),
});

describe('isoCameraDir', () => {
  it('starts on the +x +z diagonal and turns with the detents', () => {
    const d0 = isoCameraDir(0);
    expect(d0.x).toBeCloseTo(Math.SQRT1_2);
    expect(d0.z).toBeCloseTo(Math.SQRT1_2);
    const d45 = isoCameraDir(Math.PI / 4);
    expect(d45.x).toBeCloseTo(1);
    expect(d45.z).toBeCloseTo(0);
    const d180 = isoCameraDir(Math.PI);
    expect(d180.x).toBeCloseTo(-Math.SQRT1_2);
    expect(d180.z).toBeCloseTo(-Math.SQRT1_2);
  });
});

describe('blocksRoomView', () => {
  it('on the diagonal view, the two camera-side walls are near and the other two far', () => {
    const cam = isoCameraDir(0); // camera off the +x +z corner
    expect(blocksRoomView(tube('x+'), ROOM, cam)).toBe(true);
    expect(blocksRoomView(tube('z+'), ROOM, cam)).toBe(true);
    expect(blocksRoomView(tube('x-'), ROOM, cam)).toBe(false);
    expect(blocksRoomView(tube('z-'), ROOM, cam)).toBe(false);
  });

  it('turns with the camera', () => {
    const cam = isoCameraDir(Math.PI); // camera off the −x −z corner
    expect(blocksRoomView(tube('x-'), ROOM, cam)).toBe(true);
    expect(blocksRoomView(tube('z-'), ROOM, cam)).toBe(true);
    expect(blocksRoomView(tube('x+'), ROOM, cam)).toBe(false);
    expect(blocksRoomView(tube('z+'), ROOM, cam)).toBe(false);
  });

  it('on a square-on view, a tube off to the side never covers the room, even toward the camera', () => {
    const cam = isoCameraDir(Math.PI / 4); // camera straight out along +x
    expect(blocksRoomView(tube('x+'), ROOM, cam)).toBe(true);
    expect(blocksRoomView(tube('x-'), ROOM, cam)).toBe(false);
    expect(blocksRoomView(tube('z+'), ROOM, cam)).toBe(false);
    expect(blocksRoomView(tube('z-'), ROOM, cam)).toBe(false);
    // A side-wall door slid toward the camera is still beside the room.
    expect(blocksRoomView(tube('z+', 5), ROOM, cam)).toBe(false);
  });

  it('measures against the room it is given, not a fixed size', () => {
    const cam = isoCameraDir(Math.PI / 4);
    const long = { halfX: 9, halfZ: 6 };
    // Past the end of a long room the tube is near; beside it, it is not.
    expect(blocksRoomView(tube('x+', 0, 9), long, cam)).toBe(true);
    expect(blocksRoomView(tube('z+', 7, 6), long, cam)).toBe(false);
  });

  it('places adjacent modules by their footprint', () => {
    const cam = isoCameraDir(0);
    const half = { halfX: 6, halfZ: 6 };
    const east = poseFootprint({ x: 15, z: 0, rotY: 0 }, half);
    const west = poseFootprint({ x: -15, z: 0, rotY: 0 }, half);
    expect(blocksRoomView(east, ROOM, cam)).toBe(true);
    expect(blocksRoomView(west, ROOM, cam)).toBe(false);
  });

  it('measures a module set at 45° by its own outline, not a box around it', () => {
    const cam = isoCameraDir(0);
    const turned = poseFootprint({ x: 18, z: -9, rotY: Math.PI / 4 }, { halfX: 6, halfZ: 6 });
    // Beside the room on screen: solid. The box around it would overlap.
    expect(blocksRoomView(turned, ROOM, cam)).toBe(false);
    const b = bounds(turned);
    expect(blocksRoomView(boxCorners(b.minX, b.maxX, b.minZ, b.maxZ), ROOM, cam)).toBe(true);
  });
});

describe('poseFootprint', () => {
  it('swaps the extents for a quarter turn', () => {
    const box = bounds(poseFootprint({ x: 10, z: -2, rotY: Math.PI / 2 }, { halfX: 9, halfZ: 3 }));
    expect(box.minX).toBeCloseTo(7);
    expect(box.maxX).toBeCloseTo(13);
    expect(box.minZ).toBeCloseTo(-11);
    expect(box.maxZ).toBeCloseTo(7);
  });
});

describe('isoVestibuleTarget', () => {
  const near = { blocks: true, revealing: false, crossing: false, hovered: false, proximity: 0 };
  it('a far or side tube is always solid', () => {
    expect(isoVestibuleTarget({ ...near, blocks: false })).toBe(1);
  });
  it('a near tube stays clear, shows half under the pointer, and is solid when walked through', () => {
    expect(isoVestibuleTarget(near)).toBe(0);
    expect(isoVestibuleTarget({ ...near, hovered: true })).toBe(HOVER_OPACITY);
    expect(isoVestibuleTarget({ ...near, crossing: true })).toBe(1);
  });
  it('keeps the walk-up fade, which hovering never lowers', () => {
    expect(isoVestibuleTarget({ ...near, proximity: 0.3 })).toBe(0.3);
    expect(isoVestibuleTarget({ ...near, proximity: 0.8, hovered: true })).toBe(0.8);
  });
  it('the entry reveal makes the near side solid', () => {
    expect(isoVestibuleTarget({ ...near, revealing: true })).toBe(1);
  });
});

describe('isoModuleTarget', () => {
  it('solid unless it stands in front of the room, and solid then during the reveal', () => {
    expect(isoModuleTarget({ blocks: false, revealing: false })).toBe(1);
    expect(isoModuleTarget({ blocks: true, revealing: false })).toBe(0);
    expect(isoModuleTarget({ blocks: true, revealing: true })).toBe(1);
  });
});

describe('EntryReveal', () => {
  it('is off until a room is entered', () => {
    const r = new EntryReveal();
    expect(r.update(0, false)).toBe(false);
    expect(r.update(0, true)).toBe(false); // a door walk later starts nothing
  });

  it('holds for a moment after entering, then ends', () => {
    const r = new EntryReveal();
    r.start(1000);
    expect(r.update(1000 + REVEAL_HOLD_MS - 1, false)).toBe(true);
    expect(r.update(1000 + REVEAL_HOLD_MS + 1, false)).toBe(false);
  });

  it('holds while the arrival goes on, and for the hold after it ends', () => {
    const r = new EntryReveal();
    r.start(0);
    // The curtain and the walk-in run well past the hold.
    for (let t = 0; t <= 6000; t += 100) expect(r.update(t, true)).toBe(true);
    // The first idle frame starts the hold.
    expect(r.update(6100, false)).toBe(true);
    expect(r.update(6100 + REVEAL_HOLD_MS - 1, false)).toBe(true);
    expect(r.update(6100 + REVEAL_HOLD_MS + 1, false)).toBe(false);
    // Over: the next door walk does not bring it back.
    expect(r.update(9000, true)).toBe(false);
  });

  it('stays on through a long stall while the arrival goes on', () => {
    const r = new EntryReveal();
    r.start(0);
    expect(r.update(100, true)).toBe(true);
    // The page stalls for longer than the hold mid-swap: still on.
    expect(r.update(100 + 3 * REVEAL_HOLD_MS, true)).toBe(true);
    const idle = 100 + 3 * REVEAL_HOLD_MS + 50;
    expect(r.update(idle, false)).toBe(true);
    expect(r.update(idle + REVEAL_HOLD_MS + 1, false)).toBe(false);
  });

  it('gives the full hold from the first frame that sees the arrival over', () => {
    const r = new EntryReveal();
    r.start(0);
    expect(r.update(100, true)).toBe(true);
    // Frames paused (a background tab) while the swap finished.
    const back = 100 + 5 * REVEAL_HOLD_MS;
    expect(r.update(back, false)).toBe(true);
    expect(r.update(back + REVEAL_HOLD_MS - 1, false)).toBe(true);
    expect(r.update(back + REVEAL_HOLD_MS + 1, false)).toBe(false);
  });

  it('can be cancelled', () => {
    const r = new EntryReveal();
    r.start(0);
    r.cancel();
    expect(r.update(10, true)).toBe(false);
  });
});
