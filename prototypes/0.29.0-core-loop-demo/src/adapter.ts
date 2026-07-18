/**
 * Docking-Adapter Vestibule (PR-A of issue #30)
 *
 * Procedural train-gangway / airlock vestibule that visually bridges the gap
 * between a room wall (at ±6) and the adjacent-room projection (centred
 * 15.2m out along the door axis, near face ≈9.3 — #51). It occupies roughly
 * the 6→9 band outside the given door, centred on the door axis, floor at
 * world y=0.
 *
 * Visual language: concertina/accordion ring frames (boxes, matching the
 * pixel-art aesthetic), dark flexible-fabric walls between the rings, a floor
 * plate with two thin emissive guide strips (the threshold-plate look from
 * PR #29), simple handrails on both sides, and a heavier portal frame at each
 * end. Interior is sized to clear the LARGE door opening (2.4w × 3.0h) with
 * margin: ~3.0w × 3.2h × 3.0 deep.
 *
 * Purely cosmetic in this slice — no gameplay, no network, no docking wiring.
 * Self-contained: imports THREE only (no world/docking/player imports).
 */

import * as THREE from 'three';

export type VestibuleDoorId = 'north' | 'south' | 'east' | 'west';
export type VestibuleLightState = 'idle' | 'cycling' | 'fault';

// ── Palette (matches the lobby's gunmetal / dark-fabric / cyan / amber read)
const COL_FRAME = 0x2A3444;  // gunmetal ring + portal frames
const COL_FABRIC = 0x1C2630; // dark concertina fabric panels
const COL_ACCENT = 0xD4A84B; // amber accents (keypad-gold, see docking.ts)
const COL_FLOOR = 0x222B38;  // deck plate

const LIGHT_STATE_COLORS: Record<VestibuleLightState, number> = {
  idle: 0x00E5FF,    // cyan — sealed and ready
  cycling: 0xFFB300, // amber — airlock cycling / transit in progress
  fault: 0xFF1744,   // red — seal fault
};

// ── Dimensions. Interior clears the LARGE door opening (2.4w × 3.0h) with
//    a little clearance. Depth spans the 6→9 band outside the wall.
const INNER_W = 3.0;
const INNER_H = 3.2;
const DEPTH = 3.0;

/**
 * Build the vestibule for the given door. The group is positioned/rotated so
 * it extends OUTWARD from the door wall along the door axis, floor at y=0.
 * Locally it is built along +Z: z=0 is the wall face, z=DEPTH the outer end.
 */
export function buildVestibule(doorId: VestibuleDoorId): THREE.Group {
  const group = new THREE.Group();
  group.name = 'dockingVestibule';
  group.userData = { doorId, isVestibule: true, lightState: 'idle' };

  // Shared structural materials (glow strips get individual materials below)
  const frameMat = new THREE.MeshStandardMaterial({ color: COL_FRAME, roughness: 0.6, metalness: 0.5 });
  const fabricMat = new THREE.MeshStandardMaterial({ color: COL_FABRIC, roughness: 0.95, metalness: 0.05 });
  const floorMat = new THREE.MeshStandardMaterial({ color: COL_FLOOR, roughness: 0.8, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: COL_ACCENT, roughness: 0.4, metalness: 0.5 });

  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, name?: string) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    if (name) mesh.name = name;
    group.add(mesh);
    return mesh;
  };

  /** Rectangular ring frame at depth z: two posts, a lintel, and a low floor rib. */
  const addRing = (outerW: number, outerH: number, bar: number, ringDepth: number, z: number) => {
    const postX = (outerW - bar) / 2;
    box(bar, outerH, ringDepth, frameMat, -postX, outerH / 2, z);           // left post
    box(bar, outerH, ringDepth, frameMat, postX, outerH / 2, z);            // right post
    box(outerW, bar, ringDepth, frameMat, 0, outerH - bar / 2, z);          // lintel
    box(outerW, 0.12, ringDepth, frameMat, 0, 0.06, z);                     // floor rib (sill)
  };

  // ── Concertina rings: 5 frames, alternating slightly larger/smaller for
  //    the accordion-pleat read.
  const ringZs = [0.55, 1.05, 1.5, 1.95, 2.45];
  ringZs.forEach((z, i) => {
    const big = i % 2 === 0;
    addRing(big ? 3.45 : 3.25, big ? 3.65 : 3.45, 0.18, 0.22, z);
  });

  // ── Dark flexible-fabric walls between the rings (continuous inner tube,
  //    inset inside the ring frames)
  const fabricD = DEPTH - 0.5;
  box(0.06, INNER_H, fabricD, fabricMat, -(INNER_W / 2 + 0.03), INNER_H / 2, DEPTH / 2); // left wall
  box(0.06, INNER_H, fabricD, fabricMat, INNER_W / 2 + 0.03, INNER_H / 2, DEPTH / 2);    // right wall
  box(INNER_W + 0.12, 0.06, fabricD, fabricMat, 0, INNER_H + 0.03, DEPTH / 2);           // ceiling

  // ── Floor plate (deck), top surface at y=0.08
  box(INNER_W, 0.08, DEPTH, floorMat, 0, 0.04, DEPTH / 2);

  // ── Two emissive guide strips on the deck (threshold-plate look: thin
  //    MeshBasicMaterial strips). Named 'vestibuleGlow' for light-state tints.
  for (const side of [-1, 1]) {
    const glowMat = new THREE.MeshBasicMaterial({ color: LIGHT_STATE_COLORS.idle });
    box(0.12, 0.025, DEPTH - 0.2, glowMat, side * 0.55, 0.095, DEPTH / 2, 'vestibuleGlow');
  }

  // ── Handrails on both sides: one rail + three posts each, amber end caps
  for (const side of [-1, 1]) {
    const railX = side * (INNER_W / 2 - 0.12);
    box(0.07, 0.07, DEPTH - 0.5, frameMat, railX, 1.05, DEPTH / 2);         // rail
    for (const pz of [0.5, 1.5, 2.5]) {
      box(0.06, 1.02, 0.06, frameMat, railX, 0.51, pz);                     // posts
    }
    box(0.09, 0.09, 0.09, accentMat, railX, 1.05, 0.28);                    // end caps
    box(0.09, 0.09, 0.09, accentMat, railX, 1.05, DEPTH - 0.28);
  }

  // ── Portal frame at each end (heavier than the rings), with an amber
  //    accent block at each top corner and a status strip above the opening
  //    (also named 'vestibuleGlow' so it follows the airlock light state).
  for (const z of [0.12, DEPTH - 0.12]) {
    const pw = 3.6;
    const ph = 3.8;
    const bar = 0.28;
    const postX = (pw - bar) / 2;
    box(bar, ph, 0.24, frameMat, -postX, ph / 2, z);                        // left post
    box(bar, ph, 0.24, frameMat, postX, ph / 2, z);                         // right post
    box(pw, bar, 0.24, frameMat, 0, ph - bar / 2, z);                       // lintel
    box(pw, 0.14, 0.24, frameMat, 0, 0.07, z);                              // threshold sill
    box(0.2, 0.2, 0.26, accentMat, -postX, ph - 0.32, z);                   // amber corners
    box(0.2, 0.2, 0.26, accentMat, postX, ph - 0.32, z);
    const statusMat = new THREE.MeshBasicMaterial({ color: LIGHT_STATE_COLORS.idle });
    box(1.2, 0.08, 0.28, statusMat, 0, INNER_H + 0.22, z, 'vestibuleGlow'); // status strip
  }

  // ── Orient + position per door. Door walls sit at ±6; local +Z maps to the
  //    outward door axis, so the vestibule spans the ~6→9 band. Floor at y=0.
  //    #66 S1: a slid door carries its vestibule anchor along the wall.
  {
    const p = slidDoorPos(doorId);
    group.position.set(p.x, 0, p.z);
    switch (doorId) {
      case 'north': group.rotation.y = Math.PI; break;
      case 'south': group.rotation.y = 0; break;
      case 'east': group.rotation.y = Math.PI / 2; break;
      case 'west': group.rotation.y = -Math.PI / 2; break;
    }
  }

  return group;
}

// ═══════════════════════════════════════════════════════════════════════════
// #62 P1 — PARAMETERIZED CONNECTOR PARTS (angled-vestibules-octagon-plan.md §5)
//
// Two buildable parts plus a chain builder:
//  - FLEX JOINT: corrugated bellows on a constant-curvature arc — 7 rings
//    (denser than the vestibule's 5 → reads as bellows), per-gap fabric so the
//    tube can bend (a single long fabric box cannot), bend ±60° snap 7.5°,
//    stretch −0.30..+0.45 on a 2.4 m rest length.
//  - EXTENSION: straight tube, `bays × 0.6 m` (2..12), ribbed skin (vestibule
//    look) or solid skin (the concept art's rigid mid-tube: hull walls, groove
//    seams, collar rings with amber bands).
//  - buildConnectorChain: folds a 2D transform cursor (XZ plane, yaw about +Y)
//    from the door face through the ordered segments, placing each part at the
//    cursor pose; heavy portal frames cap the chain's two DOOR terminations.
//    The same fold is exported as pure math (foldChainEnd) so P3 can pose the
//    far room's projection at the chain's exit without building meshes.
//
// Everything is named/nested so setVestibuleLightState / setVestibuleOpacity
// traverse chains unchanged ('vestibuleGlow' strips throughout), and the
// legacy buildVestibule above stays byte-identical for v0.30.x pairings.
// ═══════════════════════════════════════════════════════════════════════════

/** One ordered piece of a door connection (the P2 wire mirrors this shape). */
export interface ConnectorSegment {
  kind: 'flex' | 'ext';
  /** flex only: bend in degrees, clamped ±FLEX_BEND_MAX_DEG, snapped. */
  bendDeg?: number;
  /** flex only: length delta on FLEX_REST_LEN, clamped to the stretch range. */
  stretch?: number;
  /** ext only: length in bays of EXT_BAY_LEN, clamped 2..12. */
  bays?: number;
  /** ext only: skin style (default 'ribbed'). */
  skin?: 'ribbed' | 'solid';
}

// ── Parts catalog (plan §5.1/§5.2 — the clamp source of truth for P2's guards)
export const FLEX_REST_LEN = 2.4;
export const FLEX_STRETCH_MIN = -0.3;
export const FLEX_STRETCH_MAX = 0.45;
export const FLEX_BEND_MAX_DEG = 60;
export const FLEX_BEND_SNAP_DEG = 7.5;
export const EXT_BAY_LEN = 0.6;
export const EXT_BAYS_MIN = 2;
export const EXT_BAYS_MAX = 12;

export function clampFlexBend(deg: number): number {
  const snapped = Math.round(deg / FLEX_BEND_SNAP_DEG) * FLEX_BEND_SNAP_DEG;
  return Math.max(-FLEX_BEND_MAX_DEG, Math.min(FLEX_BEND_MAX_DEG, snapped));
}
export function clampFlexStretch(s: number): number {
  return Math.max(FLEX_STRETCH_MIN, Math.min(FLEX_STRETCH_MAX, s));
}
export function clampExtBays(b: number): number {
  return Math.max(EXT_BAYS_MIN, Math.min(EXT_BAYS_MAX, Math.round(b)));
}

/** Groove seam color for the solid extension skin (door-leaf groove trick). */
const COL_GROOVE = 0x1C262E;

/** Shared material set for one part build (mirrors buildVestibule's). */
function partMats() {
  return {
    frame: new THREE.MeshStandardMaterial({ color: COL_FRAME, roughness: 0.6, metalness: 0.5 }),
    fabric: new THREE.MeshStandardMaterial({ color: COL_FABRIC, roughness: 0.95, metalness: 0.05 }),
    floor: new THREE.MeshStandardMaterial({ color: COL_FLOOR, roughness: 0.8, metalness: 0.35 }),
    accent: new THREE.MeshStandardMaterial({ color: COL_ACCENT, roughness: 0.4, metalness: 0.5 }),
    groove: new THREE.MeshStandardMaterial({ color: COL_GROOVE, roughness: 0.9, metalness: 0.1 }),
  };
}
type PartMats = ReturnType<typeof partMats>;

function boxInto(
  parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material,
  x: number, y: number, z: number, name?: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

/** Rectangular ring frame as its own posable sub-group (entry-plane centred). */
function ringGroup(mats: PartMats, outerW: number, outerH: number, bar: number, ringDepth: number): THREE.Group {
  const g = new THREE.Group();
  const postX = (outerW - bar) / 2;
  boxInto(g, bar, outerH, ringDepth, mats.frame, -postX, outerH / 2, 0);
  boxInto(g, bar, outerH, ringDepth, mats.frame, postX, outerH / 2, 0);
  boxInto(g, outerW, bar, ringDepth, mats.frame, 0, outerH - bar / 2, 0);
  boxInto(g, outerW, 0.12, ringDepth, mats.frame, 0, 0.06, 0);
  return g;
}

/** Heavy door-termination portal (the buildVestibule end-frame recipe) as a
 *  posable sub-group, status strip included. */
function portalGroup(mats: PartMats): THREE.Group {
  const g = new THREE.Group();
  const pw = 3.6, ph = 3.8, bar = 0.28;
  const postX = (pw - bar) / 2;
  boxInto(g, bar, ph, 0.24, mats.frame, -postX, ph / 2, 0);
  boxInto(g, bar, ph, 0.24, mats.frame, postX, ph / 2, 0);
  boxInto(g, pw, bar, 0.24, mats.frame, 0, ph - bar / 2, 0);
  boxInto(g, pw, 0.14, 0.24, mats.frame, 0, 0.07, 0);
  boxInto(g, 0.2, 0.2, 0.26, mats.accent, -postX, ph - 0.32, 0);
  boxInto(g, 0.2, 0.2, 0.26, mats.accent, postX, ph - 0.32, 0);
  const statusMat = new THREE.MeshBasicMaterial({ color: LIGHT_STATE_COLORS.idle });
  boxInto(g, 1.2, 0.08, 0.28, statusMat, 0, INNER_H + 0.22, 0, 'vestibuleGlow');
  return g;
}

/** Pose on the flex joint's constant-curvature arc at parameter t ∈ [0,1]
 *  (local frame: entry at origin facing +Z; +bend curves toward +X). */
function flexArcFrame(bendRad: number, length: number, t: number): { x: number; z: number; yaw: number } {
  if (Math.abs(bendRad) < 1e-4) return { x: 0, z: length * t, yaw: 0 };
  const r = length / bendRad;
  return { x: (1 - Math.cos(bendRad * t)) * r, z: Math.sin(bendRad * t) * r, yaw: bendRad * t };
}

/**
 * FLEX JOINT — corrugated bellows with a parameterized bend (plan §5.1).
 * Local frame: entry portal plane at z=0 facing +Z, floor at y=0. No handrails
 * (pure corrugation, per the art); terminating portals are the CHAIN's job.
 */
export function buildFlexJoint(bendDeg: number, stretch = 0): THREE.Group {
  const group = new THREE.Group();
  const bend = clampFlexBend(bendDeg);
  const len = FLEX_REST_LEN + clampFlexStretch(stretch);
  group.name = 'connectorFlex';
  group.userData = { isConnectorPart: true, kind: 'flex', bendDeg: bend, stretch: clampFlexStretch(stretch) };
  const mats = partMats();
  const th = THREE.MathUtils.degToRad(bend);

  const N = 7; // rings (6 gaps → ≤10°/gap at full bend; 0.08 overlap covers the pleat shear)
  const frames = Array.from({ length: N }, (_, k) => flexArcFrame(th, len, k / (N - 1)));

  // Rings, alternating heavy/light for the accordion-pleat read.
  frames.forEach((f, i) => {
    const big = i % 2 === 0;
    const ring = ringGroup(mats, big ? 3.45 : 3.25, big ? 3.65 : 3.45, 0.18, 0.22);
    ring.position.set(f.x, 0, f.z);
    ring.rotation.y = f.yaw;
    group.add(ring);
  });

  // Per-gap skin: fabric walls + ceiling + floor plate + glow strips, each gap
  // posed at its midpoint with the mean yaw; depth spans the ring distance
  // plus 0.16 overlap so the pleats never show daylight at full bend.
  for (let i = 0; i < N - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    const gap = new THREE.Group();
    gap.position.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    gap.rotation.y = (a.yaw + b.yaw) / 2;
    const d = Math.hypot(b.x - a.x, b.z - a.z) + 0.16;
    boxInto(gap, 0.06, INNER_H, d, mats.fabric, -(INNER_W / 2 + 0.03), INNER_H / 2, 0);
    boxInto(gap, 0.06, INNER_H, d, mats.fabric, INNER_W / 2 + 0.03, INNER_H / 2, 0);
    boxInto(gap, INNER_W + 0.12, 0.06, d, mats.fabric, 0, INNER_H + 0.03, 0);
    boxInto(gap, INNER_W, 0.08, d, mats.floor, 0, 0.04, 0);
    for (const side of [-1, 1]) {
      const glowMat = new THREE.MeshBasicMaterial({ color: LIGHT_STATE_COLORS.idle });
      boxInto(gap, 0.12, 0.025, d - 0.06, glowMat, side * 0.55, 0.095, 0, 'vestibuleGlow');
    }
    group.add(gap);
  }

  // Exit pose for the chain cursor (P3 reads the same numbers via foldChainEnd).
  const end = frames[N - 1];
  group.userData.exit = { x: end.x, z: end.z, yawRad: end.yaw };
  return group;
}

/**
 * EXTENSION — straight tube of `bays × 0.6 m` (plan §5.2). Local frame: entry
 * at z=0 facing +Z. 'ribbed' = ring-per-bay + fabric (the vestibule look,
 * elongated); 'solid' = the art's rigid mid-tube (hull walls, groove seams
 * every 1.2 m, collar ring + amber band every 2.4 m).
 */
export function buildExtension(bays: number, skin: 'ribbed' | 'solid' = 'ribbed'): THREE.Group {
  const group = new THREE.Group();
  const nBays = clampExtBays(bays);
  const len = nBays * EXT_BAY_LEN;
  group.name = 'connectorExtension';
  group.userData = { isConnectorPart: true, kind: 'ext', bays: nBays, skin };
  const mats = partMats();

  if (skin === 'ribbed') {
    // Ring frame at every bay boundary, continuous inner fabric tube between.
    for (let k = 0; k <= nBays; k++) {
      const big = k % 2 === 0;
      const ring = ringGroup(mats, big ? 3.45 : 3.25, big ? 3.65 : 3.45, 0.18, 0.22);
      ring.position.set(0, 0, k * EXT_BAY_LEN);
      group.add(ring);
    }
    const fabricD = len - 0.2;
    boxInto(group, 0.06, INNER_H, fabricD, mats.fabric, -(INNER_W / 2 + 0.03), INNER_H / 2, len / 2);
    boxInto(group, 0.06, INNER_H, fabricD, mats.fabric, INNER_W / 2 + 0.03, INNER_H / 2, len / 2);
    boxInto(group, INNER_W + 0.12, 0.06, fabricD, mats.fabric, 0, INNER_H + 0.03, len / 2);
  } else {
    // Solid hull: full-length walls + ceiling in frame gunmetal.
    boxInto(group, 0.14, INNER_H, len, mats.frame, -(INNER_W / 2 + 0.07), INNER_H / 2, len / 2);
    boxInto(group, 0.14, INNER_H, len, mats.frame, INNER_W / 2 + 0.07, INNER_H / 2, len / 2);
    boxInto(group, INNER_W + 0.28, 0.12, len, mats.frame, 0, INNER_H + 0.06, len / 2);
    // Recessed groove seams every 1.2 m (panel-line read).
    for (let z = 1.2; z < len - 0.05; z += 1.2) {
      for (const side of [-1, 1]) {
        boxInto(group, 0.02, INNER_H - 0.3, 0.1, mats.groove, side * (INNER_W / 2 + 0.15), INNER_H / 2, z);
      }
    }
    // Heavier collar ring + amber accent band every 2.4 m.
    for (let z = 0; z <= len + 0.01; z += 2.4) {
      const collar = ringGroup(mats, 3.55, 3.75, 0.22, 0.26);
      collar.position.set(0, 0, Math.min(z, len));
      group.add(collar);
      boxInto(group, 3.56, 0.1, 0.1, mats.accent, 0, INNER_H + 0.34, Math.min(z, len));
    }
  }

  // Full-length floor plate + guide glow strips (both skins).
  boxInto(group, INNER_W, 0.08, len, mats.floor, 0, 0.04, len / 2);
  for (const side of [-1, 1]) {
    const glowMat = new THREE.MeshBasicMaterial({ color: LIGHT_STATE_COLORS.idle });
    boxInto(group, 0.12, 0.025, len - 0.2, glowMat, side * 0.55, 0.095, len / 2, 'vestibuleGlow');
  }

  group.userData.exit = { x: 0, z: len, yawRad: 0 };
  return group;
}

/** Exit pose of one segment in ITS OWN local frame (pure math — no meshes). */
function segmentExit(seg: ConnectorSegment): { x: number; z: number; yawRad: number } {
  if (seg.kind === 'flex') {
    const th = THREE.MathUtils.degToRad(clampFlexBend(seg.bendDeg ?? 0));
    const len = FLEX_REST_LEN + clampFlexStretch(seg.stretch ?? 0);
    const f = flexArcFrame(th, len, 1);
    return { x: f.x, z: f.z, yawRad: f.yaw };
  }
  return { x: 0, z: clampExtBays(seg.bays ?? EXT_BAYS_MIN) * EXT_BAY_LEN, yawRad: 0 };
}

/**
 * Fold the transform cursor through a segment chain (pure math): returns the
 * chain's EXIT pose in the chain-local frame (entry at origin facing +Z).
 * P3 poses the far room's projection with exactly this. Includes the two
 * portal margins so meshes and math agree.
 */
export function foldChainEnd(segments: ConnectorSegment[]): { x: number; z: number; yawRad: number } {
  let x = 0, z = CHAIN_PORTAL_MARGIN, yaw = 0;
  for (const seg of segments) {
    const e = segmentExit(seg);
    // Rotate the segment's local exit offset by the accumulated yaw.
    x += e.x * Math.cos(yaw) + e.z * Math.sin(yaw);
    z += -e.x * Math.sin(yaw) + e.z * Math.cos(yaw);
    yaw += e.yawRad;
  }
  // Exit portal margin along the final heading.
  x += CHAIN_PORTAL_MARGIN * Math.sin(yaw);
  z += CHAIN_PORTAL_MARGIN * Math.cos(yaw);
  return { x, z, yawRad: yaw };
}

/** Gap between the door face / chain end and the heavy portal planes. */
export const CHAIN_PORTAL_MARGIN = 0.3;

// ── #62 P3: far-room projection pose ─────────────────────────────────────────

/** Room half-width (11.8 / 2) — the projection box's centre sits this far past
 *  the chain exit along the arrival heading (+ the exit-portal margin). */
const ROOM_HALF = 5.9;
/** Legacy fixed projection offset (room centre → adjoining module centre). */
const LEGACY_PROJECTION_OFFSET = 15.2;

/** Outward-normal yaw of each door in ROOM-LOCAL frame (matches the
 *  buildVestibule placement switch: south faces +Z = yaw 0). */
const DOOR_YAW: Record<VestibuleDoorId, number> = {
  south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2,
};
const DOOR_POS: Record<VestibuleDoorId, { x: number; z: number }> = {
  south: { x: 0, z: 6 }, east: { x: 6, z: 0 }, north: { x: 0, z: -6 }, west: { x: -6, z: 0 },
};

// ── 🧱 #66 S1: door-slide deltas (lateral along each door's wall) ────────────
// world.reconcileDoorPlacements pushes these; every anchor in this module
// (vestibule placement, projection poses) adds its door's delta on the wall's
// lateral axis. 0 everywhere ⇒ bit-identical legacy math. Paired doors can't
// slide (plan §6.2), so live chains never re-solve — the deltas matter for
// FUTURE pairings and the unpaired-door peek.
let slideDeltas: Record<VestibuleDoorId, number> = { north: 0, south: 0, east: 0, west: 0 };

export function setDoorSlideDeltas(d: Record<VestibuleDoorId, number>): void {
  slideDeltas = { ...d };
}

/** A door's anchor point WITH its slide applied (n/s slide in x, e/w in z). */
function slidDoorPos(doorId: VestibuleDoorId): { x: number; z: number } {
  const base = DOOR_POS[doorId];
  const d = slideDeltas[doorId] ?? 0;
  return doorId === 'north' || doorId === 'south'
    ? { x: base.x + d, z: base.z }
    : { x: base.x, z: base.z + d };
}

/**
 * Where (and at what rotation) the FAR room's gray-box projection sits for a
 * door connection — pure math, room-local coordinates (P3 replaces the
 * hardcoded cardinal 15.2 offset with this; S-slices reuse it for map views).
 *
 * With `segments`: fold the chain from the door face, place the box centre
 * ROOM_HALF past the exit along the final heading; the box's rotation comes
 * from `farDoor` (the far room is oriented so that door faces BACK along the
 * arrival heading) or defaults to the heading itself. Without segments: the
 * legacy fixed cardinal pose, bit-identical to the pre-#62 behavior.
 */
export function projectionPoseForDoor(
  doorId: VestibuleDoorId,
  segments?: ConnectorSegment[],
  farDoor?: VestibuleDoorId,
): { x: number; z: number; rotY: number } {
  const dYaw = DOOR_YAW[doorId];
  const dPos = slidDoorPos(doorId);
  const base = DOOR_POS[doorId];
  if (!segments || segments.length === 0) {
    // Legacy: centre 15.2 out along the cardinal axis; a slid door carries
    // its projection sideways with it (lateral = the door's slide delta).
    const northSouth = doorId === 'north' || doorId === 'south';
    return {
      x: northSouth ? dPos.x : Math.sign(base.x) * LEGACY_PROJECTION_OFFSET,
      z: northSouth ? Math.sign(base.z) * LEGACY_PROJECTION_OFFSET : dPos.z,
      rotY: 0,
    };
  }
  const exit = foldChainEnd(segments);
  // Chain-local exit → room frame (rotate by the door's outward yaw).
  const xr = dPos.x + exit.x * Math.cos(dYaw) + exit.z * Math.sin(dYaw);
  const zr = dPos.z - exit.x * Math.sin(dYaw) + exit.z * Math.cos(dYaw);
  const heading = dYaw + exit.yawRad; // world heading at the chain exit
  const x = xr + Math.sin(heading) * ROOM_HALF;
  const z = zr + Math.cos(heading) * ROOM_HALF;
  // Far room rotation: its `farDoor` faces BACK along the arrival heading.
  const rotY = farDoor !== undefined
    ? heading + Math.PI - DOOR_YAW[farDoor]
    : heading;
  return { x, z, rotY };
}

/**
 * Build a full connector chain outward from `doorId` (plan §5/P1): heavy
 * portal at the door face, each segment posed at the folded cursor, heavy
 * portal at the exit. Same outer positioning contract as buildVestibule
 * (group at the ±6 wall, local +Z = outward door axis), and the group answers
 * to setVestibuleLightState / setVestibuleOpacity unchanged.
 */
export function buildConnectorChain(doorId: VestibuleDoorId, segments: ConnectorSegment[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'dockingVestibule'; // world.ts treats chains exactly like vestibules
  group.userData = { doorId, isVestibule: true, isConnectorChain: true, lightState: 'idle', segments };
  const mats = partMats();

  // Door-face portal.
  const entry = portalGroup(mats);
  entry.position.set(0, 0, 0.12);
  group.add(entry);

  // Fold the cursor through the segments, adding each part's meshes.
  let x = 0, z = CHAIN_PORTAL_MARGIN, yaw = 0;
  for (const seg of segments) {
    const part = seg.kind === 'flex'
      ? buildFlexJoint(seg.bendDeg ?? 0, seg.stretch ?? 0)
      : buildExtension(seg.bays ?? EXT_BAYS_MIN, seg.skin ?? 'ribbed');
    part.position.set(x, 0, z);
    part.rotation.y = yaw;
    group.add(part);
    const e = part.userData.exit as { x: number; z: number; yawRad: number };
    x += e.x * Math.cos(yaw) + e.z * Math.sin(yaw);
    z += -e.x * Math.sin(yaw) + e.z * Math.cos(yaw);
    yaw += e.yawRad;
  }

  // Exit portal at the folded end, facing the final heading.
  const exit = portalGroup(mats);
  exit.position.set(x + 0.18 * Math.sin(yaw), 0, z + 0.18 * Math.cos(yaw));
  exit.rotation.y = yaw;
  group.add(exit);

  // Same wall-face placement as buildVestibule.
  switch (doorId) {
    case 'north': group.position.set(0, 0, -6); group.rotation.y = Math.PI; break;
    case 'south': group.position.set(0, 0, 6); group.rotation.y = 0; break;
    case 'east': group.position.set(6, 0, 0); group.rotation.y = Math.PI / 2; break;
    case 'west': group.position.set(-6, 0, 0); group.rotation.y = -Math.PI / 2; break;
  }
  return group;
}

/**
 * Tint every mesh named 'vestibuleGlow' (guide strips + portal status strips)
 * to reflect the airlock state: idle cyan, cycling amber, fault red.
 */
export function setVestibuleLightState(group: THREE.Group, state: VestibuleLightState): void {
  const color = LIGHT_STATE_COLORS[state];
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && child.name === 'vestibuleGlow') {
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.color.setHex(color);
    }
  });
  group.userData.lightState = state;
}

/**
 * Fade the whole vestibule to the given opacity (#51 — paired doors keep a
 * persistent vestibule that rests lightly transparent and solidifies as the
 * player approaches). Materials are deduped (structural materials are shared
 * by many meshes within one build; glow strips are individual), and the
 * `transparent` flag is dropped again at full opacity so the solid look
 * renders in the opaque pass (no blend-sorting artifacts).
 *
 * Orthogonal to setVestibuleLightState: this writes only opacity/transparent,
 * the light state writes only color.
 */
export function setVestibuleOpacity(group: THREE.Group, opacity: number): void {
  const transparent = opacity < 0.999;
  const seen = new Set<THREE.Material>();
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      mat.opacity = opacity;
      mat.transparent = transparent;
    }
  });
  group.userData.opacity = opacity;
}
