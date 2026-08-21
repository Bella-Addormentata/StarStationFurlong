/**
 * 🚪 #92: vitest suite pinning the DOOR CUT primitives. Everything here is
 * PURE — no THREE, no doc — so the strip-local `across` parametrisation (the
 * fiddly bit called out on the issue: get it wrong and the notched outline
 * self-intersects, breaking earcut) is nailed down at unit level and cannot
 * silently drift across a refactor.
 *
 * Covers:
 *  - `notchedRectOutline` — CCW winding, 0/1/N doors, sort + merge overlaps,
 *    wall-spanning notch, dropped-oversized, corner-touching.
 *  - `clampedDoorCuts` — drops-if-too-big, clamps `along` off the strip ends.
 *  - `doorSurfaceForWall` — the DoorWall → DoorSurface table under BOTH
 *    narrowAxis orientations, so a room resize that flips the narrow axis
 *    routes a door to the correct hull face without re-computation.
 *  - Room-resize invariants over the pure primitives — a wall going short
 *    still gives back valid outlines / rejects too-big cuts consistently.
 */

import { describe, expect, it } from 'vitest';
import {
  notchedRectOutline,
  clampedDoorCuts,
  DOOR_HULL_INSET,
  type DoorOpening,
} from './octagonHull';
import { doorSurfaceForWall } from './doorCuts';

// ── notchedRectOutline ─────────────────────────────────────────────────────

describe('notchedRectOutline', () => {
  it('returns the plain CCW quad when there are no doors', () => {
    const out = notchedRectOutline(-10, 10, 3, []);
    expect(out).toEqual([
      { along: -10, across: 0 },
      { along: 10, across: 0 },
      { along: 10, across: 3 },
      { along: -10, across: 3 },
    ]);
  });

  it('CCW winding — the signed area is positive with N doors', () => {
    const doors: DoorOpening[] = [
      { along: -4, w: 2, h: 3 },
      { along: 4, w: 2, h: 3 },
    ];
    const out = notchedRectOutline(-10, 10, 4, doors);
    // Shoelace formula: sum over edges of (x_i * y_{i+1} - x_{i+1} * y_i).
    // CCW polygons integrate to a POSITIVE signed area.
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      acc += a.along * b.across - b.along * a.across;
    }
    expect(acc).toBeGreaterThan(0);
  });

  it('one interior notch adds four points along the bottom edge', () => {
    const out = notchedRectOutline(-10, 10, 3, [{ along: 0, w: 2, h: 3 }]);
    // Corners (4) + one notch (4 new vertices, none of which coincide with the
    // corners since the notch is interior) = 8 vertices, closed by the trace.
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ along: -10, across: 0 });
    expect(out[1]).toEqual({ along: -1, across: 0 });
    expect(out[2]).toEqual({ along: -1, across: 3 });
    expect(out[3]).toEqual({ along: 1, across: 3 });
    expect(out[4]).toEqual({ along: 1, across: 0 });
    expect(out[5]).toEqual({ along: 10, across: 0 });
    expect(out[6]).toEqual({ along: 10, across: 3 });
    expect(out[7]).toEqual({ along: -10, across: 3 });
  });

  it('multiple notches are emitted along-ascending regardless of input order', () => {
    const doors: DoorOpening[] = [
      { along: 5, w: 2, h: 3 },
      { along: -5, w: 2, h: 3 },
      { along: 0, w: 2, h: 3 },
    ];
    const out = notchedRectOutline(-10, 10, 3, doors);
    // Bottom-edge points at across=0 must run monotonically along-ascending.
    const bottomX = out.filter(p => p.across === 0).map(p => p.along);
    for (let i = 1; i < bottomX.length; i++) {
      expect(bottomX[i]).toBeGreaterThanOrEqual(bottomX[i - 1]);
    }
    // 4 corners + 3 notches × 4 points = 16 vertices.
    expect(out).toHaveLength(4 + 3 * 4);
  });

  it('overlapping notches merge into one (edge-touching too — |b-a|<=eps)', () => {
    // Two 2-wide doors whose intervals meet at along=0: [-2,0] and [0,2].
    const out = notchedRectOutline(-10, 10, 3, [
      { along: -1, w: 2, h: 3 },
      { along: 1, w: 2, h: 3 },
    ]);
    // Merged into ONE notch [-2, 2] → 4 corners + 4 notch points = 8.
    expect(out).toHaveLength(8);
    expect(out[1]).toEqual({ along: -2, across: 0 });
    expect(out[2]).toEqual({ along: -2, across: 3 });
    expect(out[3]).toEqual({ along: 2, across: 3 });
    expect(out[4]).toEqual({ along: 2, across: 0 });
  });

  it('merged notch takes the MAX height so a tall + short overlap still clears the tall one', () => {
    const out = notchedRectOutline(-10, 10, 4, [
      { along: -1, w: 2, h: 2 },
      { along: 1, w: 2, h: 3.5 },
    ]);
    // Merged span [-2, 2], height max(2, 3.5) = 3.5.
    expect(out).toHaveLength(8);
    expect(out[2].across).toBeCloseTo(3.5);
    expect(out[3].across).toBeCloseTo(3.5);
  });

  it('a notch that reaches the LEFT wall replaces that corner (no zero-length edge)', () => {
    // Notch [-10, -8] × [0, 3] — touches the left wall exactly. `notchedRectOutline`
    // must NOT emit both (alongMin, 0) and (iv.a, 0) at the same point.
    const out = notchedRectOutline(-10, 10, 3, [{ along: -9, w: 2, h: 3 }]);
    // The bottom-left corner is REPLACED by the notch's left side, so no
    // duplicate point sits at (-10, 0). Count of points at along=-10 should be
    // ONE (the top-left corner alone).
    const atLeft = out.filter(p => p.along === -10);
    expect(atLeft).toHaveLength(1);
    expect(atLeft[0]).toEqual({ along: -10, across: 3 });
    // No zero-length edge (no two consecutive identical points).
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).not.toEqual(out[i - 1]);
    }
  });

  it('a notch that reaches the RIGHT wall replaces that corner (no zero-length edge)', () => {
    const out = notchedRectOutline(-10, 10, 3, [{ along: 9, w: 2, h: 3 }]);
    const atRight = out.filter(p => p.along === 10);
    expect(atRight).toHaveLength(1);
    expect(atRight[0]).toEqual({ along: 10, across: 3 });
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).not.toEqual(out[i - 1]);
    }
  });

  it('a notch that spans the WHOLE wall reduces the polygon to an inverted-U', () => {
    // Notch [-10, 10] × [0, 3] — the wall becomes a rectangle around the door,
    // three-sided (left up, top, right down), no bottom edge at all.
    const out = notchedRectOutline(-10, 10, 3, [{ along: 0, w: 20, h: 3 }]);
    expect(out).toEqual([
      { along: -10, across: 3 },
      { along: 10, across: 3 },
    ]);
    // (2-point degenerate is fine for the outline function's own contract —
    // callers first strip too-big doors via clampedDoorCuts; see below.)
  });

  it('a notch overflowing one end is clipped to the wall', () => {
    // Doors past the left wall get clipped, not dropped, when they still have
    // measurable width inside the wall — matches an editor placing near the
    // corner then a room resize shrinking the wall.
    const out = notchedRectOutline(-10, 10, 3, [{ along: -10, w: 4, h: 3 }]);
    // Clipped to [-10, -8] — corner-touching, so the bottom-left corner is
    // replaced (see corner test above).
    const atLeft = out.filter(p => p.along === -10);
    expect(atLeft).toHaveLength(1);
    // The clipped-right side of the notch sits at along=-8.
    const eight = out.filter(p => Math.abs(p.along - -8) < 1e-9);
    expect(eight).toHaveLength(2);
  });

  it('zero-width and zero-height doors are dropped, leaving the plain quad', () => {
    const out = notchedRectOutline(-10, 10, 3, [
      { along: 0, w: 0, h: 3 },
      { along: 0, w: 2, h: 0 },
    ]);
    expect(out).toEqual([
      { along: -10, across: 0 },
      { along: 10, across: 0 },
      { along: 10, across: 3 },
      { along: -10, across: 3 },
    ]);
  });
});

// ── clampedDoorCuts ────────────────────────────────────────────────────────

describe('clampedDoorCuts', () => {
  it('undefined input returns an empty array — no coincidental new door', () => {
    expect(clampedDoorCuts(undefined, -10, 10, 3)).toEqual([]);
  });

  it('a door that fits passes through with along preserved', () => {
    const out = clampedDoorCuts([{ along: 0, w: 2, h: 3 }], -10, 10, 3.5);
    expect(out).toEqual([{ along: 0, w: 2, h: 3 }]);
  });

  it('clamps `along` so `along ± w/2` stays off both wall ends by DOOR_HULL_INSET', () => {
    // A too-close-to-the-right door is pushed left, exactly to the inset limit.
    const out = clampedDoorCuts([{ along: 20, w: 2, h: 3 }], -10, 10, 3.5);
    expect(out).toHaveLength(1);
    expect(out[0].along).toBeCloseTo(10 - 1 - DOOR_HULL_INSET);
    // And a too-close-to-the-left one is pushed right the same way.
    const left = clampedDoorCuts([{ along: -20, w: 2, h: 3 }], -10, 10, 3.5);
    expect(left[0].along).toBeCloseTo(-10 + 1 + DOOR_HULL_INSET);
  });

  it('drops a door too wide for the wall (rather than crushing it)', () => {
    // A 30-wide door can't fit a 20-wide wall + inset both sides.
    const out = clampedDoorCuts([{ along: 0, w: 30, h: 3 }], -10, 10, 3.5);
    expect(out).toEqual([]);
  });

  it('drops a door too tall for the wall (h > edgeMax − inset)', () => {
    const out = clampedDoorCuts([{ along: 0, w: 2, h: 5 }], -10, 10, 3);
    expect(out).toEqual([]);
  });

  it('drops a zero-width or zero-height door', () => {
    expect(clampedDoorCuts([{ along: 0, w: 0, h: 3 }], -10, 10, 3)).toEqual([]);
    expect(clampedDoorCuts([{ along: 0, w: 2, h: 0 }], -10, 10, 3)).toEqual([]);
  });

  it('preserves the input ORDER and length for a mix of keep/drop/clamp inputs', () => {
    const out = clampedDoorCuts(
      [
        { along: 20, w: 2, h: 3 }, // clamped
        { along: 0, w: 30, h: 3 }, // dropped
        { along: 0, w: 2, h: 3 }, // kept
      ],
      -10,
      10,
      3.5,
    );
    // Order preserved for the survivors: clamped first, then the kept one.
    expect(out).toHaveLength(2);
    expect(out[0].along).toBeCloseTo(10 - 1 - DOOR_HULL_INSET);
    expect(out[1]).toEqual({ along: 0, w: 2, h: 3 });
  });
});

// ── doorSurfaceForWall ─────────────────────────────────────────────────────

describe('doorSurfaceForWall', () => {
  it('maps every wall to the correct DoorSurface when narrowAxis is "x"', () => {
    // narrowAxis='x' ⇒ walls at ±halfX (x±) ARE the side-wall STRIPS; walls at
    // ±halfZ (y±) are the extruded END CAPS.
    expect(doorSurfaceForWall('x-', 'x')).toBe('wall-neg');
    expect(doorSurfaceForWall('x+', 'x')).toBe('wall-pos');
    expect(doorSurfaceForWall('y-', 'x')).toBe('cap-neg');
    expect(doorSurfaceForWall('y+', 'x')).toBe('cap-pos');
  });

  it('flips wall↔cap when narrowAxis is "z" (room resize swaps which pair is a strip)', () => {
    // narrowAxis='z' ⇒ walls at ±halfZ (y±) become the STRIPS; walls at ±halfX
    // (x±) become the CAPS. The label→surface mapping mirrors the axis flip.
    expect(doorSurfaceForWall('y-', 'z')).toBe('wall-neg');
    expect(doorSurfaceForWall('y+', 'z')).toBe('wall-pos');
    expect(doorSurfaceForWall('x-', 'z')).toBe('cap-neg');
    expect(doorSurfaceForWall('x+', 'z')).toBe('cap-pos');
  });

  it('sign is a wall property — never flipped by the axis', () => {
    // A '-'-suffixed wall always yields a '-neg' surface, and '+' → '-pos',
    // regardless of narrowAxis. Locks the sign column of the table.
    for (const axis of ['x', 'z'] as const) {
      expect(doorSurfaceForWall('x-', axis)).toMatch(/-neg$/);
      expect(doorSurfaceForWall('y-', axis)).toMatch(/-neg$/);
      expect(doorSurfaceForWall('x+', axis)).toMatch(/-pos$/);
      expect(doorSurfaceForWall('y+', axis)).toMatch(/-pos$/);
    }
  });
});

// ── Room-resize invariants over the pure primitives ────────────────────────

describe('room resize', () => {
  it('a door that survived a shrink still yields a valid CCW notched outline', () => {
    // A 2-wide door at along=4 fit a 20-wide wall; shrink the wall to 10-wide
    // — the door slides in-bounds via clampedDoorCuts, then the notch renders.
    const beforeCuts = clampedDoorCuts([{ along: 4, w: 2, h: 3 }], -10, 10, 3.5);
    expect(beforeCuts).toHaveLength(1);
    const afterCuts = clampedDoorCuts([{ along: 4, w: 2, h: 3 }], -5, 5, 3.5);
    expect(afterCuts).toHaveLength(1);
    expect(afterCuts[0].along).toBeCloseTo(5 - 1 - DOOR_HULL_INSET);
    // Feeding the clamped result to notchedRectOutline still traces a CCW poly.
    const out = notchedRectOutline(-5, 5, 3.5, afterCuts);
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      acc += a.along * b.across - b.along * a.across;
    }
    expect(acc).toBeGreaterThan(0);
  });

  it('a shrink past the door width DROPS the door — hull renders a plain quad', () => {
    // 2-wide door + 2×inset = 2.1 min wall width. A 2-wide wall drops it.
    const dropped = clampedDoorCuts([{ along: 0, w: 2, h: 3 }], -1, 1, 3.5);
    expect(dropped).toEqual([]);
    // With no surviving cuts, the outline is the plain quad — no half-cut mesh.
    const out = notchedRectOutline(-1, 1, 3.5, dropped);
    expect(out).toEqual([
      { along: -1, across: 0 },
      { along: 1, across: 0 },
      { along: 1, across: 3.5 },
      { along: -1, across: 3.5 },
    ]);
  });

  it('a shrink past the door height also drops it (h > edgeMax − inset)', () => {
    const dropped = clampedDoorCuts([{ along: 0, w: 2, h: 3 }], -10, 10, 2);
    expect(dropped).toEqual([]);
  });
});
