/**
 * 🚪 octagonHull — door apertures (#159).
 *
 * The pure helpers (which face, the clamped/merged notches, the notched
 * outline) and then the BUILT hull: the triangulated faces are measured, so a
 * sill left across a threshold, a cut above the frame, a pane of glass in a
 * doorway or a face Earcut mangled all fail here rather than on screen.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildOctagonHull,
  doorFace,
  doorNotchesByFace,
  notchedFaceOutline,
  type DoorNotch,
  type HullDoorOpening,
  type HullWindows,
} from './octagonHull';

const door = (wall: HullDoorOpening['wall'], lateral: number, width = 2, height = 3): HullDoorOpening => ({
  wall,
  lateral,
  width,
  height,
});

describe('doorFace', () => {
  it('puts the narrow-axis walls on the side strips and the long-axis walls on the end caps', () => {
    // A square (or x-narrow) room extrudes along z: x± are side walls, y± end caps.
    expect(doorFace('x', 'x-')).toBe('wall-neg');
    expect(doorFace('x', 'x+')).toBe('wall-pos');
    expect(doorFace('x', 'y-')).toBe('cap-neg');
    expect(doorFace('x', 'y+')).toBe('cap-pos');
    // A z-narrow room extrudes along x: the roles swap.
    expect(doorFace('z', 'y-')).toBe('wall-neg');
    expect(doorFace('z', 'y+')).toBe('wall-pos');
    expect(doorFace('z', 'x-')).toBe('cap-neg');
    expect(doorFace('z', 'x+')).toBe('cap-pos');
  });
});

describe('doorNotchesByFace', () => {
  // A 6 × 12 m room, narrow on x: side walls run ±6 along z, end caps span ±3.
  const profile = { narrowAxis: 'x' as const, narrowHalf: 3, longHalf: 6, wallHeight: 4 };

  it('stands each door on the floor of its own face, at its true size', () => {
    const out = doorNotchesByFace(profile, [door('x-', -2), door('x+', 1), door('y-', -1), door('y+', 0.5)]);
    expect(out['wall-neg']).toEqual([{ lo: -3, hi: -1, top: 3 }]);
    expect(out['wall-pos']).toEqual([{ lo: 0, hi: 2, top: 3 }]);
    expect(out['cap-neg']).toEqual([{ lo: -2, hi: 0, top: 3 }]);
    expect(out['cap-pos']).toEqual([{ lo: -0.5, hi: 1.5, top: 3 }]);
  });

  it('clamps to the face it stands in — a side wall runs the long axis, a cap only the narrow one', () => {
    const out = doorNotchesByFace(profile, [door('x-', 5.5), door('y-', 2.9), door('y+', 0, 2, 10)]);
    expect(out['wall-neg']).toEqual([{ lo: 4.5, hi: 5.95, top: 3 }]);
    expect(out['cap-neg']).toEqual([{ lo: 1.9, hi: 2.95, top: 3 }]);
    expect(out['cap-pos']).toEqual([{ lo: -1, hi: 1, top: 3.95 }]); // kept under the top edge
  });

  it('skips junk instead of letting it into the outline', () => {
    const out = doorNotchesByFace(profile, [
      door('y-', Number.NaN),
      door('y-', 0, 0),
      door('y-', 0, 2, -1),
      door('y-', 0, Number.POSITIVE_INFINITY),
      door('y-', 40), // wholly off the face
    ]);
    expect(out['cap-neg']).toEqual([]);
  });

  it('merges overlapping apertures into a skyline, keeping each height where it applies', () => {
    const out = doorNotchesByFace(profile, [door('y-', -0.2, 2, 2.4), door('y-', 0.6, 2, 3), door('y+', -1, 2, 3), door('y+', 1, 2, 3)]);
    expect(out['cap-neg']).toEqual([
      { lo: -1.2, hi: -0.4, top: 2.4 },
      { lo: -0.4, hi: 1.6, top: 3 },
    ]);
    // Touching, same height: one aperture.
    expect(out['cap-pos']).toEqual([{ lo: -2, hi: 2, top: 3 }]);
  });
});

/** Shoelace area of an outline (positive either winding). */
function outlineArea(pts: Array<{ u: number; v: number }>): number {
  let twice = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    twice += p.u * q.v - q.u * p.v;
  }
  return Math.abs(twice) / 2;
}

describe('notchedFaceOutline', () => {
  it('is the plain rectangle when the face has no doors', () => {
    expect(notchedFaceOutline(-6, 6, 4, [])).toEqual([
      { u: -6, v: 0 },
      { u: 6, v: 0 },
      { u: 6, v: 4 },
      { u: -6, v: 4 },
    ]);
  });

  it('steps the floor line up and over a door — the aperture touches the floor, as a notch', () => {
    const pts = notchedFaceOutline(-6, 6, 4, [{ lo: -1, hi: 1, top: 3 }]);
    expect(pts).toEqual([
      { u: -6, v: 0 },
      { u: -1, v: 0 },
      { u: -1, v: 3 },
      { u: 1, v: 3 },
      { u: 1, v: 0 },
      { u: 6, v: 0 },
      { u: 6, v: 4 },
      { u: -6, v: 4 },
    ]);
    expect(outlineArea(pts)).toBeCloseTo(12 * 4 - 2 * 3, 9);
  });

  it('steps between touching apertures of different heights without returning to the floor', () => {
    const notches: DoorNotch[] = [
      { lo: -1, hi: 1, top: 3 },
      { lo: 1, hi: 1.8, top: 2.5 },
      { lo: 4, hi: 5, top: 3 },
    ];
    const pts = notchedFaceOutline(-6, 6, 4, notches);
    expect(pts).toEqual([
      { u: -6, v: 0 },
      { u: -1, v: 0 },
      { u: -1, v: 3 },
      { u: 1, v: 3 },
      { u: 1, v: 2.5 },
      { u: 1.8, v: 2.5 },
      { u: 1.8, v: 0 },
      { u: 4, v: 0 },
      { u: 4, v: 3 },
      { u: 5, v: 3 },
      { u: 5, v: 0 },
      { u: 6, v: 0 },
      { u: 6, v: 4 },
      { u: -6, v: 4 },
    ]);
    expect(outlineArea(pts)).toBeCloseTo(48 - (6 + 2 + 3), 9);
    // No point is visited twice — a repeated vertex is what breaks Earcut.
    expect(new Set(pts.map((p) => `${p.u},${p.v}`)).size).toBe(pts.length);
  });
});

// ── The built hull ───────────────────────────────────────────────────────────

type Tri = [THREE.Vector3, THREE.Vector3, THREE.Vector3];

function triangles(mesh: THREE.Mesh): Tri[] {
  const pos = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  const count = index ? index.count : pos.count;
  const at = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(i) : i);
  const out: Tri[] = [];
  for (let i = 0; i < count; i += 3) out.push([at(i), at(i + 1), at(i + 2)]);
  return out;
}

const area = (tris: Tri[]) =>
  tris.reduce((sum, [a, b, c]) => sum + b.clone().sub(a).cross(c.clone().sub(a)).length() / 2, 0);

/** Is face-local point (u, v) covered by any triangle? `uOf` picks the along-face world axis. */
function covers(tris: Tri[], uOf: (p: THREE.Vector3) => number, u: number, v: number): boolean {
  const sign = (p: [number, number], q: [number, number], r: [number, number]) =>
    (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  return tris.some(([a, b, c]) => {
    const A: [number, number] = [uOf(a), a.y];
    const B: [number, number] = [uOf(b), b.y];
    const C: [number, number] = [uOf(c), c.y];
    const d1 = sign([u, v], A, B);
    const d2 = sign([u, v], B, C);
    const d3 = sign([u, v], C, A);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  });
}

/**
 * EXACT coverage: sampled on a grid that never lands on an aperture edge, a
 * point of the face is wall if and only if it is outside every aperture. Area
 * alone cannot say this — a doubled triangle can hide a missing one — and it
 * is what "Earcut was handed a polygon it could triangulate" looks like.
 */
function expectWallExactlyOutside(tris: Tri[], uOf: (p: THREE.Vector3) => number, apertures: DoorNotch[]): void {
  const wrong: string[] = [];
  for (let u = -5.875; u < 6; u += 0.25) {
    for (let v = 0.0625; v < 4; v += 0.125) {
      const open = apertures.some((n) => u > n.lo && u < n.hi && v < n.top);
      if (covers(tris, uOf, u, v) === open) wrong.push(`${u},${v} ${open ? 'is wall inside an aperture' : 'is missing wall'}`);
    }
  }
  expect(wrong).toEqual([]);
}

/** The hull's vertical faces, found by where they stand (a square 12 m room:
 *  side walls at x = ±6 running z, end caps at z = ±6 spanning x). */
function faces(hull: ReturnType<typeof buildOctagonHull>) {
  const meshes = hull.group.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
  const standsAt = (name: string, axis: 'x' | 'z', value: number) => {
    const found = meshes.filter(
      (m) => m.name === name && triangles(m).every((t) => t.every((p) => Math.abs(p[axis] - value) < 1e-9)),
    );
    expect(found).toHaveLength(1);
    return triangles(found[0]);
  };
  return {
    wallNeg: standsAt('octagon-wall', 'x', -6),
    wallPos: standsAt('octagon-wall', 'x', 6),
    capNeg: standsAt('octagon-cap-wall', 'z', -6),
    capPos: standsAt('octagon-cap-wall', 'z', 6),
    glass: meshes.filter((m) => m.name === 'octagon-window-glass'),
  };
}

const ROOM = { halfX: 6, halfZ: 6 }; // the default 2 × 2 module: narrow on x, 4 m walls
const FACE_AREA = 12 * 4;
const alongZ = (p: THREE.Vector3) => p.z;
const alongX = (p: THREE.Vector3) => p.x;

describe('buildOctagonHull — door apertures', () => {
  it('leaves every face whole when the room has no doors', () => {
    const f = faces(buildOctagonHull(ROOM));
    for (const tris of [f.wallNeg, f.wallPos, f.capNeg, f.capPos]) {
      expect(tris).toHaveLength(2); // the plain quad, as before
      expect(area(tris)).toBeCloseTo(FACE_AREA, 9);
    }
  });

  it('opens a side wall from the floor to the frame top — no sill, no cut above the header', () => {
    const f = faces(buildOctagonHull(ROOM, {}, {}, [door('x-', 2)]));
    expect(area(f.wallNeg)).toBeCloseTo(FACE_AREA - 2 * 3, 6);
    // Inside the aperture [1, 3] × [0, 3]: nothing, right down to the threshold…
    for (const [u, v] of [[2, 0.01], [2, 1.5], [1.02, 0.01], [2.98, 2.98]]) {
      expect(covers(f.wallNeg, alongZ, u, v), `aperture point ${u},${v}`).toBe(false);
    }
    // …and wall everywhere around it, including directly above the frame.
    for (const [u, v] of [[2, 3.02], [0.98, 0.01], [3.02, 0.01], [-5.9, 0.01], [5.9, 3.9]]) {
      expect(covers(f.wallNeg, alongZ, u, v), `wall point ${u},${v}`).toBe(true);
    }
    expectWallExactlyOutside(f.wallNeg, alongZ, [{ lo: 1, hi: 3, top: 3 }]);
    // The other three faces are untouched.
    for (const tris of [f.wallPos, f.capNeg, f.capPos]) expect(area(tris)).toBeCloseTo(FACE_AREA, 9);
  });

  it('opens an end cap the same way — the wall most rooms hang their first door on', () => {
    const f = faces(buildOctagonHull(ROOM, {}, {}, [door('y-', 0), door('y+', -3)]));
    expect(area(f.capNeg)).toBeCloseTo(FACE_AREA - 6, 6);
    expect(area(f.capPos)).toBeCloseTo(FACE_AREA - 6, 6);
    expect(covers(f.capNeg, alongX, 0, 0.01)).toBe(false);
    expect(covers(f.capNeg, alongX, 0, 3.02)).toBe(true);
    expect(covers(f.capPos, alongX, -3, 0.01)).toBe(false);
    expect(covers(f.capPos, alongX, 0, 0.01)).toBe(true); // the aperture followed the door
    expectWallExactlyOutside(f.capNeg, alongX, [{ lo: -1, hi: 1, top: 3 }]);
    expectWallExactlyOutside(f.capPos, alongX, [{ lo: -4, hi: -2, top: 3 }]);
  });

  it('triangulates overlapping and touching apertures cleanly (no doubled or missing wall)', () => {
    const f = faces(
      buildOctagonHull(ROOM, {}, {}, [door('y-', -0.2, 2, 2.4), door('y-', 0.6, 2, 3), door('x+', -2), door('x+', 0)]),
    );
    // cap: [-1.2, -0.4] × 2.4 + [-0.4, 1.6] × 3 ; wall: one fused [-3, 1] × 3
    expect(area(f.capNeg)).toBeCloseTo(FACE_AREA - (0.8 * 2.4 + 2 * 3), 6);
    expect(area(f.wallPos)).toBeCloseTo(FACE_AREA - 4 * 3, 6);
    expect(covers(f.capNeg, alongX, -0.8, 2.7)).toBe(true); // above the shorter one
    expect(covers(f.capNeg, alongX, -0.8, 2.3)).toBe(false);
    expect(covers(f.capNeg, alongX, 0.5, 2.7)).toBe(false);
    expectWallExactlyOutside(f.capNeg, alongX, [
      { lo: -1.2, hi: -0.4, top: 2.4 },
      { lo: -0.4, hi: 1.6, top: 3 },
    ]);
    expectWallExactlyOutside(f.wallPos, alongZ, [{ lo: -3, hi: 1, top: 3 }]);
  });

  it('never glazes a doorway: panes are built for windows only', () => {
    const windows: HullWindows = { 'wall-neg': [{ along: -3, across: 2, w: 1.5, h: 1.2, r: 0.2 }] };
    const withDoors = faces(buildOctagonHull(ROOM, windows, {}, [door('x-', 2), door('x+', 0), door('y-', 0)]));
    expect(withDoors.glass).toHaveLength(1);
    expect(faces(buildOctagonHull(ROOM, {}, {}, [door('x-', 2), door('x+', 0)])).glass).toHaveLength(0);
  });

  it('drops a window that would run into a door, and keeps a transom above one', () => {
    const blocked: HullWindows = { 'wall-neg': [{ along: 2.5, across: 2, w: 1.5, h: 1.2, r: 0.2 }] };
    const f = faces(buildOctagonHull(ROOM, blocked, {}, [door('x-', 2)]));
    expect(f.glass).toHaveLength(0);
    expect(area(f.wallNeg)).toBeCloseTo(FACE_AREA - 6, 6); // only the doorway is open

    const transom: HullWindows = { 'wall-neg': [{ along: 2, across: 3.5, w: 1.6, h: 0.6, r: 0 }] };
    const g = faces(buildOctagonHull(ROOM, transom, {}, [door('x-', 2)]));
    expect(g.glass).toHaveLength(1);
    expect(area(g.wallNeg)).toBeCloseTo(FACE_AREA - 6 - 1.6 * 0.6, 6);
  });
});
