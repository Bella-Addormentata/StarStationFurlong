/**
 * Docking-Adapter Vestibule (PR-A of issue #30)
 *
 * Procedural train-gangway / airlock vestibule that visually bridges the gap
 * between a room wall (at ±6) and the adjacent-room projection (centred 12m
 * out along the door axis). It occupies roughly the 6→9 band outside the
 * given door, centred on the door axis, floor at world y=0.
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
