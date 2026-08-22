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
import * as THREE from 'three';
import {
  notchedRectOutline,
  clampedDoorCuts,
  buildOctagonHull,
  buildOctagonShell,
  DOOR_HULL_INSET,
  type DoorOpening,
} from './octagonHull';
import { doorSurfaceForWall, bucketDoorCutsFromRecords } from './doorCuts';
import { DOOR_OPENING_WIDTH, DOOR_OPENING_HEIGHT } from './doorLayout';
import type { DoorWall } from './doorLayoutDoc';

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

// ── bucketDoorCutsFromRecords: peer-writable records → clamped cuts ────────
//
// Regression cover for the PR #122 review §"clamp at the boundary":
// `readAllDoorLayout` is a peer-boundary read — `isDoorLayoutRecord` proves
// the fields are the right SHAPE and finite, but not that the numbers name a
// location that fits the current room. A hostile or malformed record (or a
// legitimate one that survived a room resize past it) must not feed a cut
// that runs off the end of a strip or end cap into the hull builder. The
// collector clamps at the boundary; the mesh builders' own `clampedDoorCuts`
// still runs, so this clamp is defence-in-depth — testing the collector's
// clamp specifically ensures a downstream refactor that removes one clamp
// cannot silently drop the other.

describe('bucketDoorCutsFromRecords — clamps peer-writable records at the collection boundary', () => {
  // Default 12×12 room (halfX=halfZ=6): narrowAxisFor picks 'x' by tie-break,
  // so wall 'x-' → 'wall-neg' (side wall, along ∈ [-longHalf=−6, longHalf=6])
  // and wall 'y-' → 'cap-neg' (end cap, along ∈ [−narrowHalf=−6, narrowHalf=6]).
  // Hull default wallHeight=4 (DEFAULT_WALL_HEIGHT), so DOOR_OPENING_HEIGHT=3
  // survives the vertical clamp on every case here.

  it('a hostile lateral far outside the side wall is clamped to the inset limit — not passed through', () => {
    // A malicious peer writes lateral=999 on wall 'x-'. Without a boundary
    // clamp, the mesh builder would receive along=999; with it, the collector
    // shifts it to the inset limit (longHalf − w/2 − DOOR_HULL_INSET).
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'x-' as DoorWall, lateral: 999 }],
      6, 6,
    );
    expect(cuts['wall-neg']).toHaveLength(1);
    expect(cuts['wall-neg']![0].along).toBeCloseTo(6 - DOOR_OPENING_WIDTH / 2 - DOOR_HULL_INSET);
    expect(cuts['wall-neg']![0].w).toBe(DOOR_OPENING_WIDTH);
    expect(cuts['wall-neg']![0].h).toBe(DOOR_OPENING_HEIGHT);
    // Nothing landed on the other three faces.
    expect(cuts['wall-pos']).toBeUndefined();
    expect(cuts['cap-neg']).toBeUndefined();
    expect(cuts['cap-pos']).toBeUndefined();
  });

  it('a hostile lateral on the −∞ end of the side wall is clamped up to the inset limit', () => {
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'x+' as DoorWall, lateral: -1e12 }],
      6, 6,
    );
    expect(cuts['wall-pos']).toHaveLength(1);
    expect(cuts['wall-pos']![0].along).toBeCloseTo(-(6 - DOOR_OPENING_WIDTH / 2 - DOOR_HULL_INSET));
  });

  it('a hostile lateral far outside an end cap is clamped to its narrow-axis inset limit', () => {
    // On a rectangular 6×12 room (halfX=3, halfZ=6): narrowAxis='x',
    // narrowHalf=3, longHalf=6. Walls 'y±' become the caps with along ∈ [−3, 3].
    // A record at lateral=999 on wall 'y-' should clamp to (3 − 1 − 0.05).
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'y-' as DoorWall, lateral: 999 }],
      3, 6,
    );
    expect(cuts['cap-neg']).toHaveLength(1);
    expect(cuts['cap-neg']![0].along).toBeCloseTo(3 - DOOR_OPENING_WIDTH / 2 - DOOR_HULL_INSET);
  });

  it('drops a door on a side wall whose extrude span is too short for DOOR_OPENING_WIDTH', () => {
    // Shrink the room so 2*longHalf − 2*DOOR_HULL_INSET < DOOR_OPENING_WIDTH.
    // halfX=halfZ=1 → longHalf=1 → alongSpan=2 → 2 − 0.1 = 1.9 < 2.0 → drop.
    // (A room this small never renders in the app, but a hostile floor-plan
    // write can produce it and the collector must refuse to emit a broken
    // cut regardless. #130 makes floor-plan placements authoritative, which
    // is where this failure mode enters the runtime.)
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'x-' as DoorWall, lateral: 0 }],
      1, 1,
    );
    expect(cuts['wall-neg']).toBeUndefined();
  });

  it('drops a door on an end cap whose narrow-axis span is too short for DOOR_OPENING_WIDTH', () => {
    // halfX=1 (narrow), halfZ=6 (long) → narrowHalf=1, cap span=2, drop.
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'y-' as DoorWall, lateral: 0 }],
      1, 6,
    );
    expect(cuts['cap-neg']).toBeUndefined();
  });

  it('a mix of hostile + honest records: each is clamped or dropped independently, honest ones untouched', () => {
    const cuts = bucketDoorCutsFromRecords(
      [
        { wall: 'x-' as DoorWall, lateral: 999 },   // clamp right
        { wall: 'x-' as DoorWall, lateral: -999 },  // clamp left
        { wall: 'x-' as DoorWall, lateral: 0 },     // in-bounds — untouched
        { wall: 'x+' as DoorWall, lateral: 2 },     // in-bounds — untouched (different surface)
      ],
      6, 6,
    );
    expect(cuts['wall-neg']).toHaveLength(3);
    // Order is preserved for the survivors (clampedDoorCuts guarantee).
    expect(cuts['wall-neg']![0].along).toBeCloseTo(6 - 1 - DOOR_HULL_INSET);
    expect(cuts['wall-neg']![1].along).toBeCloseTo(-(6 - 1 - DOOR_HULL_INSET));
    expect(cuts['wall-neg']![2].along).toBe(0);
    expect(cuts['wall-pos']).toHaveLength(1);
    expect(cuts['wall-pos']![0].along).toBe(2);
  });

  it('a room too small for ANY door on a face returns an empty bucket for that face — no half-cut mesh downstream', () => {
    // Two hostile records on the same undersized side wall — both dropped,
    // and the surface key never appears in the output map (the mesh builder's
    // `doors[surface]` read gets `undefined` and it falls straight through to
    // the plain-quad path). This is the crucial post-condition: no partial /
    // broken cut list can reach the mesh builder from a rogue record.
    const cuts = bucketDoorCutsFromRecords(
      [
        { wall: 'x-' as DoorWall, lateral: 0 },
        { wall: 'x-' as DoorWall, lateral: 999 },
      ],
      1, 1,
    );
    expect(cuts['wall-neg']).toBeUndefined();
    expect(Object.keys(cuts)).toHaveLength(0);
  });

  it('an empty record iterable is an empty map — no coincidental default cuts', () => {
    // The unseeded-room FALLBACK to defaultDoorLayoutRecords lives in
    // collectDoorCuts (the doc-reading wrapper); the pure helper here trusts
    // its caller's records. Passing zero records must produce zero cuts —
    // no keys at all — so a downstream `for (const s of Object.keys(cuts))`
    // observes no surfaces to punch.
    const cuts = bucketDoorCutsFromRecords([], 6, 6);
    expect(Object.keys(cuts)).toHaveLength(0);
  });

  it('the four cardinal defaults on a normal room round-trip untouched — no false-positive clamps', () => {
    // Regression against an over-eager clamp: the four cardinal defaults
    // (LEGACY_ID_WALL entries at lateral=0) all fit trivially inside a 12×12
    // room, so the collector must emit their (along=0) values unchanged.
    const cuts = bucketDoorCutsFromRecords(
      [
        { wall: 'y-' as DoorWall, lateral: 0 },
        { wall: 'y+' as DoorWall, lateral: 0 },
        { wall: 'x-' as DoorWall, lateral: 0 },
        { wall: 'x+' as DoorWall, lateral: 0 },
      ],
      6, 6,
    );
    // narrowAxis='x' by tie-break: x± are strips, y± are caps.
    expect(cuts['wall-neg']).toEqual([{ along: 0, w: DOOR_OPENING_WIDTH, h: DOOR_OPENING_HEIGHT }]);
    expect(cuts['wall-pos']).toEqual([{ along: 0, w: DOOR_OPENING_WIDTH, h: DOOR_OPENING_HEIGHT }]);
    expect(cuts['cap-neg']).toEqual([{ along: 0, w: DOOR_OPENING_WIDTH, h: DOOR_OPENING_HEIGHT }]);
    expect(cuts['cap-pos']).toEqual([{ along: 0, w: DOOR_OPENING_WIDTH, h: DOOR_OPENING_HEIGHT }]);
  });

  it('narrowAxis flip (halfZ<halfX) routes strip/cap to the OTHER axis — the clamp follows', () => {
    // halfX=6, halfZ=3 → narrowAxis='z', so y± walls become STRIPS with
    // along ∈ [−longHalf=−6, 6], and x± walls become CAPS with
    // along ∈ [−narrowHalf=−3, 3]. A hostile lateral=999 on wall 'x-'
    // (now a cap) clamps to 3 − 1 − 0.05.
    const cuts = bucketDoorCutsFromRecords(
      [{ wall: 'x-' as DoorWall, lateral: 999 }],
      6, 3,
    );
    expect(cuts['cap-neg']).toHaveLength(1);
    expect(cuts['cap-neg']![0].along).toBeCloseTo(3 - 1 - DOOR_HULL_INSET);
    // And a hostile lateral=999 on wall 'y-' (now a strip) clamps to 6 − 1 − 0.05.
    const cuts2 = bucketDoorCutsFromRecords(
      [{ wall: 'y-' as DoorWall, lateral: 999 }],
      6, 3,
    );
    expect(cuts2['wall-neg']).toHaveLength(1);
    expect(cuts2['wall-neg']![0].along).toBeCloseTo(6 - 1 - DOOR_HULL_INSET);
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

// ── Full-mesh regression: cap-door on the SHELL is a well-formed triangle set ──
//
// The pure primitives above pin the outline; these tests instantiate the actual
// `buildOctagonHull` / `buildOctagonShell` and interrogate the resulting
// BufferGeometry so a merge-time defect (e.g. dropping a ShapeGeometry index
// during a non-indexed merge) can't hide behind green outline tests. A single
// broken assertion here would have caught the pre-fix regression on
// `capGeometryWithDoors` immediately.
//
// The shell path is the interesting one: it MERGES the notched wall-band
// ShapeGeometry (indexed) with two gable fans (raw triangles) into ONE
// non-indexed BufferGeometry. That merge must expand the ShapeGeometry via its
// index — otherwise (band vertex count) + (12 gable-fan floats-per-triangle) is
// almost never divisible by 3, and the mesh renders garbled.

/** Utility: collect every mesh in a group with a given .name into an array. */
function collectMeshesByName(group: THREE.Object3D, name: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh && obj.name === name) out.push(obj as THREE.Mesh);
  });
  return out;
}

/** Utility: total triangle count from a geometry — index count / 3 when indexed,
 *  else position count / 3. Returns 0 for an empty geometry. */
function triangleCount(geo: THREE.BufferGeometry): number {
  if (geo.index) return geo.index.count / 3;
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  return pos ? pos.count / 3 : 0;
}

describe('buildOctagonShell with cap doors — merged cap geometry is valid', () => {
  it('cap-neg with one centre door yields a non-indexed cap whose position count is divisible by 3', () => {
    // A default 12×12 room (halfX=halfZ=6): ties on the narrow axis, defaults
    // to 'x' — 'cap-neg' is then a wall at y=-halfZ. One centred door on it.
    const shell = buildOctagonShell(
      { halfX: 6, halfZ: 6 },
      {},
      {},
      { 'cap-neg': [{ along: 0, w: 2, h: 3 }] },
    );
    try {
      const caps = collectMeshesByName(shell.group, 'octagon-shell-cap');
      expect(caps).toHaveLength(2); // one per end (cap-neg, cap-pos)
      for (const cap of caps) {
        const geo = cap.geometry as THREE.BufferGeometry;
        const posCount = (geo.attributes.position as THREE.BufferAttribute).count;
        // The merged shell cap is deliberately NON-indexed (positions expanded
        // per-triangle), so posCount must be a whole multiple of 3.
        expect(geo.index).toBeNull();
        expect(posCount % 3).toBe(0);
        // Sanity: at least the base gable fans (roof trapezoid = 2 tris,
        // basement trapezoid = 2 tris) contribute 12 vertices, so any cap is
        // ≥ 12. The notched cap adds N wall-band triangles on top.
        expect(posCount).toBeGreaterThanOrEqual(12);
      }
    } finally {
      shell.dispose();
    }
  });

  it('cap without a door falls through to the byte-identical legacy fan (no notch overhead)', () => {
    // No door on either cap ⇒ capGeometryWithDoors returns capGeometry(), which
    // fan-triangulates the 8-vertex octagon outline into (8 − 2) = 6 tris,
    // i.e. 18 raw vertices, independent of the door map.
    const shell = buildOctagonShell({ halfX: 6, halfZ: 6 }, {}, {}, {});
    try {
      const caps = collectMeshesByName(shell.group, 'octagon-shell-cap');
      for (const cap of caps) {
        const posCount = (cap.geometry.attributes.position as THREE.BufferAttribute).count;
        expect(posCount).toBe(18);
      }
    } finally {
      shell.dispose();
    }
  });

  it('side-wall door on the shell is a valid strip geometry (never a broken sliver)', () => {
    // 'wall-neg' side-wall door on a 12x12 default room. stripGeometry keeps
    // its own indexed ShapeGeometry (its own mesh, no merge), so the wall
    // strip must remain indexed with index.count % 3 === 0 and enough tris.
    const shell = buildOctagonShell(
      { halfX: 6, halfZ: 6 },
      {},
      {},
      { 'wall-neg': [{ along: 0, w: 2, h: 3 }] },
    );
    try {
      // The wall strip mesh's name is "octagon-shell-wall".
      const walls = collectMeshesByName(shell.group, 'octagon-shell-wall');
      expect(walls.length).toBeGreaterThan(0);
      // At least one has a real cut on it — triangle count > the 2 a plain
      // quad emits (a notched outline needs ≥ 6 tris).
      const notchedTriCount = Math.max(...walls.map(w => triangleCount(w.geometry as THREE.BufferGeometry)));
      expect(notchedTriCount).toBeGreaterThanOrEqual(6);
    } finally {
      shell.dispose();
    }
  });
});

describe('buildOctagonHull with cap doors — interior barrel cap-wall mesh keeps its index', () => {
  it('interior cap-wall mesh is INDEXED (its own ShapeGeometry, not merged)', () => {
    // Interior path keeps capWallBandGeometry as its own mesh with its own
    // material, so its index survives — this was correct pre-fix and must stay
    // correct post-fix. Guards against a copy-paste of the shell-side merge
    // logic accidentally flattening the interior mesh too.
    const hull = buildOctagonHull(
      { halfX: 6, halfZ: 6 },
      {},
      {},
      { 'cap-neg': [{ along: 0, w: 2, h: 3 }] },
    );
    try {
      const capWalls = collectMeshesByName(hull.group, 'octagon-cap-wall');
      expect(capWalls.length).toBeGreaterThan(0);
      // At least the notched cap-wall carries an index (>= 6 tris = 18 idx).
      const notched = capWalls.find(m => (m.geometry as THREE.BufferGeometry).index !== null);
      expect(notched).toBeDefined();
      const idx = notched!.geometry.index!;
      expect(idx.count % 3).toBe(0);
      expect(idx.count).toBeGreaterThanOrEqual(18);
    } finally {
      hull.dispose();
    }
  });
});
