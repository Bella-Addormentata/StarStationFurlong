/**
 * 🛑🏗️ Octagon hull builder (issue #80 S1) — turns the pure cross-section from
 * `hullSection.ts` into Three.js meshes: the barrel of a room's shell.
 *
 * Built pieces (all extruded along the LONG floor axis, length L = 2·longHalf):
 *   • 2 vertical SIDE WALLS  (the "central box" doors branch off)
 *   • 3 ROOF sections        (two 45° eaves + a flat ridge — equal length)
 *   • 3 BASEMENT sections    (two 45° chamfers + a flat basement floor)
 *   • 2 octagon END CAPS     (the gable ends at ±longHalf)
 *
 * Faces are built from explicit corner vertices (a tiny BufferGeometry per
 * quad) so the geometry is EXACT — no rotation math to get subtly wrong — and
 * every vertical face carries its outward XZ normal for the camera-facing
 * transparency fade (`updateFacing`), a first cut at issue #80's requirement 4
 * ("near hull outside face invisible, far inside surface visible" in the iso
 * view; walls stay solid in first person). The full per-slice transparency +
 * neighbour-through-window work is a later slice — this is the preview.
 *
 * Gated behind `?octagon=1` in world.ts; nothing here runs by default.
 */

import * as THREE from 'three';
import {
  computeOctagonProfile,
  sectionToWorld,
  verticalFaceNormal,
  type HullSectionOpts,
  type OctagonProfile,
  type SectionEdge,
} from './hullSection';

/** Resting opacities. FAR walls read as faint glass (matching the legacy 0.35
 *  tile-wall look); NEAR walls all but vanish so the iso camera sees inside. */
const OPACITY = {
  roof: 0.34,
  basement: 0.92,
  wallFar: 0.42,
  wallNear: 0.05,
  wallFirstPerson: 0.85,
};

/** Same split threshold the #51 door fade uses (docking.ts) — a face whose
 *  outward normal dots the camera direction above this is "near" the camera. */
const NEAR_DOT = 0.3;

/** A vertical hull face that participates in the camera-facing fade. */
interface OctagonFace {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  normal: { x: number; z: number };
}

export interface OctagonHull {
  /** Parent group (add to platformGroup). */
  group: THREE.Group;
  profile: OctagonProfile;
  /**
   * Drive per-face transparency for the current camera. `camDirX/Z` is the
   * (unit) XZ direction from the room origin toward the camera; `firstPerson`
   * keeps every wall solid (you are inside, looking around).
   */
  updateFacing(camDirX: number, camDirZ: number, firstPerson: boolean): void;
  /** Dispose all geometry + materials. */
  dispose(): void;
}

/**
 * Build the octagon hull for the given room half-extents (+ optional tuning).
 * `world.ts` calls this behind the flag and adds `.group` to platformGroup.
 */
export function buildOctagonHull(opts: HullSectionOpts): OctagonHull {
  const profile = computeOctagonProfile(opts);
  const { narrowAxis, longHalf, outline, edges } = profile;

  const group = new THREE.Group();
  group.name = 'octagonHull';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const faces: OctagonFace[] = [];

  const mkMat = (color: number, opacity: number, depthWrite: boolean) => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.15,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite,
    });
    mat.userData.baseOpacity = opacity;
    materials.push(mat);
    return mat;
  };

  // ── The 8 extruded strips (one per octagon edge) ───────────────────────────
  let wallIndex = 0; // 0 = negative-a wall, 1 = positive-a wall (edge order)
  for (const edge of edges) {
    const p0 = outline[edge.from];
    const p1 = outline[edge.to];
    // Quad corners, CCW looking from outside: near-end bottom, near-end top,
    // far-end top, far-end bottom (bottom = edge.from, top = edge.to).
    const c0 = sectionToWorld(narrowAxis, p0.a, p0.y, -longHalf);
    const c1 = sectionToWorld(narrowAxis, p1.a, p1.y, -longHalf);
    const c2 = sectionToWorld(narrowAxis, p1.a, p1.y, longHalf);
    const c3 = sectionToWorld(narrowAxis, p0.a, p0.y, longHalf);

    const { color, opacity, depthWrite } = stripStyle(edge);
    const mat = mkMat(color, opacity, depthWrite);
    const geo = quadGeometry(c0, c1, c2, c3);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `octagon-${edge.kind}`;
    group.add(mesh);

    if (edge.kind === 'wall') {
      const which = wallIndex === 0 ? 'wall-neg' : 'wall-pos';
      faces.push({ mesh, material: mat, normal: verticalFaceNormal(narrowAxis, which) });
      wallIndex++;
    }
  }

  // ── The 2 octagon end caps (gable ends), fan-triangulated ──────────────────
  for (const sign of [-1, 1] as const) {
    const mat = mkMat(0x2f4256, sign > 0 ? OPACITY.wallFar : OPACITY.wallNear, true);
    const geo = capGeometry(profile, sign * longHalf);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'octagon-end-cap';
    group.add(mesh);
    faces.push({
      mesh,
      material: mat,
      normal: verticalFaceNormal(narrowAxis, sign > 0 ? 'cap-pos' : 'cap-neg'),
    });
  }

  // ── Bright edge outline — draws OVER everything (depthTest off) so the 8-sided
  //    octagon barrel is unmistakable even where the faces are see-through and
  //    even the basement edges read THROUGH the floor. (Preview affordance.)
  {
    const linePts: number[] = [];
    const push = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
      linePts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    const n = outline.length;
    for (let i = 0; i < n; i++) {
      const p = outline[i];
      const q = outline[(i + 1) % n];
      // the two octagon rings (near + far end caps)
      push(sectionToWorld(narrowAxis, p.a, p.y, -longHalf), sectionToWorld(narrowAxis, q.a, q.y, -longHalf));
      push(sectionToWorld(narrowAxis, p.a, p.y, longHalf), sectionToWorld(narrowAxis, q.a, q.y, longHalf));
      // the longitudinal connector at this vertex
      push(sectionToWorld(narrowAxis, p.a, p.y, -longHalf), sectionToWorld(narrowAxis, p.a, p.y, longHalf));
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePts), 3));
    geometries.push(edgeGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x5fe6ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    materials.push(edgeMat);
    const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeLines.name = 'octagon-edges';
    edgeLines.renderOrder = 10; // draw on top
    group.add(edgeLines);
  }

  const updateFacing = (camDirX: number, camDirZ: number, firstPerson: boolean) => {
    for (const face of faces) {
      if (firstPerson) {
        face.material.opacity = OPACITY.wallFirstPerson;
        continue;
      }
      const dot = face.normal.x * camDirX + face.normal.z * camDirZ;
      face.material.opacity = dot > NEAR_DOT ? OPACITY.wallNear : OPACITY.wallFar;
    }
  };

  const dispose = () => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    group.clear();
  };

  return { group, profile, updateFacing, dispose };
}

export interface OctagonShellStyle {
  /** Wall + end-cap colour. */
  hull?: number;
  /** Roof (eave + ridge) colour. */
  roof?: number;
  /** Basement (chamfer + floor) colour. */
  basement?: number;
  /** Seam-edge colour. */
  edge?: number;
  /** <1 makes the whole shell translucent (atlas neighbours read as ghosts). */
  opacity?: number;
}

export interface OctagonShell {
  group: THREE.Group;
  dispose(): void;
}

/**
 * 🛑🛰️ Build a SOLID octagon shell — the module seen FROM OUTSIDE at zoom ≥ 3
 * (the exterior / atlas view). Opaque metallic faces (roof / walls / basement
 * tinted apart) plus a seam outline so the 8-sided barrel reads at a glance.
 * Unlike `buildOctagonHull` (the translucent, camera-faded interior barrel),
 * this is a plain outward-facing hull with no per-frame fade.
 */
export function buildOctagonShell(
  opts: HullSectionOpts,
  style: OctagonShellStyle = {},
): OctagonShell {
  const profile = computeOctagonProfile(opts);
  const { narrowAxis, longHalf, outline, edges } = profile;
  const hull = style.hull ?? 0x3a4556;
  const roofC = style.roof ?? 0x2f3a4c;
  const baseC = style.basement ?? 0x27303d;
  const edgeC = style.edge ?? 0x9fb4d0;
  const opacity = style.opacity ?? 1;
  const transparent = opacity < 1;

  const group = new THREE.Group();
  group.name = 'octagonShell';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const mk = (color: number) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.6,
      metalness: 0.5,
      transparent,
      opacity,
      side: THREE.DoubleSide,
    });
    materials.push(m);
    return m;
  };
  const faceColor = (kind: SectionEdge['kind']) =>
    kind.startsWith('roof') ? roofC : kind.startsWith('basement') ? baseC : hull;

  for (const edge of edges) {
    const p0 = outline[edge.from];
    const p1 = outline[edge.to];
    const c0 = sectionToWorld(narrowAxis, p0.a, p0.y, -longHalf);
    const c1 = sectionToWorld(narrowAxis, p1.a, p1.y, -longHalf);
    const c2 = sectionToWorld(narrowAxis, p1.a, p1.y, longHalf);
    const c3 = sectionToWorld(narrowAxis, p0.a, p0.y, longHalf);
    const geo = quadGeometry(c0, c1, c2, c3);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mk(faceColor(edge.kind)));
    mesh.name = `octagon-shell-${edge.kind}`;
    group.add(mesh);
  }
  for (const sign of [-1, 1] as const) {
    const geo = capGeometry(profile, sign * longHalf);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mk(hull));
    mesh.name = 'octagon-shell-cap';
    group.add(mesh);
  }

  // Seam outline (both octagon rings + longitudinal connectors) — depth-tested,
  // so it reads as edge trim on the solid hull rather than an x-ray overlay.
  {
    const pts: number[] = [];
    const push = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const n = outline.length;
    for (let i = 0; i < n; i++) {
      const p = outline[i];
      const q = outline[(i + 1) % n];
      push(sectionToWorld(narrowAxis, p.a, p.y, -longHalf), sectionToWorld(narrowAxis, q.a, q.y, -longHalf));
      push(sectionToWorld(narrowAxis, p.a, p.y, longHalf), sectionToWorld(narrowAxis, q.a, q.y, longHalf));
      push(sectionToWorld(narrowAxis, p.a, p.y, -longHalf), sectionToWorld(narrowAxis, p.a, p.y, longHalf));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    geometries.push(geo);
    const mat = new THREE.LineBasicMaterial({ color: edgeC, transparent, opacity: Math.min(1, opacity + 0.1) });
    materials.push(mat);
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'octagon-shell-edges';
    group.add(lines);
  }

  const dispose = () => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    group.clear();
  };
  return { group, dispose };
}

/** Colour/opacity/depthWrite for a strip by its edge kind. */
function stripStyle(edge: SectionEdge): {
  color: number;
  opacity: number;
  depthWrite: boolean;
} {
  switch (edge.kind) {
    case 'roof-eave':
    case 'roof-ridge':
      // Glassy blue roof — translucent, always visible; depthWrite off so the
      // interior reads through it cleanly.
      return { color: 0x9bd4e8, opacity: OPACITY.roof, depthWrite: false };
    case 'basement-chamfer':
    case 'basement-floor':
      // Slate basement pit — near-opaque so it reads as a real void below.
      return { color: 0x24313f, opacity: OPACITY.basement, depthWrite: true };
    case 'wall':
    default:
      // Side walls start at the FAR opacity; updateFacing overrides per frame.
      return { color: 0x2f4256, opacity: OPACITY.wallFar, depthWrite: true };
  }
}

/** A double-sided quad (two triangles) from four world corners. */
function quadGeometry(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** The octagon outline filled at along-axis coordinate `b`, fan-triangulated. */
function capGeometry(profile: OctagonProfile, b: number): THREE.BufferGeometry {
  const { narrowAxis, outline } = profile;
  const verts: number[] = [];
  const n = outline.length;
  // Fan from vertex 0.
  for (let i = 1; i < n - 1; i++) {
    for (const idx of [0, i, i + 1]) {
      const p = outline[idx];
      const w = sectionToWorld(narrowAxis, p.a, p.y, b);
      verts.push(w.x, w.y, w.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return geo;
}
