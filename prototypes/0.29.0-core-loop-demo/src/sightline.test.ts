/**
 * 🦊👁 #345: four players at the double-wide arcade cabinet. A fox is far
 * wider than the 0.4 m between the cabinet's panels, so its stands are a
 * metre apart (closing up at the panels only where the floor is short), and
 * while you play, a fox across your line of sight to the screens is hidden.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FOX_HALF_WIDTH_M, SIGHT_CLEAR_M, blocksSight } from './sightline';

/** A canvas whose 2-D context draws nothing: the fox's face and the
 *  cabinet's screens paint through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { ARCADE_WIDE_STAND_GAP, FURNITURE_DEFS, arcadeWidePanels, buildStandList } = await import('./furniture');
const { VoxelCharacter } = await import('./voxelCharacter');

type Xz = { x: number; z: number };

describe('blocksSight', () => {
  const eye = { x: 0, z: 2 };
  const anchor = { x: 0, z: 0 };
  it('hides a fox on the line, or close enough for its body to reach across it', () => {
    expect(blocksSight(eye, anchor, { x: 0, z: 1 })).toBe(true);
    expect(blocksSight(eye, anchor, { x: SIGHT_CLEAR_M - 0.01, z: 1 })).toBe(true);
    expect(blocksSight(eye, anchor, { x: -(SIGHT_CLEAR_M - 0.01), z: 0.5 })).toBe(true);
  });
  it('leaves a fox clear of the line in sight', () => {
    expect(blocksSight(eye, anchor, { x: SIGHT_CLEAR_M + 0.01, z: 1 })).toBe(false);
    expect(blocksSight(eye, anchor, { x: -1.5, z: 1.9 })).toBe(false);
  });
  it('measures behind the eye from the eye, and beyond what it looks at from that', () => {
    // At your shoulder, just behind the camera: its head is in your face.
    expect(blocksSight(eye, anchor, { x: 0.3, z: 2.4 })).toBe(true);
    expect(blocksSight(eye, anchor, { x: 0, z: 2 + SIGHT_CLEAR_M + 0.01 })).toBe(false);
    // Across the table, beyond its middle: an opponent stays in sight.
    expect(blocksSight(eye, anchor, { x: 0, z: -1.5 })).toBe(false);
  });
  it('copes with an eye right over what it looks at', () => {
    expect(blocksSight(anchor, anchor, { x: 0.2, z: 0 })).toBe(true);
    expect(blocksSight(anchor, anchor, { x: 2, z: 0 })).toBe(false);
  });
});

describe('the fox the rule is measured for', () => {
  it('is no wider than FOX_HALF_WIDTH_M either side, and not much narrower', () => {
    const rig = new VoxelCharacter(new THREE.Scene());
    rig.masterGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.masterGroup);
    const half = Math.max(-box.min.x, box.max.x);
    expect(half).toBeLessThanOrEqual(FOX_HALF_WIDTH_M);
    expect(half).toBeGreaterThan(FOX_HALF_WIDTH_M - 0.05);
  });
});

/** The double-wide cabinet's stands, at the origin facing +z, on a floor
 *  that is walkable wherever `open` says. */
function wideStands(open: (x: number, z: number) => boolean = () => true, rot: 0 | 1 | 2 | 3 = 0) {
  return buildStandList([{ id: 'wide-1', kind: 'arcade-cabinet-wide', pos: { x: 0, z: 0 }, rot, movable: true }], open);
}

describe("the double-wide cabinet's four stands (#345)", () => {
  it('stand a metre apart a pace back, player 1 on the left, the outer two turned in to the screens', () => {
    const stands = wideStands();
    expect(stands.map((s) => s.id)).toEqual(['wide-1:s0', 'wide-1:s1', 'wide-1:s2', 'wide-1:s3']);
    stands.forEach((s, n) => {
      expect(s.front.x).toBeCloseTo((n - 1.5) * ARCADE_WIDE_STAND_GAP, 6);
      expect(s.front.z).toBeGreaterThan(FURNITURE_DEFS['arcade-cabinet-wide'].footprint!.d / 2 + 0.5);
    });
    // Facing the screens (π, toward −z); player 1 turned toward +x, player 4 toward −x.
    expect(stands[0]!.faceAngle).toBeCloseTo((3 * Math.PI) / 4, 6);
    expect(stands[1]!.faceAngle).toBeCloseTo(Math.PI, 6);
    expect(stands[2]!.faceAngle).toBeCloseTo(Math.PI, 6);
    expect(stands[3]!.faceAngle).toBeCloseTo((-3 * Math.PI) / 4, 6);
  });

  /** The closest two of `stands` are this far apart. */
  const closest = (stands: Array<{ front: Xz }>) => {
    let min = Infinity;
    for (let a = 0; a < stands.length; a++) {
      for (let b = a + 1; b < stands.length; b++) {
        min = Math.min(min, Math.hypot(stands[a]!.front.x - stands[b]!.front.x, stands[a]!.front.z - stands[b]!.front.z));
      }
    }
    return min;
  };

  it('close up together, only as far as the floor makes them, in the same order', () => {
    // A wall just past the cabinet's left end: no room for player 1 a metre
    // out, nor three quarters or half of the way there.
    const stands = wideStands((x) => x > -1.0);
    for (const s of stands) expect(s.front.x).toBeGreaterThan(-1.0);
    expect(stands.map((s) => s.front.x)).toEqual([...stands.map((s) => s.front.x)].sort((a, b) => a - b));
    // Still wider apart than their panels, and evenly: nobody on anybody.
    expect(closest(stands)).toBeGreaterThan(0.5);
    expect(stands[0]!.faceAngle).toBeCloseTo((3 * Math.PI) / 4, 6);
    // Even a little room is used: a quarter of the way out.
    expect(stands[0]!.front.x).toBeLessThan(arcadeWidePanels({ pos: { x: 0, z: 0 }, rot: 0 })[0]!.x);
  });

  it('stand right at their own panels, facing the screens, when that is all the floor has', () => {
    const stands = wideStands((x) => x > -0.7);
    const panels = arcadeWidePanels({ pos: { x: 0, z: 0 }, rot: 0 });
    stands.forEach((s, n) => {
      expect(s.front.x).toBeCloseTo(panels[n]!.x, 6);
      expect(s.front.z).toBeCloseTo(1.05, 6);
      expect(s.faceAngle).toBeCloseTo(Math.PI, 6);
    });
    expect(closest(stands)).toBeGreaterThan(0.39);
  });

  it('turn with the cabinet, and so do its panels', () => {
    const stands = wideStands(() => true, 1);
    const panels = arcadeWidePanels({ pos: { x: 0, z: 0 }, rot: 1 });
    // rot 1 turns local +z to world +x: the players stand on the +x side.
    for (const s of stands) expect(s.front.x).toBeGreaterThan(1);
    for (const p of panels) expect(p.x).toBeGreaterThan(0);
    // Player 1 is still on the players' left: local −x is world +z at rot 1.
    expect(stands[0]!.front.z).toBeGreaterThan(stands[3]!.front.z);
    expect(panels[0]!.z).toBeGreaterThan(panels[3]!.z);
  });
});

describe('nobody stands in your view of an arcade screen (#345)', () => {
  /** The view of the screens from the eye: the triangle eye, left edge,
   *  right edge, at the screens' faces as built. The double-wide's two
   *  tubes span 1.2 m; the two-player cabinet's one screen 0.86 m, facing −z. */
  const screens: Record<string, [Xz, Xz]> = {
    'arcade-cabinet-wide': [{ x: -0.6, z: 0.06 }, { x: 0.6, z: 0.06 }],
    'arcade-cabinet-2p': [{ x: 0.43, z: 0.01 }, { x: -0.43, z: 0.01 }],
  };
  /** Whether a fox at `at` (a disc FOX_HALF_WIDTH_M across) reaches into
   *  the triangle a–b–c. */
  const reaches = (at: Xz, [a, b, c]: [Xz, Xz, Xz]) => {
    const side = (p: Xz, q: Xz, r: Xz) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const s1 = side(a, b, at), s2 = side(b, c, at), s3 = side(c, a, at);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    const toSegment = (p: Xz, q: Xz) => {
      const dx = q.x - p.x, dz = q.z - p.z;
      const t = Math.max(0, Math.min(1, ((at.x - p.x) * dx + (at.z - p.z) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(at.x - (p.x + t * dx), at.z - (p.z + t * dz));
    };
    return Math.min(toSegment(a, b), toSegment(b, c), toSegment(c, a)) < FOX_HALF_WIDTH_M;
  };

  for (const kind of ['arcade-cabinet-wide', 'arcade-cabinet-2p'] as const) {
    const floors = [
      ['spread out', () => true],
      ['three quarters out', (x: number) => x > -1.4],
      ['half out', (x: number) => x > -1.2],
      ['a quarter out', (x: number) => x > -1.0],
      ['closed up', (x: number) => x > -0.7],
    ] as const;
    for (const [layout, open] of floors) {
      it(`${kind}, ${layout}: every other player is hidden or out of the way`, () => {
        const def = FURNITURE_DEFS[kind];
        const eye = def.device!.eye;
        const anchor = def.device!.anchor;
        const stands = buildStandList([{ id: 'c', kind, pos: { x: 0, z: 0 }, rot: 0, movable: true }], open);
        expect(stands.length).toBeGreaterThan(1);
        const [left, right] = screens[kind]!;
        for (const s of stands) {
          if (blocksSight(eye, anchor, s.front)) continue;
          expect(reaches(s.front, [eye, left!, right!]), `${s.id} at ${s.front.x}, ${s.front.z}`).toBe(false);
        }
      });
    }
  }
});
