/**
 * 🛑🏗️ Octagon hull builder (issue #80 S1) — turns the pure cross-section from
 * `hullSection.ts` into Three.js meshes: the barrel of a room's shell.
 *
 * Built pieces (all extruded along the LONG floor axis, length L = 2·longHalf):
 *   • 2 vertical SIDE WALLS  (the "central box" doors branch off)
 *   • 3 ROOF sections        (two 45° eaves + a flat ridge — equal length)
 *   • 3 BASEMENT sections    (two 45° chamfers + a flat basement floor)
 *   • 2 octagon END CAPS     — split into a wall band / roof gable / basement
 *                              gable so each obeys the cutaway rule below
 *
 * Two builders share the geometry:
 *   • `buildOctagonHull`  — the INTERIOR barrel (zoom ≤ 2). A one-way cutaway
 *     (see `updateFacing`): in the iso view the near hull we look through is
 *     fully hidden, the far vertical walls show their INSIDE surface, the roof
 *     is gone, and the basement is a solid hull below; in first person you're
 *     inside so everything (incl. the roof) is visible.
 *   • `buildOctagonShell` — the EXTERIOR barrel (zoom ≥ 3), a plain solid hull.
 *
 * Faces are built from explicit corner vertices (a tiny BufferGeometry per
 * quad) so the geometry is EXACT — no rotation math to get subtly wrong.
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

const HULL_COLOR = { wall: 0x2f4256, roof: 0x9bd4e8, basement: 0x24313f };
/** First-person resting opacities (you're INSIDE — see everything). */
const FP_OPACITY = { roof: 0.4, wall: 0.9 };

/** A face whose outward normal dots the camera direction above this is "near"
 *  the camera (its outside is toward us). Same idiom as the #51 door fade. */
const NEAR_DOT = 0.25;

/** A vertical hull face (side wall or end-cap wall band) — camera-facing culled. */
interface WallFace {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  normal: { x: number; z: number };
}
interface HullMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
}

export interface OctagonHull {
  /** Parent group (add to platformGroup). */
  group: THREE.Group;
  profile: OctagonProfile;
  /**
   * Drive the cutaway for the current camera. `camDirX/Z` is the (unit) XZ
   * direction from the room origin toward the camera.
   *  - ISO (firstPerson=false): a one-way cutaway — the NEAR hull we look
   *    through is FULLY hidden, the FAR vertical walls render their INSIDE
   *    surface (opaque), the ROOF is gone entirely, and the BASEMENT stays a
   *    solid hull below. Recomputed each frame so it tracks the rig rotation.
   *  - FIRST PERSON (firstPerson=true): you're inside — all walls solid, the
   *    roof visible (translucent, #80 wants the roof seen in first person).
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
  const {
    narrowAxis,
    longHalf,
    outline,
    edges,
    narrowHalf,
    ridgeHalf,
    wallHeight,
    ridgeY,
    basementHalf,
    basementDepth,
  } = profile;

  const group = new THREE.Group();
  group.name = 'octagonHull';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const wallFaces: WallFace[] = [];
  const roofMeshes: HullMesh[] = [];
  const basementMeshes: HullMesh[] = [];

  const mkMat = (color: number, depthWrite = true) => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.15,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide, // far wall shows its INSIDE face toward the camera
      depthWrite,
    });
    materials.push(mat);
    return mat;
  };

  // ── The 8 extruded strips (one per octagon edge), sorted into wall / roof /
  //    basement so the cutaway can treat each region differently. ────────────
  let wallIndex = 0; // 0 = negative-a wall, 1 = positive-a wall (edge order)
  for (const edge of edges) {
    const p0 = outline[edge.from];
    const p1 = outline[edge.to];
    const geo = quadGeometry(
      sectionToWorld(narrowAxis, p0.a, p0.y, -longHalf),
      sectionToWorld(narrowAxis, p1.a, p1.y, -longHalf),
      sectionToWorld(narrowAxis, p1.a, p1.y, longHalf),
      sectionToWorld(narrowAxis, p0.a, p0.y, longHalf),
    );
    geometries.push(geo);
    if (edge.kind === 'wall') {
      const mat = mkMat(HULL_COLOR.wall);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'octagon-wall';
      group.add(mesh);
      const which = wallIndex === 0 ? 'wall-neg' : 'wall-pos';
      wallFaces.push({ mesh, material: mat, normal: verticalFaceNormal(narrowAxis, which) });
      wallIndex++;
    } else if (edge.kind.startsWith('roof')) {
      const mat = mkMat(HULL_COLOR.roof, false);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `octagon-${edge.kind}`;
      group.add(mesh);
      roofMeshes.push({ mesh, material: mat });
    } else {
      const mat = mkMat(HULL_COLOR.basement);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `octagon-${edge.kind}`;
      group.add(mesh);
      basementMeshes.push({ mesh, material: mat });
    }
  }

  // ── The 2 octagon END CAPS (gable ends) — split into wall band / roof gable /
  //    basement gable so each obeys the same cutaway rule as the strips. ──────
  for (const sign of [-1, 1] as const) {
    const b = sign * longHalf;
    const normal = verticalFaceNormal(narrowAxis, sign > 0 ? 'cap-pos' : 'cap-neg');
    const capQuad = (
      pa: { a: number; y: number },
      pb: { a: number; y: number },
      pc: { a: number; y: number },
      pd: { a: number; y: number },
    ) => {
      const geo = quadGeometry(
        sectionToWorld(narrowAxis, pa.a, pa.y, b),
        sectionToWorld(narrowAxis, pb.a, pb.y, b),
        sectionToWorld(narrowAxis, pc.a, pc.y, b),
        sectionToWorld(narrowAxis, pd.a, pd.y, b),
      );
      geometries.push(geo);
      return geo;
    };
    // wall band (vertical [0, wallHeight])
    {
      const mat = mkMat(HULL_COLOR.wall);
      const mesh = new THREE.Mesh(
        capQuad(
          { a: -narrowHalf, y: 0 },
          { a: -narrowHalf, y: wallHeight },
          { a: narrowHalf, y: wallHeight },
          { a: narrowHalf, y: 0 },
        ),
        mat,
      );
      mesh.name = 'octagon-cap-wall';
      group.add(mesh);
      wallFaces.push({ mesh, material: mat, normal });
    }
    // roof gable (trapezoid above the walls)
    {
      const mat = mkMat(HULL_COLOR.roof, false);
      const mesh = new THREE.Mesh(
        capQuad(
          { a: -narrowHalf, y: wallHeight },
          { a: -ridgeHalf, y: ridgeY },
          { a: ridgeHalf, y: ridgeY },
          { a: narrowHalf, y: wallHeight },
        ),
        mat,
      );
      mesh.name = 'octagon-cap-roof';
      group.add(mesh);
      roofMeshes.push({ mesh, material: mat });
    }
    // basement gable (trapezoid below the floor)
    {
      const mat = mkMat(HULL_COLOR.basement);
      const mesh = new THREE.Mesh(
        capQuad(
          { a: -narrowHalf, y: 0 },
          { a: narrowHalf, y: 0 },
          { a: basementHalf, y: -basementDepth },
          { a: -basementHalf, y: -basementDepth },
        ),
        mat,
      );
      mesh.name = 'octagon-cap-basement';
      group.add(mesh);
      basementMeshes.push({ mesh, material: mat });
    }
  }

  const setMesh = (m: HullMesh, visible: boolean, opacity: number) => {
    m.mesh.visible = visible;
    m.material.opacity = opacity;
    m.material.transparent = opacity < 0.999;
  };

  const updateFacing = (camDirX: number, camDirZ: number, firstPerson: boolean) => {
    if (firstPerson) {
      // Inside: everything visible; roof translucent, walls near-solid.
      for (const m of roofMeshes) setMesh(m, true, FP_OPACITY.roof);
      for (const m of wallFaces) setMesh(m, true, FP_OPACITY.wall);
      for (const m of basementMeshes) setMesh(m, true, 1);
      return;
    }
    // Iso cutaway: no roof; solid basement hull; near/side walls fully hidden;
    // far walls opaque (their inside surface faces the camera).
    for (const m of roofMeshes) m.mesh.visible = false;
    for (const m of basementMeshes) setMesh(m, true, 1);
    for (const f of wallFaces) {
      const dot = f.normal.x * camDirX + f.normal.z * camDirZ;
      if (dot < -NEAR_DOT) setMesh(f, true, 1); // FAR — show inside, opaque
      else f.mesh.visible = false; // NEAR or side-on — completely transparent
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
 * Unlike `buildOctagonHull` (the interior cutaway barrel), this is a plain
 * outward-facing hull with no per-frame fade.
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
