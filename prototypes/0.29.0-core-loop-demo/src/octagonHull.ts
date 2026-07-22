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
  surfaceEdge,
  SURFACE_BY_EDGE,
  type HullSectionOpts,
  type OctagonProfile,
  type SectionEdge,
  type NarrowAxis,
  type StripEdge,
  type HullSurface,
} from './hullSection';

const HULL_COLOR = { wall: 0x2f4256, roof: 0x9bd4e8, basement: 0x24313f };
/** First-person resting opacities (you're INSIDE — see everything). The roof is
 *  OPAQUE so it reads as a real ceiling (its inside surface), not see-through
 *  glass you look at the sky through. Roof windows are separate holes. */
const FP_OPACITY = { roof: 1, wall: 0.9 };

/** A face whose outward normal dots the camera direction above this is "near"
 *  the camera (its outside is toward us). Same idiom as the #51 door fade. */
const NEAR_DOT = 0.25;

/** A vertical hull face (side wall or end-cap wall band) — camera-facing culled.
 *  `glass` = the window panes on this face, toggled visible with it. */
interface WallFace {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  normal: { x: number; z: number };
  glass?: THREE.Mesh[];
}
interface HullMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  glass?: THREE.Mesh[];
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

/** 🪟 #80: a rounded-rect WINDOW opening cut from a hull STRIP, in that strip's
 *  local frame: `along` = position along the extrude (long) axis, `across` =
 *  position along the strip's cross-section edge (walls: height; eaves: up-slope
 *  distance…), `w`×`h` = size, `r` = corner radius. Same idea as the pool's
 *  floor holes, generalised to any of the 8 octagon surfaces. */
export interface WindowOpening {
  along: number;
  across: number;
  w: number;
  h: number;
  r: number;
}
/** Openings per hull surface (any of the 8 barrel strips). */
export type HullWindows = Partial<Record<HullSurface, WindowOpening[]>>;

/**
 * Build the octagon hull for the given room half-extents (+ optional tuning).
 * `windows` cuts rounded-rect openings in the two side walls (look outside).
 * `world.ts` calls this behind the flag and adds `.group` to platformGroup.
 */
export function buildOctagonHull(
  opts: HullSectionOpts,
  windows: HullWindows = {},
): OctagonHull {
  const profile = computeOctagonProfile(opts);
  const {
    narrowAxis,
    longHalf,
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
  //    basement so the cutaway can treat each region differently. Every strip
  //    now takes the SAME hole-aware path (stripGeometry): a plain quad when it
  //    has no windows, else a ShapeGeometry with rounded-rect openings. ───────
  edges.forEach((edge, edgeIndex) => {
    const surface = SURFACE_BY_EDGE[edgeIndex];
    const strip = surfaceEdge(profile, surface);
    const openings = windows[surface];
    const geo = stripGeometry(narrowAxis, strip, longHalf, openings);
    geometries.push(geo);

    // 🪟 translucent glass filling each opening (barely-there blue — the view
    // through it is the point; depthWrite off so it never occludes the sky).
    // Collected so the cutaway toggles each pane with its owning face.
    const glass: THREE.Mesh[] = [];
    if (openings) {
      for (const o of openings) {
        const gGeo = stripGlassGeometry(narrowAxis, strip, o);
        geometries.push(gGeo);
        const gMat = newGlassMaterial();
        materials.push(gMat);
        const gMesh = new THREE.Mesh(gGeo, gMat);
        gMesh.name = 'octagon-window-glass';
        group.add(gMesh);
        glass.push(gMesh);
      }
    }

    if (edge.kind === 'wall') {
      const mat = mkMat(HULL_COLOR.wall);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'octagon-wall';
      group.add(mesh);
      const which = surface === 'wall-neg' ? 'wall-neg' : 'wall-pos';
      wallFaces.push({ mesh, material: mat, normal: verticalFaceNormal(narrowAxis, which), glass });
    } else if (edge.kind.startsWith('roof')) {
      const mat = mkMat(HULL_COLOR.roof);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `octagon-${edge.kind}`;
      group.add(mesh);
      roofMeshes.push({ mesh, material: mat, glass });
    } else {
      const mat = mkMat(HULL_COLOR.basement);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `octagon-${edge.kind}`;
      group.add(mesh);
      basementMeshes.push({ mesh, material: mat, glass });
    }
  });

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
      const mat = mkMat(HULL_COLOR.roof);
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

  // Each strip's window glass is toggled visible WITH its owning face — else a
  // culled roof's skylight glass would float, or a hidden near-wall's pane show
  // through. Visibility only; the glass keeps its 0.18 opacity.
  const setGlass = (m: { glass?: THREE.Mesh[] }, visible: boolean) => {
    if (m.glass) for (const g of m.glass) g.visible = visible;
  };
  const setMesh = (
    m: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; glass?: THREE.Mesh[] },
    visible: boolean,
    opacity: number,
  ) => {
    m.mesh.visible = visible;
    m.material.opacity = opacity;
    m.material.transparent = opacity < 0.999;
    setGlass(m, visible);
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
    for (const m of roofMeshes) {
      m.mesh.visible = false;
      setGlass(m, false);
    }
    for (const m of basementMeshes) setMesh(m, true, 1);
    for (const f of wallFaces) {
      const dot = f.normal.x * camDirX + f.normal.z * camDirZ;
      if (dot < -NEAR_DOT) setMesh(f, true, 1); // FAR — show inside, opaque
      else {
        f.mesh.visible = false; // NEAR or side-on — completely transparent
        setGlass(f, false);
      }
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
  windows: HullWindows = {},
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

  edges.forEach((edge, edgeIndex) => {
    const surface = SURFACE_BY_EDGE[edgeIndex];
    const strip = surfaceEdge(profile, surface);
    const openings = windows[surface];
    const geo = stripGeometry(narrowAxis, strip, longHalf, openings);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mk(faceColor(edge.kind)));
    mesh.name = `octagon-shell-${edge.kind}`;
    group.add(mesh);
    // 🪟 the CURRENT room's windows show as holes + glass on the solid exterior
    // barrel (no cutaway here, so every surface's panes render plainly).
    if (openings) {
      for (const o of openings) {
        const gGeo = stripGlassGeometry(narrowAxis, strip, o);
        geometries.push(gGeo);
        const gMat = newGlassMaterial();
        materials.push(gMat);
        const gMesh = new THREE.Mesh(gGeo, gMat);
        gMesh.name = 'octagon-shell-window-glass';
        group.add(gMesh);
      }
    }
  });
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

/** Trace a rounded-rect (centred cx,cy) onto a Path or Shape. */
function applyRoundedRect(p: THREE.Path, cx: number, cy: number, w: number, h: number, r: number): void {
  const hw = w / 2,
    hh = h / 2;
  const rr = Math.max(0, Math.min(r, hw, hh));
  p.moveTo(cx - hw + rr, cy - hh);
  p.lineTo(cx + hw - rr, cy - hh);
  p.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + rr);
  p.lineTo(cx + hw, cy + hh - rr);
  p.quadraticCurveTo(cx + hw, cy + hh, cx + hw - rr, cy + hh);
  p.lineTo(cx - hw + rr, cy + hh);
  p.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - rr);
  p.lineTo(cx - hw, cy - hh + rr);
  p.quadraticCurveTo(cx - hw, cy - hh, cx - hw + rr, cy - hh);
  p.closePath();
}

/** A rounded-rect Path (hole), 2D (u=along, v=height). */
function roundedRectPath(cx: number, cy: number, w: number, h: number, r: number): THREE.Path {
  const p = new THREE.Path();
  applyRoundedRect(p, cx, cy, w, h, r);
  return p;
}

/** A fresh translucent glass material (barely-there blue; depthWrite off so a
 *  pane never occludes the sky/planet behind it). One per pane. */
function newGlassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x9bd4e8,
    roughness: 0.1,
    metalness: 0.2,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** World position of a strip-local point (u=along-extrude, v=across-edge). */
function stripToWorld(
  narrowAxis: NarrowAxis,
  strip: StripEdge,
  u: number,
  v: number,
): { x: number; y: number; z: number } {
  return sectionToWorld(narrowAxis, strip.p0.a + strip.dir.a * v, strip.p0.y + strip.dir.y * v, u);
}

/** Remap a ShapeGeometry built in strip-local (u=along=x, v=across=y) onto the
 *  strip (p0, dir): a = p0.a + dir.a·v, y = p0.y + dir.y·v, world =
 *  sectionToWorld(narrowAxis, a, y, u). Reduces exactly to the old constant-`a`
 *  wall remap for a vertical wall (p0.a const, y=v). */
function remapStripToWorld(
  geo: THREE.BufferGeometry,
  narrowAxis: NarrowAxis,
  p0: { a: number; y: number },
  dir: { a: number; y: number },
): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const world = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i);
    const v = pos.getY(i);
    const w = sectionToWorld(narrowAxis, p0.a + dir.a * v, p0.y + dir.y * v, u);
    world[i * 3] = w.x;
    world[i * 3 + 1] = w.y;
    world[i * 3 + 2] = w.z;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(world, 3));
  geo.computeVertexNormals();
  return geo;
}

/** 🪟 The glass pane filling one window opening, on the strip (p0, dir). */
function stripGlassGeometry(narrowAxis: NarrowAxis, strip: StripEdge, o: WindowOpening): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  applyRoundedRect(shape, o.along, o.across, o.w, o.h, o.r);
  return remapStripToWorld(new THREE.ShapeGeometry(shape), narrowAxis, strip.p0, strip.dir);
}

/**
 * 🪟 A hull STRIP face, spanning the extrude axis [−longHalf, longHalf] × across
 * [0, edgeLen]. No openings ⇒ a plain quad (the same 4 world corners as the
 * legacy per-edge quad); with openings ⇒ a ShapeGeometry (strip rect minus
 * rounded-rect window holes), triangulated in strip-local (u=along, v=across)
 * then each vertex mapped to world via remapStripToWorld — no orientation math
 * to get wrong. Works for every surface: vertical walls, 45° eaves/chamfers,
 * and the horizontal ridge / basement floor alike.
 */
function stripGeometry(
  narrowAxis: NarrowAxis,
  strip: StripEdge,
  longHalf: number,
  openings: WindowOpening[] | undefined,
): THREE.BufferGeometry {
  const { p0, dir, edgeLen } = strip;
  if (!openings || openings.length === 0) {
    return quadGeometry(
      stripToWorld(narrowAxis, strip, -longHalf, 0),
      stripToWorld(narrowAxis, strip, -longHalf, edgeLen),
      stripToWorld(narrowAxis, strip, longHalf, edgeLen),
      stripToWorld(narrowAxis, strip, longHalf, 0),
    );
  }
  const shape = new THREE.Shape();
  shape.moveTo(-longHalf, 0);
  shape.lineTo(longHalf, 0);
  shape.lineTo(longHalf, edgeLen);
  shape.lineTo(-longHalf, edgeLen);
  shape.closePath();
  for (const o of openings) {
    // clamp the opening inside the strip run (along) + edge span (across) so the
    // hole never breaks the outline (thin strips just centre it)
    const along = Math.max(-longHalf + o.w / 2 + 0.05, Math.min(longHalf - o.w / 2 - 0.05, o.along));
    const across = Math.max(o.h / 2 + 0.05, Math.min(edgeLen - o.h / 2 - 0.05, o.across));
    shape.holes.push(roundedRectPath(along, across, o.w, o.h, o.r));
  }
  return remapStripToWorld(new THREE.ShapeGeometry(shape), narrowAxis, p0, dir);
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
