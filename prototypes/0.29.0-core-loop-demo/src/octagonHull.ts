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
import { resolveWallpaper, type WallpaperPresetId, type WallpaperSpec } from './wallpaper';

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

/** 🖼️ #80 S6: a wall-covering preset per hull surface (any of the 8 strips).
 *  Absent / `plain` → the bare hull colour. Painted on by the wallpaper editor. */
export type HullWallpapers = Partial<Record<HullSurface, WallpaperPresetId>>;

/**
 * 🚪 #92: the FOUR vertical hull faces a door can punch through — the two SIDE
 * WALLS (extruded strips at ±narrowHalf on the narrow axis) plus the two END
 * CAPS (at ±longHalf on the long axis, currently the plain wall-band quads).
 *
 * Note the deliberate mismatch with `HullSurface`: an end cap is not a
 * cross-section-edge strip, so it isn't one of the 8 window-carrying surfaces
 * — but it IS one of the 4 walls a room's occupant walks into and cuts a door
 * through. Same-name overlap with 'wall-neg'/'wall-pos' keeps the two side-wall
 * cases interchangeable with the strip surface (see `resolveDoorCut`).
 */
export type DoorSurface = 'wall-neg' | 'wall-pos' | 'cap-neg' | 'cap-pos';

/**
 * 🚪 #92: a RECTANGULAR door opening cut from one of the 4 vertical hull faces,
 * in that face's local frame:
 *  - `along` = position of the door CENTRE along the wall's tangent axis
 *    (extrude coord on the two side walls; narrow-axis coord `a` on the end
 *    caps). Equals the door layout record's `lateral` on every wall.
 *  - `w` = opening width along the wall (`DOOR_OPENING_WIDTH`, 2.0 m).
 *  - `h` = opening height — the notch spans `across ∈ [0, h]`, sitting flush on
 *    the floor so you walk through no hull geometry (contrast a `WindowOpening`,
 *    which is an INTERIOR rounded-rect hole and CANNOT touch the strip edges
 *    without breaking triangulation).
 *
 * The door NEVER carries a corner radius — the frame's own posts + header cover
 * the opening edges, so any radius would just leave visible hull inside the
 * frame. Merged into the outline as a bottom-edge notch (see
 * `notchedRectOutline`), not stashed in `Shape.holes`.
 */
export interface DoorOpening {
  along: number;
  w: number;
  h: number;
}

/** 🚪 #92: door cuts per vertical hull face (any of the 4 walls). Unlike
 *  `HullWindows`, this map's keys are `DoorSurface` (side walls + end caps),
 *  because a door on an END CAP still needs to punch its opening. */
export type HullDoorCuts = Partial<Record<DoorSurface, DoorOpening[]>>;

/**
 * Build the octagon hull for the given room half-extents (+ optional tuning).
 * `windows` cuts rounded-rect openings in the barrel strips (look outside).
 * `wallpapers` paints a covering texture onto individual strips (#80 S6).
 * `doors` cuts floor-flush rectangular NOTCHES per door on any of the 4
 * vertical walls (2 side-wall strips + 2 end-cap wall bands) so a doorway
 * actually opens through the hull — #92. `world.ts` calls this behind the flag
 * and adds `.group` to platformGroup.
 */
export function buildOctagonHull(
  opts: HullSectionOpts,
  windows: HullWindows = {},
  wallpapers: HullWallpapers = {},
  doors: HullDoorCuts = {},
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

  // A hull face material. With a wallpaper `wp` it wears that covering's texture
  // + finish (the map tiles in strip-local metres — see wallpaper.ts); without
  // one it's the flat hull colour. Either way it stays transparent + DoubleSide
  // so updateFacing's per-frame opacity/visibility cutaway drives it unchanged.
  const mkMat = (color: number, depthWrite = true, wp: WallpaperSpec | null = null) => {
    const mat = new THREE.MeshStandardMaterial({
      color: wp ? wp.color : color,
      map: wp ? wp.map : null,
      roughness: wp ? wp.roughness : 0.55,
      metalness: wp ? wp.metalness : 0.15,
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
    // 🖼️ this strip's optional wall covering (null when plain / absent).
    const wp = resolveWallpaper(wallpapers[surface] ?? 'plain');
    // Clamp openings to fit the strip ONCE (drops any too big to fit), so the
    // hole and its glass share identical, in-bounds coordinates.
    const openings = clampedOpenings(windows[surface], strip, longHalf);
    // 🚪 #92: door NOTCHES on the two vertical SIDE-WALL strips (extruded
    // walls at ±narrowHalf). Every other strip — roof eaves, ridge, basement
    // chamfers / floor — carries no door: only the vertical walls do, by
    // definition (a door stands upright on the floor). Same-name key overlap
    // makes 'wall-neg'/'wall-pos' index this map interchangeably.
    const isSideWall = surface === 'wall-neg' || surface === 'wall-pos';
    const doorCuts = isSideWall
      ? clampedDoorCuts(doors[surface], -longHalf, longHalf, strip.edgeLen)
      : [];
    const geo = stripGeometry(narrowAxis, strip, longHalf, openings, doorCuts);
    geometries.push(geo);

    // 🪟 translucent glass filling each opening (barely-there blue — the view
    // through it is the point; depthWrite off so it never occludes the sky).
    // Collected so the cutaway toggles each pane with its owning face.
    const glass: THREE.Mesh[] = [];
    {
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
      const mat = mkMat(HULL_COLOR.wall, true, wp);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'octagon-wall';
      group.add(mesh);
      const which = surface === 'wall-neg' ? 'wall-neg' : 'wall-pos';
      wallFaces.push({ mesh, material: mat, normal: verticalFaceNormal(narrowAxis, which), glass });
    } else if (edge.kind.startsWith('roof')) {
      const mat = mkMat(HULL_COLOR.roof, true, wp);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `octagon-${edge.kind}`;
      group.add(mesh);
      roofMeshes.push({ mesh, material: mat, glass });
    } else {
      const mat = mkMat(HULL_COLOR.basement, true, wp);
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
    const capSurface: DoorSurface = sign > 0 ? 'cap-pos' : 'cap-neg';
    const normal = verticalFaceNormal(narrowAxis, capSurface);
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
    // wall band (vertical [0, wallHeight]) — with any door notches on THIS cap.
    // 🚪 #92: an end cap is one of the room's 4 walls a door can sit on, so its
    // wall band cannot be a plain quad any more. Its (a, y) rectangle stays the
    // same when there are no cuts; when there are, the outline notches down to
    // the floor at each door so the opening reaches world y=0 with no sliver.
    {
      const mat = mkMat(HULL_COLOR.wall);
      const capDoorCuts = clampedDoorCuts(doors[capSurface], -narrowHalf, narrowHalf, wallHeight);
      const geo = capDoorCuts.length === 0
        ? capQuad(
            { a: -narrowHalf, y: 0 },
            { a: -narrowHalf, y: wallHeight },
            { a: narrowHalf, y: wallHeight },
            { a: narrowHalf, y: 0 },
          )
        : capWallBandGeometry(narrowAxis, b, -narrowHalf, narrowHalf, wallHeight, capDoorCuts);
      if (capDoorCuts.length !== 0) geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
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
  doors: HullDoorCuts = {},
): OctagonShell {
  const profile = computeOctagonProfile(opts);
  const { narrowAxis, longHalf, outline, edges, narrowHalf, wallHeight } = profile;
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
    const openings = clampedOpenings(windows[surface], strip, longHalf);
    // 🚪 #92: side-wall door notches on the exterior shell — mirrors the
    // interior barrel so a docking tube / berthed ship at that door lines up
    // with an actual hole, not a solid hull with a floating tube in front.
    const isSideWall = surface === 'wall-neg' || surface === 'wall-pos';
    const doorCuts = isSideWall
      ? clampedDoorCuts(doors[surface], -longHalf, longHalf, strip.edgeLen)
      : [];
    const geo = stripGeometry(narrowAxis, strip, longHalf, openings, doorCuts);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mk(faceColor(edge.kind)));
    mesh.name = `octagon-shell-${edge.kind}`;
    group.add(mesh);
    // 🪟 the CURRENT room's windows show as holes + glass on the solid exterior
    // barrel (no cutaway here, so every surface's panes render plainly).
    for (const o of openings) {
      const gGeo = stripGlassGeometry(narrowAxis, strip, o);
      geometries.push(gGeo);
      const gMat = newGlassMaterial();
      materials.push(gMat);
      const gMesh = new THREE.Mesh(gGeo, gMat);
      gMesh.name = 'octagon-shell-window-glass';
      group.add(gMesh);
    }
  });
  // 🚪 #92: END-CAP wall bands, split off the octagon fan so the door notches
  // land only on the vertical [0, wallHeight] band and the roof/basement gables
  // stay intact. Signature parity with the interior barrel: same clamp, same
  // notched outline; only the material differs (single hull tint here). When a
  // cap carries no door cuts, `capGeometryWithDoors` falls through to the
  // legacy `capGeometry` fan, so the shell without doors is byte-identical.
  for (const sign of [-1, 1] as const) {
    const b = sign * longHalf;
    const capSurface: DoorSurface = sign > 0 ? 'cap-pos' : 'cap-neg';
    const capDoorCuts = clampedDoorCuts(doors[capSurface], -narrowHalf, narrowHalf, wallHeight);
    const geo = capGeometryWithDoors(profile, b, capDoorCuts);
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

/** Inset keeping an opening off the strip ends (so the hole stays strictly
 *  inside the outline — ShapeGeometry triangulation requires it). */
const WINDOW_INSET = 0.05;

/**
 * 🪟 Clamp one opening to fit the strip, returning in-bounds (along, across) — or
 * null when the opening is simply too big for the strip (a thin ridge / floor /
 * eave, or a room resize shrank the surface below the stored window size). A
 * hole that overflows the outline breaks THREE.ShapeUtils.triangulateShape
 * (self-intersecting triangles → a garbled/missing face), so we DROP it rather
 * than emit a broken pane. The hole and its glass both consume this result, so
 * they can never diverge.
 */
function clampOpening(strip: StripEdge, longHalf: number, o: WindowOpening): WindowOpening | null {
  if (o.w > 2 * longHalf - 2 * WINDOW_INSET || o.h > strip.edgeLen - 2 * WINDOW_INSET) return null;
  const along = Math.max(-longHalf + o.w / 2 + WINDOW_INSET, Math.min(longHalf - o.w / 2 - WINDOW_INSET, o.along));
  const across = Math.max(o.h / 2 + WINDOW_INSET, Math.min(strip.edgeLen - o.h / 2 - WINDOW_INSET, o.across));
  return { ...o, along, across };
}

/** Map + clamp a surface's raw openings to the ones that actually fit. */
function clampedOpenings(
  raw: WindowOpening[] | undefined,
  strip: StripEdge,
  longHalf: number,
): WindowOpening[] {
  const out: WindowOpening[] = [];
  if (raw) {
    for (const o of raw) {
      const c = clampOpening(strip, longHalf, o);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * 🪟 A hull STRIP face, spanning the extrude axis [−longHalf, longHalf] × across
 * [0, edgeLen]. No openings AND no door cuts ⇒ a plain quad (the same 4 world
 * corners as the legacy per-edge quad); otherwise ⇒ a ShapeGeometry:
 *  - `openings` (windows) are rounded-rect INTERIOR holes.
 *  - `doorCuts` (#92) are floor-flush notches punched into the BOTTOM outline
 *    itself, so the opening reaches the floor with no hull sliver (a window
 *    hole cannot: `across=0` would touch the outline and break triangulation).
 *
 * Triangulated in strip-local (u=along, v=across), then each vertex mapped to
 * world via `remapStripToWorld` — no orientation math to get wrong. Works for
 * every surface (walls / eaves / ridge / basement), though door cuts are only
 * ever pushed to the two vertical side-wall strips by the caller. `openings`
 * are already clamped-to-fit (`clampedOpenings`) and `doorCuts` clamped by
 * `clampedDoorCuts`.
 */
function stripGeometry(
  narrowAxis: NarrowAxis,
  strip: StripEdge,
  longHalf: number,
  openings: WindowOpening[],
  doorCuts: DoorOpening[] = [],
): THREE.BufferGeometry {
  const { p0, dir, edgeLen } = strip;
  if (openings.length === 0 && doorCuts.length === 0) {
    // Strip-local UVs in METRES (u = along, v = across) so a wallpaper texture
    // tiles at a fixed per-metre scale — matching the ShapeGeometry path below,
    // whose UVs are the shape's own (along, across) coords.
    return quadGeometry(
      stripToWorld(narrowAxis, strip, -longHalf, 0),
      stripToWorld(narrowAxis, strip, -longHalf, edgeLen),
      stripToWorld(narrowAxis, strip, longHalf, edgeLen),
      stripToWorld(narrowAxis, strip, longHalf, 0),
      [
        { u: -longHalf, v: 0 },
        { u: -longHalf, v: edgeLen },
        { u: longHalf, v: edgeLen },
        { u: longHalf, v: 0 },
      ],
    );
  }
  const shape = buildNotchedShape(-longHalf, longHalf, edgeLen, doorCuts);
  for (const o of openings) {
    shape.holes.push(roundedRectPath(o.along, o.across, o.w, o.h, o.r));
  }
  return remapStripToWorld(new THREE.ShapeGeometry(shape), narrowAxis, p0, dir);
}

/**
 * 🚪 #92: build the (u, v) `THREE.Shape` for a notched rectangle — the pure
 * outline from `notchedRectOutline` traced as a Shape path. Kept separate from
 * that helper so the outline stays THREE-free + vitest-testable (it's a plain
 * array of `{along, across}` points) while the Shape construction is one
 * `moveTo` + N `lineTo`s + `closePath` here.
 */
function buildNotchedShape(
  alongMin: number,
  alongMax: number,
  edgeMax: number,
  doorCuts: readonly DoorOpening[],
): THREE.Shape {
  const outline = notchedRectOutline(alongMin, alongMax, edgeMax, doorCuts);
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].along, outline[0].across);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].along, outline[i].across);
  shape.closePath();
  return shape;
}

/**
 * 🚪 #92: build the END-CAP WALL BAND ShapeGeometry (the vertical
 * a ∈ [alongMin, alongMax], y ∈ [0, edgeMax] rectangle at extrude coord `b`,
 * with door notches on the bottom edge). Mirrors `stripGeometry`'s ShapeGeometry
 * path but remaps (u=a, v=y) → world via `sectionToWorld(narrowAxis, u, v, b)`
 * — different remap because a cap's `u` is the cross-section a-axis, not the
 * extrude axis. `doorCuts` are already clamped by `clampedDoorCuts`.
 */
function capWallBandGeometry(
  narrowAxis: NarrowAxis,
  b: number,
  alongMin: number,
  alongMax: number,
  edgeMax: number,
  doorCuts: DoorOpening[],
): THREE.BufferGeometry {
  const shape = buildNotchedShape(alongMin, alongMax, edgeMax, doorCuts);
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position;
  const world = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i); // a-axis coord
    const v = pos.getY(i); // y coord
    const w = sectionToWorld(narrowAxis, u, v, b);
    world[i * 3] = w.x;
    world[i * 3 + 1] = w.y;
    world[i * 3 + 2] = w.z;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(world, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A double-sided quad (two triangles a-b-c / a-c-d) from four world corners.
 *  Optional `uvs` (per corner a,b,c,d) attach a UV attribute in the same winding
 *  — used to tile a wallpaper texture; omit for the untextured caps. */
function quadGeometry(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
  uvs?: [
    { u: number; v: number },
    { u: number; v: number },
    { u: number; v: number },
    { u: number; v: number },
  ],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uvs) {
    const [ua, ub, uc, ud] = uvs;
    geo.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Float32Array([
          ua.u, ua.v, ub.u, ub.v, uc.u, uc.v,
          ua.u, ua.v, uc.u, uc.v, ud.u, ud.v,
        ]),
        2,
      ),
    );
  }
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

/**
 * 🚪 #92: the exterior-shell end cap with any door notches punched into its
 * WALL BAND. When there are no cuts, this is byte-identical to the plain
 * `capGeometry` (one fan-triangulated mesh over the full octagon outline) so a
 * cap without doors gets no new triangles. With cuts, the octagon is split
 * into three pieces — wall band (with notches), roof gable, basement gable —
 * merged into one BufferGeometry so the caller still handles ONE mesh + ONE
 * material per cap. The gables use their own tiny fan; the wall band goes
 * through the same `buildNotchedShape` + earcut path the interior barrel uses.
 */
function capGeometryWithDoors(
  profile: OctagonProfile,
  b: number,
  doorCuts: DoorOpening[],
): THREE.BufferGeometry {
  if (doorCuts.length === 0) return capGeometry(profile, b);
  const { narrowAxis, narrowHalf, wallHeight, ridgeHalf, ridgeY, basementHalf, basementDepth } = profile;

  const positions: number[] = [];
  const push = (a: number, y: number) => {
    const w = sectionToWorld(narrowAxis, a, y, b);
    positions.push(w.x, w.y, w.z);
  };
  // triangle-fan a convex polygon (its own 3 CCW vertex points; called with
  // 3 or 4 vertices — the gables are triangles / trapezoids).
  const pushFan = (pts: Array<{ a: number; y: number }>): void => {
    for (let i = 1; i < pts.length - 1; i++) {
      push(pts[0].a, pts[0].y);
      push(pts[i].a, pts[i].y);
      push(pts[i + 1].a, pts[i + 1].y);
    }
  };

  // 1) Wall band with door notches — triangulate via ShapeGeometry, then copy
  //    its (a=u, y=v) → world positions into our merged buffer.
  const band = capWallBandGeometry(narrowAxis, b, -narrowHalf, narrowHalf, wallHeight, doorCuts);
  const bandPos = band.attributes.position;
  for (let i = 0; i < bandPos.count * 3; i++) positions.push((bandPos.array as ArrayLike<number>)[i]);
  band.dispose();

  // 2) Roof gable (trapezoid, CCW in (a, y)).
  pushFan([
    { a: -narrowHalf, y: wallHeight },
    { a: -ridgeHalf, y: ridgeY },
    { a: ridgeHalf, y: ridgeY },
    { a: narrowHalf, y: wallHeight },
  ]);
  // 3) Basement gable (trapezoid, CCW in (a, y)).
  pushFan([
    { a: -narrowHalf, y: 0 },
    { a: narrowHalf, y: 0 },
    { a: basementHalf, y: -basementDepth },
    { a: -basementHalf, y: -basementDepth },
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  return geo;
}

// ── 🚪 #92: DOOR CUT geometry — pure helpers ────────────────────────────────
//
// The strip-local `across` parametrisation is the fiddly part called out on
// #92 (get it wrong and the outline self-intersects, breaking earcut). It
// lives here as a plain data function `notchedRectOutline` — takes numbers,
// returns numbers, no THREE dependency — so the vitest suite in
// `octagonHull.test.ts` can pin it down without a renderer.

/** Inset keeping a door cut off the strip ends (the same discipline as
 *  WINDOW_INSET — the outline must be a simple polygon or earcut fails).
 *  Exported so the vitest suite can assert the clamp policy in numbers rather
 *  than depending on a private literal. */
export const DOOR_HULL_INSET = 0.05;

/** Small epsilon for coordinate deduplication when building the outline
 *  (values closer than this collapse — see notchedRectOutline). */
const OUTLINE_EPS = 1e-6;

/**
 * 🚪 #92: THE outline for a rectangle [alongMin, alongMax] × [0, edgeMax] with
 * a set of door NOTCHES poking upward from the bottom edge — each notch
 * `[along − w/2, along + w/2] × [0, h]`. CCW winding, matches the plain
 * quad's when `doors` is empty (bottom-left → bottom-right → top-right →
 * top-left). Pure, no THREE dependency.
 *
 * The routine sorts doors along-ascending and MERGES touching / overlapping
 * intervals so the outline stays a simple polygon (the editor prevents
 * overlap via `MIN_DOOR_GAP` = 4.0 m, but a room resize could bring doors
 * closer, and merging is the geometrically-correct thing to do either way).
 * A door that fully clears the wall bounds is dropped; a door that pokes past
 * one end is clipped to the wall. A door whose merged notch reaches an end of
 * the wall replaces that corner rather than emitting a zero-length edge (the
 * kind of degenerate that turns triangulation into a garbled mesh).
 */
export function notchedRectOutline(
  alongMin: number,
  alongMax: number,
  edgeMax: number,
  doors: readonly DoorOpening[],
): Array<{ along: number; across: number }> {
  const empty: Array<{ along: number; across: number }> = [
    { along: alongMin, across: 0 },
    { along: alongMax, across: 0 },
    { along: alongMax, across: edgeMax },
    { along: alongMin, across: edgeMax },
  ];
  if (doors.length === 0) return empty;

  // Sort + clip + merge door intervals along the bottom edge.
  const kept = doors
    .filter(d => d.w > 0 && d.h > 0 && d.h <= edgeMax)
    .map(d => ({
      a: Math.max(alongMin, d.along - d.w / 2),
      b: Math.min(alongMax, d.along + d.w / 2),
      h: Math.min(d.h, edgeMax),
    }))
    .filter(iv => iv.b - iv.a > OUTLINE_EPS)
    .sort((p, q) => p.a - q.a);
  const merged: Array<{ a: number; b: number; h: number }> = [];
  for (const iv of kept) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last && iv.a <= last.b + OUTLINE_EPS) {
      last.b = Math.max(last.b, iv.b);
      last.h = Math.max(last.h, iv.h);
    } else {
      merged.push({ ...iv });
    }
  }
  if (merged.length === 0) return empty;

  // Trace the outline CCW. Push `(along, across)` points, deduplicating BOTH
  // adjacent-in-sequence identical points (via `pushPoint`) AND the cyclic
  // wraparound at the end. A notch whose left interval `iv.a` sits AT
  // `alongMin` REPLACES the bottom-left corner (skip the initial `(alongMin, 0)`
  // AND the notch's own `(iv.a, 0)` — else earcut sees a zero-length edge and
  // an outline with a redundant vertex, which is safe for earcut in most cases
  // but throws off point-count assertions and can flip winding on adversarial
  // corner cases). Same discipline on the right (`iv.b === alongMax`).
  const out: Array<{ along: number; across: number }> = [];
  const pushPoint = (along: number, across: number) => {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (
      last &&
      Math.abs(last.along - along) < OUTLINE_EPS &&
      Math.abs(last.across - across) < OUTLINE_EPS
    ) return;
    out.push({ along, across });
  };
  const firstTouchesLeft = Math.abs(merged[0].a - alongMin) < OUTLINE_EPS;
  const lastTouchesRight = Math.abs(merged[merged.length - 1].b - alongMax) < OUTLINE_EPS;

  if (!firstTouchesLeft) pushPoint(alongMin, 0);
  for (let i = 0; i < merged.length; i++) {
    const iv = merged[i];
    const skipLeftBottom = i === 0 && firstTouchesLeft;
    const skipRightBottom = i === merged.length - 1 && lastTouchesRight;
    if (!skipLeftBottom) pushPoint(iv.a, 0);
    pushPoint(iv.a, iv.h);
    pushPoint(iv.b, iv.h);
    if (!skipRightBottom) pushPoint(iv.b, 0);
  }
  if (!lastTouchesRight) pushPoint(alongMax, 0);
  pushPoint(alongMax, edgeMax);
  pushPoint(alongMin, edgeMax);
  // Cyclic dedup: if the trace closed onto its starting vertex (a
  // corner-touching notch on the left produces a top-left `(alongMin, edgeMax)`
  // that also opened the trace), drop the trailing copy so earcut sees a
  // simple polygon with no zero-length closing edge.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.along - last.along) < OUTLINE_EPS &&
      Math.abs(first.across - last.across) < OUTLINE_EPS
    ) {
      out.pop();
    }
  }
  return out;
}

/**
 * 🚪 #92: clamp one door cut to fit within a wall face's bounds — same shape
 * of contract as `clampOpening` but for door NOTCHES: the cut must survive
 * the inset on both `along` ends (`along ± w/2` stays inside
 * `[alongMin+inset, alongMax−inset]`) and must not overflow the wall's
 * `across` range (`h ≤ edgeMax−inset`). A cut that cannot fit returns null
 * (dropped, exactly like an oversized window). The floor edge itself is NOT
 * inset — the whole point is to sit flush on the floor.
 */
function clampDoorCut(
  alongMin: number,
  alongMax: number,
  edgeMax: number,
  o: DoorOpening,
): DoorOpening | null {
  if (o.w <= 0 || o.h <= 0) return null;
  const alongSpan = alongMax - alongMin;
  if (o.w > alongSpan - 2 * DOOR_HULL_INSET) return null;
  if (o.h > edgeMax - DOOR_HULL_INSET) return null;
  const lo = alongMin + o.w / 2 + DOOR_HULL_INSET;
  const hi = alongMax - o.w / 2 - DOOR_HULL_INSET;
  const along = Math.max(lo, Math.min(hi, o.along));
  return { along, w: o.w, h: o.h };
}

/** 🚪 #92: map + clamp one wall's raw door cuts to the ones that actually fit.
 *  Exported so `hullDoorCuts.test.ts` can pin the drop-oversized + clamp-along
 *  policy without spinning up a THREE scene. */
export function clampedDoorCuts(
  raw: DoorOpening[] | undefined,
  alongMin: number,
  alongMax: number,
  edgeMax: number,
): DoorOpening[] {
  const out: DoorOpening[] = [];
  if (raw) {
    for (const o of raw) {
      const c = clampDoorCut(alongMin, alongMax, edgeMax, o);
      if (c) out.push(c);
    }
  }
  return out;
}
