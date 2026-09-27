/**
 * 🔭 Cupola end wall — the pure geometry (cupola.ts), the floorPlan setting
 * and walk rules (floorPlanDoc), and the built hull (octagonHull).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as Y from 'yjs';
import * as THREE from 'three';
import {
  cupolaEndWalls,
  cupolaPlan,
  cupolaTipOutline,
  cupolaFloorOutline,
  cupolaCornerClearance,
  clampOutOfCupolaCorners,
  cupolaSideWallRun,
  boxClearOfCupolaCorners,
  boxInCupolaTaper,
  cupolaStripRun,
} from './cupola';
import { buildOctagonHull, buildOctagonShell, cupolaPieces } from './octagonHull';
import { clampWindowAlong, windowFitsSurface } from './windowLayout';
import {
  bindFloorPlan,
  writeRoomDims,
  readCupolaWall,
  writeCupolaWall,
  roomCupola,
  insideRoomWalk,
  clampToRoomWalk,
} from './floorPlanDoc';

const SQUARE = { halfX: 6, halfZ: 6 }; // default 2×2: extrudes along z
const NARROW = { halfX: 3, halfZ: 6 }; // one tile wide
const WIDE = { halfX: 9, halfZ: 6 }; // extrudes along x

describe('cupolaEndWalls / cupolaPlan', () => {
  it('only offers the two walls where the octagon shows', () => {
    expect(cupolaEndWalls(6, 6)).toEqual(['y-', 'y+']);
    expect(cupolaEndWalls(3, 6)).toEqual(['y-', 'y+']);
    expect(cupolaEndWalls(9, 6)).toEqual(['x-', 'x+']);
    expect(cupolaPlan(SQUARE, 'x+')).toBeNull();
    expect(cupolaPlan(WIDE, 'y-')).toBeNull();
    expect(cupolaPlan(SQUARE, null)).toBeNull();
  });

  it('runs 2 m into a 12 m wide room and less into a narrow one', () => {
    const plan = cupolaPlan(SQUARE, 'y+')!;
    expect(plan.depth).toBe(2);
    expect(plan.sign).toBe(1);
    expect(plan.b0).toBe(4);
    expect(plan.tipB).toBe(6);
    const narrow = cupolaPlan(NARROW, 'y-')!;
    expect(narrow.depth).toBeGreaterThan(1);
    expect(narrow.depth).toBeLessThan(1.5);
    expect(narrow.b0).toBeCloseTo(-(6 - narrow.depth), 9);
  });
});

describe('cupolaTipOutline', () => {
  it('is the base octagon stepped in by the depth, walls keeping their height', () => {
    const plan = cupolaPlan(SQUARE, 'y+')!;
    const { profile, depth } = plan;
    const tip = cupolaTipOutline(profile, depth);
    expect(tip).toHaveLength(8);
    expect(tip[0]).toEqual({ a: -(6 - depth), y: 0 });
    expect(tip[1]).toEqual({ a: -(6 - depth), y: profile.wallHeight });
    expect(tip[2].y).toBeCloseTo(profile.ridgeY - depth, 9);
    expect(tip[2].a).toBeCloseTo(-profile.ridgeHalf, 9);
    expect(tip[6].y).toBeCloseTo(-(profile.basementDepth - depth), 9);
  });

  it('makes every frustum face a flat piece of glass', () => {
    for (const [room, wall] of [[SQUARE, 'y+'], [SQUARE, 'y-'], [NARROW, 'y+'], [WIDE, 'x-']] as const) {
      const pieces = cupolaPieces(cupolaPlan(room, wall)!);
      expect(pieces).toHaveLength(11); // 8 faces + 3 tip bands
      for (const p of pieces) {
        const [a, b, c] = p.corners.map((q) => new THREE.Vector3(q.x, q.y, q.z));
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        for (const q of p.corners) {
          expect(Math.abs(n.dot(new THREE.Vector3(q.x, q.y, q.z).sub(a)))).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('floor and walk shape', () => {
  it('cuts the two cupola-end corners of the floor at 45°', () => {
    const plan = cupolaPlan(SQUARE, 'y+')!;
    const pts = cupolaFloorOutline(plan);
    expect(pts).toHaveLength(6);
    const key = (p: { x: number; z: number }) => `${p.x},${p.z}`;
    expect(pts.map(key).sort()).toEqual(['-4,6', '-6,-6', '-6,4', '4,6', '6,-6', '6,4'].sort());
  });

  it('works on the x axis too', () => {
    const plan = cupolaPlan(WIDE, 'x-')!;
    const pts = cupolaFloorOutline(plan).map((p) => `${p.x},${p.z}`);
    expect(pts).toContain('-9,-4');
    expect(pts).toContain('-7,-6');
  });

  it('measures clearance from the cut and clamps points back onto the floor', () => {
    const plan = cupolaPlan(SQUARE, 'y+')!;
    expect(cupolaCornerClearance(plan, 0, 0)).toBeGreaterThan(3);
    expect(cupolaCornerClearance(plan, 5, 5)).toBeCloseTo(0, 9); // on the cut line
    expect(cupolaCornerClearance(plan, 5.5, 5.5)).toBeLessThan(0); // out in the cut corner
    expect(cupolaCornerClearance(plan, 5, -5)).toBeGreaterThan(0); // the plain end
    const c = clampOutOfCupolaCorners(plan, 5.5, 5.5, 0.5);
    expect(cupolaCornerClearance(plan, c.x, c.z)).toBeCloseTo(0.5, 9);
    expect(clampOutOfCupolaCorners(plan, 0, 0, 0.5)).toEqual({ x: 0, z: 0 });
    expect(boxClearOfCupolaCorners(plan, { x0: -1, x1: 1, z0: 3, z1: 5 }, 1)).toBe(true);
    expect(boxClearOfCupolaCorners(plan, { x0: 3, x1: 5, z0: 3, z1: 5 }, 1)).toBe(false);
  });

  it('leaves the side walls a shorter run for doors', () => {
    expect(cupolaSideWallRun(cupolaPlan(SQUARE, 'y+')!)).toEqual({ lo: -6, hi: 4 });
    expect(cupolaSideWallRun(cupolaPlan(SQUARE, 'y-')!)).toEqual({ lo: -4, hi: 6 });
  });
});

describe('floorPlan cupola setting', () => {
  beforeEach(() => {
    bindFloorPlan(new Y.Doc());
  });

  it('stores the wall, resolves it against the room size, and walks round it', () => {
    expect(readCupolaWall()).toBeNull();
    expect(roomCupola()).toBeNull();
    expect(insideRoomWalk(5.25, 5.25)).toBe(true);
    writeCupolaWall('y+');
    expect(readCupolaWall()).toBe('y+');
    expect(roomCupola()?.wall).toBe('y+');
    expect(insideRoomWalk(5.25, 5.25)).toBe(false);
    expect(insideRoomWalk(5.25, -5.25)).toBe(true);
    const p = clampToRoomWalk(9, 9);
    expect(insideRoomWalk(p.x, p.z)).toBe(true);
    writeCupolaWall(null);
    expect(roomCupola()).toBeNull();
  });

  it('ends the cupola when a resize makes its wall a side wall', () => {
    writeCupolaWall('y-');
    writeRoomDims(2, 3); // 12 × 18: still extrudes along z, y− still an end
    expect(roomCupola()?.wall).toBe('y-');
    writeRoomDims(3, 2); // 18 × 12: now extrudes along x, y± are side walls
    expect(readCupolaWall()).toBeNull();
    expect(roomCupola()).toBeNull();
    writeRoomDims(2, 2);
    expect(roomCupola()).toBeNull(); // not revived over whatever went there meanwhile
  });
});

describe('buildOctagonHull with a cupola', () => {
  const meshes = (g: THREE.Group) => g.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
  const zRange = (m: THREE.Mesh) => {
    m.geometry.computeBoundingBox();
    return m.geometry.boundingBox!;
  };

  it('replaces the end cap with framed glass and stops the strips at the taper', () => {
    const hull = buildOctagonHull(SQUARE, {}, {}, [], 'y+');
    const ms = meshes(hull.group);
    expect(ms.filter((m) => m.name === 'octagon-cap-wall')).toHaveLength(1); // only y−
    expect(ms.filter((m) => m.name === 'cupola-frame')).toHaveLength(11);
    expect(ms.filter((m) => m.name === 'cupola-glass')).toHaveLength(11);
    for (const wall of ms.filter((m) => m.name === 'octagon-wall')) {
      const box = zRange(wall);
      expect(box.min.z).toBeCloseTo(-6, 6);
      expect(box.max.z).toBeCloseTo(4, 6);
    }
    hull.dispose();
  });

  it('keeps side-wall doors out of the taper and drops a door on the cupola wall', () => {
    const doors = [
      { wall: 'x-' as const, lateral: 4, width: 2, height: 3 },
      { wall: 'y+' as const, lateral: 0, width: 2, height: 3 },
    ];
    const hull = buildOctagonHull(SQUARE, {}, {}, doors, 'y+');
    for (const wall of meshes(hull.group).filter((m) => m.name === 'octagon-wall')) {
      expect(zRange(wall).max.z).toBeLessThanOrEqual(4 + 1e-6);
    }
    hull.dispose();
  });

  it('builds the exterior shell with the cupola too', () => {
    const shell = buildOctagonShell(SQUARE, {}, {}, 'y-');
    const ms = meshes(shell.group);
    expect(ms.filter((m) => m.name === 'octagon-shell-cap')).toHaveLength(1);
    expect(ms.filter((m) => m.name === 'octagon-shell-cupola-glass')).toHaveLength(11);
    shell.dispose();
  });
});

describe('the taper and the things near it', () => {
  it('shortens the strip run and spots wall panels hung past it', () => {
    const plan = cupolaPlan(SQUARE, 'y+')!;
    expect(cupolaStripRun(plan, 6)).toEqual([-6, 4]);
    expect(cupolaStripRun(null, 6)).toEqual([-6, 6]);
    expect(boxInCupolaTaper(plan, { x0: 5.85, x1: 6.15, z0: 2, z1: 3.5 })).toBe(false); // side wall, short of it
    expect(boxInCupolaTaper(plan, { x0: 5.85, x1: 6.15, z0: 3.5, z1: 4.5 })).toBe(true); // reaches into it
    expect(boxInCupolaTaper(plan, { x0: -1, x1: 1, z0: 5.85, z1: 6.15 })).toBe(true); // on the tip glass
    const neg = cupolaPlan(WIDE, 'x-')!;
    expect(boxInCupolaTaper(neg, { x0: -9.15, x1: -8.85, z0: -1, z1: 1 })).toBe(true);
  });

  it('keeps the window editor inside the shortened run', () => {
    bindFloorPlan(new Y.Doc());
    expect(clampWindowAlong(6, 3)).toBeCloseTo(6 - 1.5 - 0.05, 9);
    writeCupolaWall('y+');
    expect(clampWindowAlong(6, 3)).toBeCloseTo(4 - 1.5 - 0.05, 9);
    expect(windowFitsSurface('wall-pos', 9.95, 1)).toBe(false);
    expect(windowFitsSurface('wall-pos', 9.8, 1)).toBe(true);
  });
});
