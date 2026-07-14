/**
 * Furniture registry — the single source of truth for the lobby furniture.
 *
 * Every piece of furniture is a FurnitureItem (id + kind + position + rotation)
 * whose FurnitureDef provides:
 *  - build(ctx)   : meshes/lights RELATIVE TO THE ITEM ORIGIN (one THREE.Group
 *                   per item; World positions/rotates the group)
 *  - footprint    : tile footprint used to derive the collision AABB
 *                   (null ⇒ decorative — rugs, cherry trees — never an obstacle)
 *  - seats        : SeatTemplates used to derive the clickable Seat list
 *
 * From the FURNITURE item list below, three previously hand-maintained (and
 * drifting) data sets are now derived:
 *  - obstacles.ts  OBSTACLES  via buildObstacleList()
 *  - seats.ts      SEATS      via buildSeatList()
 *  - world.ts      visuals    via buildItemGroup()
 *
 * E1 (#25) parity notes — oddities in the original hand-authored data are
 * deliberately PRESERVED, not fixed, via per-item footprintOverride:
 *  - the front-right lamp table's obstacle box is x[4,5] z[4,5] while its
 *    visual sits at (4.5, 3.5) — one tile south of the derived box
 *  - the bar obstacle box x[4,5] z[3,5] covers the stool strip, not the
 *    cabinet body (visual centre x≈5.24)
 *  - cherry blossom trees have no collision at all (footprint: null)
 */

import * as THREE from 'three';
import type { Seat } from './seats';
import type { DeviceTarget, DeviceTemplate, WallComputerStatus, WallScreenHandle, TrunkLidHandle, GameTableTopHandle } from './devices';

// ── Shared XZ-plane AABB type (re-exported by obstacles.ts) ───────────────────
export interface Box { x0: number; z0: number; x1: number; z1: number }

/** Quarter-turns CCW about +y. All E1 items are rot 0 (today's layout). */
export type Rot = 0 | 1 | 2 | 3;

export type FurnitureKind =
  | 'fireplace-wall'
  | 'sofa-back'
  | 'sofa-front'
  | 'armchair-left'
  | 'armchair-right'
  | 'coffee-table-back'
  | 'coffee-table-front'
  | 'bar-corner'
  | 'lamp-table'
  | 'rug-back'
  | 'rug-front'
  | 'cherry-tree'
  | 'blossom-pot'
  | 'wall-computer'
  | 'map-table'
  | 'storage-trunk'
  | 'game-table';

export interface FurnitureItem {
  id: string;
  kind: FurnitureKind;
  pos: { x: number; z: number };
  rot: Rot;
  /** false: fixed room structure (fireplace wall, bar corner) — v1 */
  movable: boolean;
  /**
   * E1 parity escape hatch: when present, this exact box is used as the
   * obstacle instead of the footprint-derived AABB (null ⇒ no obstacle).
   */
  footprintOverride?: Box | null;
}

/**
 * Seat definition local to the item origin (rot 0). World-space Seats are
 * derived by buildSeatList().
 */
export interface SeatTemplate {
  /** Local click box — a floor click inside it selects the seat. */
  clickBox: Box;
  /**
   * PREFERRED front (stand-point) offset. If its grid cell is walkable the
   * exact point is used (this reproduces every current hand-authored front,
   * including the front sofa's side approaches); otherwise the nearest
   * walkable cell centre around the footprint is chosen.
   */
  front: { x: number; z: number };
  /** Local offset where the avatar root rests while seated. */
  sit: { x: number; z: number };
  /** World facing while seated when rot = 0 (atan2(nx, nz) convention). */
  faceAngle: number;
}

/** Build-time helpers bound to the item's group (all coordinates local). */
export interface BuildCtx {
  m: (color: number, rough?: number, metal?: number, em?: number, emI?: number) => THREE.MeshStandardMaterial;
  flat: (color: number) => THREE.MeshBasicMaterial;
  place: (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry?: number) => THREE.Mesh;
  addLight: (light: THREE.PointLight, x: number, y: number, z: number, targetIntensity: number) => void;
  /**
   * Add an arbitrary object (e.g. an animated sub-Group like the trunk lid)
   * to the item group. Meshes inside still ride the morph fade-in / zoom-hide
   * machinery (World traverses the whole group), so give them transparent
   * opacity-0 materials via ctx.m — TR2 of #35.
   */
  attach: (obj: THREE.Object3D) => void;
}

export interface FurnitureDef {
  kind: FurnitureKind;
  /** Adds meshes/lights at the item origin via ctx (see buildItemGroup). */
  build: (ctx: BuildCtx) => void;
  /** Tile footprint (metres). null ⇒ decorative: never an obstacle. */
  footprint: { w: number; d: number } | null;
  seats?: SeatTemplate[];
  /** Capability tags — #30 plan §1.2: capabilities = function-tagged furniture. */
  functions?: string[];
  /**
   * Device-focus template (local frame, rot 0) — items whose def carries one
   * become clickable focus targets via buildDeviceList() (#33 D0).
   */
  device?: DeviceTemplate;
}

// ── Warm frontier colour palette (moved from world.addLobbyFurniture) ─────────
const CREAM  = 0xFAF0E0; // warm linen white (sofa)
const LINEN  = 0xF5E8D2; // warm ivory (cushions)
const BEIGE  = 0xE8D8C4; // warm taupe (armrests)
const WOOD   = 0xC8924E; // honey golden wood
const DKWOOD = 0xF0F0F0; // white (bookshelves / cabinets)
const STONE  = 0xFFFFFF; // pure white (fireplace)
const TERRA  = 0xD87A48; // light terracotta (pots)
const PK1    = 0xFFB7C5; // cherry blossom light pink
const PK2    = 0xFF8FAB; // cherry blossom mid pink
const PK3    = 0xFFD6E0; // cherry blossom pale pink
const RUG_A  = 0xD4905E; // rug warm rust (lighter)
const RUG_B  = 0xBC7848; // rug border

// ── Builders ──────────────────────────────────────────────────────────────────
// Geometry, materials and offsets are verbatim from the original
// world.addLobbyFurniture() (positions rebased to the item origin).

// Small potted cherry blossom — shared by 'blossom-pot' and the bar corner.
const roundPlant = (ctx: BuildCtx, px: number, py: number, pz: number) => {
  ctx.place(new THREE.CylinderGeometry(0.11, 0.08, 0.17, 12), ctx.m(TERRA, 0.85, 0.07), px, py + 0.085, pz);
  ctx.place(new THREE.SphereGeometry(0.16, 10, 10), ctx.m(PK1, 0.88, 0.02), px,        py + 0.27, pz);
  ctx.place(new THREE.SphereGeometry(0.12, 10, 10), ctx.m(PK3, 0.84, 0.02), px + 0.10, py + 0.23, pz + 0.05);
};

// Rug stacks — 3 layers each, slight y stagger avoids z-fighting.
const buildRugBack = ({ m, place }: BuildCtx) => {
  place(new THREE.BoxGeometry(8.0, 0.018, 6.0), m(RUG_A,    0.98, 0.0), 0, 0.009, 0);
  place(new THREE.BoxGeometry(7.6, 0.020, 5.6), m(RUG_B,    0.98, 0.0), 0, 0.011, 0);
  place(new THREE.BoxGeometry(7.2, 0.022, 5.2), m(0xE8A878, 0.98, 0.0), 0, 0.013, 0);
};
const buildRugFront = ({ m, place }: BuildCtx) => {
  place(new THREE.BoxGeometry(6.0, 0.018, 4.0), m(0xD4B090, 0.98, 0.0), 0, 0.009, 0);
  place(new THREE.BoxGeometry(5.6, 0.020, 3.6), m(0xBC9878, 0.98, 0.0), 0, 0.011, 0);
  place(new THREE.BoxGeometry(5.2, 0.022, 3.2), m(0xE0C8A8, 0.98, 0.0), 0, 0.013, 0);
};

// Integrated fireplace + bookcase wall (composite, movable: false).
// Layout: [bookcase SW=2.90] [stone pillar PW=0.52] [opening FW=2.60] [pillar] [bookcase]
const buildFireplaceWall = (ctx: BuildCtx) => {
  const { m, flat, place, addLight } = ctx;
  const FZ   = -0.05;  // front face z, local (item at z=-5.5 → world -5.55)
  const UH   = 2.65;   // body height
  const UD   = 0.46;   // depth
  const FW   = 2.60;   // opening interior width
  const FH   = 1.82;   // opening interior height
  const PW   = 0.52;   // stone pillar width
  const SW   = 2.90;   // bookcase panel width each side
  const BX   = FW / 2 + PW + SW / 2;       // bookcase centre x ≈ 3.27
  const CW   = (BX + SW / 2) * 2 + 0.18;   // cornice full width ≈ 9.62
  const MT   = UH + 0.26;                  // mantle shelf top surface y ≈ 2.91
  const OMH  = UH - FH - 0.28;             // overmantel height ≈ 0.55

  // Continuous base plinth
  place(new THREE.BoxGeometry(CW, 0.13, UD + 0.14), m(0xF5F5F5, 0.82, 0.04), 0, 0.065, FZ);

  // Left & right bookcase bodies
  place(new THREE.BoxGeometry(SW, UH, UD), m(DKWOOD, 0.82, 0.04), -BX, UH / 2, FZ);
  place(new THREE.BoxGeometry(SW, UH, UD), m(DKWOOD, 0.82, 0.04),  BX, UH / 2, FZ);

  // White stone pillars flanking opening
  place(new THREE.BoxGeometry(PW, UH, UD), m(STONE, 0.90, 0.04), -(FW / 2 + PW / 2), UH / 2, FZ);
  place(new THREE.BoxGeometry(PW, UH, UD), m(STONE, 0.90, 0.04),  (FW / 2 + PW / 2), UH / 2, FZ);

  // Hearth floor slab (slight forward projection)
  place(new THREE.BoxGeometry(FW + 0.22, 0.07, UD + 0.14), m(STONE, 0.85, 0.05), 0, 0.035, FZ);

  // Lintel above opening
  place(new THREE.BoxGeometry(FW + PW * 2, 0.28, UD), m(STONE, 0.88, 0.05), 0, FH + 0.14, FZ);

  // Overmantel infill (above lintel up to top)
  place(new THREE.BoxGeometry(FW + PW * 2, OMH, UD), m(STONE, 0.92, 0.03), 0, FH + 0.28 + OMH / 2, FZ);

  // Dark fireback (recessed, fire panels render in front)
  place(new THREE.BoxGeometry(FW - 0.08, FH - 0.04, 0.06), m(0x190D04, 0.96, 0.04), 0, FH / 2, FZ - UD / 2 + 0.03);

  // Fire layers — self-illuminated
  place(new THREE.BoxGeometry(2.06, 1.06, 0.04), flat(0xFF3200), 0, 0.62, FZ - 0.02);
  place(new THREE.BoxGeometry(1.52, 0.90, 0.04), flat(0xFF6600), 0, 0.71, FZ - 0.015);
  place(new THREE.BoxGeometry(0.98, 0.70, 0.04), flat(0xFFAA00), 0, 0.83, FZ - 0.01);
  place(new THREE.BoxGeometry(0.52, 0.48, 0.04), flat(0xFFE030), 0, 0.99, FZ - 0.005);
  place(new THREE.BoxGeometry(0.24, 0.28, 0.04), flat(0xFFFBB0), 0, 1.14, FZ);

  // Logs
  place(new THREE.CylinderGeometry(0.10, 0.10, 2.1, 8), m(0x5A2812, 0.9, 0.04), 0,   0.14, FZ, Math.PI * 0.5);
  place(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 8), m(0x5A2812, 0.9, 0.04), 0.2, 0.22, FZ, Math.PI * 0.5 + 0.3);

  // Top cornice (full span + overhang)
  place(new THREE.BoxGeometry(CW, 0.16, UD + 0.22), m(0xF8F8F8, 0.78, 0.06), 0, UH + 0.08, FZ);

  // Mantle shelf (projects forward slightly)
  place(new THREE.BoxGeometry(CW, 0.10, UD + 0.28), m(WOOD, 0.50, 0.20), 0, UH + 0.21, FZ + 0.04);

  // Bookcase shelf boards — 3 per side
  const shelfW = SW - 0.06;
  ([0.56, 1.20, 1.84] as number[]).forEach(ys => {
    place(new THREE.BoxGeometry(shelfW, 0.04, UD - 0.06), m(0xE8E8E8, 0.72, 0.04), -BX, ys, FZ);
    place(new THREE.BoxGeometry(shelfW, 0.04, UD - 0.06), m(0xE8E8E8, 0.72, 0.04),  BX, ys, FZ);
  });

  // Books on shelves
  const wallBks1: [number, number][] = [[0xD09070,0.13],[0x6888A8,0.11],[0x78A868,0.12],[0xD0B048,0.11],[0x9068A0,0.10],[0xC05050,0.12],[0x5A90B8,0.11],[0xB07848,0.11]];
  const wallBks2: [number, number][] = [[0x70A880,0.12],[0xC08048,0.11],[0x5880B0,0.13],[0xA8B068,0.11],[0xD07868,0.13],[0x8070A0,0.11],[0xC09050,0.12],[0x7090A8,0.10]];
  const wallBks3: [number, number][] = [[0x9870B0,0.11],[0xD08858,0.12],[0x60A890,0.12],[0xB8A048,0.11],[0xA06070,0.13],[0x7888C0,0.12],[0x90B070,0.12]];
  const placeWallBooks = (cx: number, shelfY: number, books: [number, number][], bookH: number) => {
    let bo = cx - SW / 2 + 0.05;
    books.forEach(([c, w]) => {
      place(new THREE.BoxGeometry(w, bookH, 0.26), m(c, 0.80, 0.04), bo + w / 2, shelfY + bookH / 2 + 0.04, FZ + 0.01);
      bo += w + 0.01;
    });
  };
  placeWallBooks(-BX, 0.56, wallBks1, 0.26); placeWallBooks( BX, 0.56, wallBks1, 0.28);
  placeWallBooks(-BX, 1.20, wallBks2, 0.22); placeWallBooks( BX, 1.20, wallBks2, 0.24);
  placeWallBooks(-BX, 1.84, wallBks3, 0.20); placeWallBooks( BX, 1.84, wallBks3, 0.22);

  // Candles on mantle
  place(new THREE.CylinderGeometry(0.050, 0.038, 0.34, 10), m(0xF8E8B0, 0.45, 0.10), -1.35, MT + 0.17, FZ + 0.10);
  place(new THREE.CylinderGeometry(0.050, 0.038, 0.34, 10), m(0xF8E8B0, 0.45, 0.10),  1.35, MT + 0.17, FZ + 0.10);
  place(new THREE.SphereGeometry(0.028, 8, 8), flat(0xFFEE88), -1.35, MT + 0.37, FZ + 0.10);
  place(new THREE.SphereGeometry(0.028, 8, 8), flat(0xFFEE88),  1.35, MT + 0.37, FZ + 0.10);
  // Mantle vase with cherry blossom
  place(new THREE.CylinderGeometry(0.13, 0.09, 0.30, 14), m(0x90B8A8, 0.42, 0.38), 0, MT + 0.15, FZ + 0.10);
  place(new THREE.SphereGeometry(0.09, 10, 10), m(PK1, 0.88, 0.02), 0, MT + 0.39, FZ + 0.08);
  // Fire and candle lights
  addLight(new THREE.PointLight(0xFF7A30, 0, 14),  0,    1.2,       FZ + 1.0, 2.8);
  addLight(new THREE.PointLight(0xFFCC66, 0,  5), -1.35, MT + 0.50, FZ + 0.4, 0.6);
  addLight(new THREE.PointLight(0xFFCC66, 0,  5),  1.35, MT + 0.50, FZ + 0.4, 0.6);
};

// Wall armchair — backDir: -1 backrest toward x=-6 (faces +x), +1 toward x=+6.
const buildArmchair = (backDir: number) => ({ m, place }: BuildCtx) => {
  place(new THREE.BoxGeometry(0.92, 0.24, 0.92), m(CREAM, 0.82, 0.05), 0,              0.22, 0);
  place(new THREE.BoxGeometry(0.22, 0.66, 0.92), m(CREAM, 0.82, 0.05), backDir * 0.46, 0.71, 0);
  place(new THREE.BoxGeometry(0.92, 0.46, 0.22), m(BEIGE, 0.78, 0.06), 0, 0.45, -0.46);
  place(new THREE.BoxGeometry(0.92, 0.46, 0.22), m(BEIGE, 0.78, 0.06), 0, 0.45,  0.46);
  place(new THREE.BoxGeometry(0.76, 0.13, 0.76), m(LINEN, 0.85, 0.04), 0,              0.39, 0);
  place(new THREE.BoxGeometry(0.13, 0.44, 0.76), m(LINEN, 0.85, 0.04), backDir * 0.39, 0.64, 0);
  ([[0.34, -0.35], [0.34, 0.35], [-0.34, -0.35], [-0.34, 0.35]] as [number, number][]).forEach(([dx, dz]) =>
    place(new THREE.CylinderGeometry(0.038, 0.038, 0.15, 8), m(WOOD, 0.45, 0.25), dx, 0.075, dz));
};

// 3-seater sofa core (both lobby sofas use faceZ = -1 — backrest on the -z side)
// plus the coloured throw cushions that previously lived in addAtmosphereEffects.
const buildSofa3 = (cushions: Array<[number, number, number]>) => ({ m, place }: BuildCtx) => {
  const faceZ = -1;
  place(new THREE.BoxGeometry(2.4, 0.24, 0.96),  m(CREAM, 0.82, 0.05), 0, 0.22, 0);
  place(new THREE.BoxGeometry(2.4, 0.66, 0.22),  m(CREAM, 0.82, 0.05), 0, 0.71, faceZ * 0.46); // backrest
  place(new THREE.BoxGeometry(0.24, 0.46, 0.96), m(BEIGE, 0.78, 0.06), -1.2, 0.45, 0);
  place(new THREE.BoxGeometry(0.24, 0.46, 0.96), m(BEIGE, 0.78, 0.06),  1.2, 0.45, 0);
  ([-0.74, 0, 0.74] as number[]).forEach(dx =>
    place(new THREE.BoxGeometry(0.72, 0.13, 0.82), m(LINEN, 0.85, 0.04), dx, 0.39, 0));
  ([-0.74, 0, 0.74] as number[]).forEach(dx =>
    place(new THREE.BoxGeometry(0.68, 0.44, 0.22), m(LINEN, 0.85, 0.04), dx, 0.64, faceZ * 0.39));
  ([[1.06, 0.39], [1.06, -0.39], [-1.06, 0.39], [-1.06, -0.39]] as [number, number][]).forEach(([dx, dz]) =>
    place(new THREE.CylinderGeometry(0.042, 0.042, 0.15, 8), m(WOOD, 0.45, 0.25), dx, 0.075, dz));
  // Coloured throw cushions [dx, dz, colour]
  cushions.forEach(([dx, dz, col]) =>
    place(new THREE.BoxGeometry(0.60, 0.09, 0.60), m(col, 0.82, 0.02), dx, 0.47, dz));
};

// Coffee tables — shared frame, per-zone décor (verbatim from original).
const coffeeTableFrame = ({ m, place }: BuildCtx) => {
  place(new THREE.BoxGeometry(2.0, 0.06, 1.0), m(WOOD, 0.40, 0.22), 0, 0.37, 0);
  ([[0.90, 0.38], [0.90, -0.38], [-0.90, 0.38], [-0.90, -0.38]] as [number, number][]).forEach(([lx, lz]) =>
    place(new THREE.BoxGeometry(0.06, 0.32, 0.06), m(WOOD, 0.45, 0.20), lx, 0.16, lz));
};
const buildCoffeeTableBack = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  coffeeTableFrame(ctx);
  place(new THREE.CylinderGeometry(0.06, 0.048, 0.08, 12), m(TERRA, 0.85, 0.08), -0.40, 0.44, 0);
  place(new THREE.SphereGeometry(0.09, 10, 10), m(PK1, 0.88, 0.02), -0.40, 0.56, 0);
  place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0xD09060, 0.8, 0.05), 0.35, 0.41,  0);
  place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0x6A9468, 0.8, 0.05), 0.35, 0.443, 0);
};
const buildCoffeeTableFront = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  coffeeTableFrame(ctx);
  place(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 12), m(TERRA, 0.85, 0.08), -0.30, 0.44, 0);
  place(new THREE.SphereGeometry(0.08, 10, 10), m(PK2, 0.88, 0.02), -0.30, 0.54, 0);
  place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0xA09060, 0.8, 0.05), 0.30, 0.41,  0);
  place(new THREE.BoxGeometry(0.16, 0.032, 0.12), m(0x5A90A8, 0.8, 0.05), 0.30, 0.442, 0);
};

// Corner lamp table with shaded lamp + point light.
const buildLampTable = ({ m, place, addLight }: BuildCtx) => {
  place(new THREE.CylinderGeometry(0.28, 0.24, 0.048, 18),  m(WOOD,   0.40, 0.22), 0, 0.54, 0);
  place(new THREE.CylinderGeometry(0.038, 0.038, 0.50, 8),  m(DKWOOD, 0.55, 0.18), 0, 0.27, 0);
  place(new THREE.CylinderGeometry(0.17,  0.17,  0.04, 14), m(DKWOOD, 0.55, 0.18), 0, 0.02, 0);
  place(new THREE.CylinderGeometry(0.055, 0.075, 0.20, 10), m(DKWOOD, 0.50, 0.20), 0, 0.72, 0);
  place(new THREE.CylinderGeometry(0.18,  0.12,  0.28, 14), m(0xF8E8C0, 0.88, 0.02, 0xFFD080, 0.55), 0, 0.96, 0);
  addLight(new THREE.PointLight(0xFFD080, 0, 7), 0, 1.1, 0, 1.0);
};

// Tall cherry blossom tree (no collision — footprint: null, documented drift).
const buildCherryTree = ({ m, place }: BuildCtx) => {
  place(new THREE.CylinderGeometry(0.22, 0.17, 0.40, 14),    m(TERRA,    0.85, 0.07), 0, 0.20, 0);
  place(new THREE.CylinderGeometry(0.235, 0.225, 0.048, 14), m(0xC06840, 0.80, 0.05), 0, 0.43, 0);
  place(new THREE.CylinderGeometry(0.058, 0.082, 1.22, 8),   m(0x4A2A18, 0.85, 0.05), 0, 1.04, 0);
  place(new THREE.SphereGeometry(0.44, 12, 12), m(PK1, 0.88, 0.02),  0,    1.88, 0);
  place(new THREE.SphereGeometry(0.36, 12, 12), m(PK2, 0.86, 0.02), -0.34, 1.66,  0.18);
  place(new THREE.SphereGeometry(0.34, 12, 12), m(PK2, 0.86, 0.02),  0.34, 1.66, -0.16);
  place(new THREE.SphereGeometry(0.28, 12, 12), m(PK3, 0.84, 0.02), -0.12, 2.20, 0);
  place(new THREE.SphereGeometry(0.22, 12, 12), m(PK1, 0.88, 0.02),  0.28, 2.00,  0.20);
};

// Small cherry blossom accent (sits at lamp-table top height).
const buildBlossomPot = (ctx: BuildCtx) => roundPlant(ctx, 0, 0.56, 0);

// Bar corner (right-front, hugging x=+6 wall) — composite, movable: false.
const buildBarCorner = (ctx: BuildCtx) => {
  const { m, place, addLight } = ctx;
  // Item origin = original bar body centre (BAR_X=5.24, BAR_Z=3.10).
  const BAR_L = 2.80;  // bar length (z direction)  world z range: 1.70 → 4.50
  const BAR_H = 1.08;  // counter height

  // Cabinet body
  place(new THREE.BoxGeometry(0.58, BAR_H, BAR_L), m(DKWOOD, 0.78, 0.06), 0, BAR_H / 2, 0);
  // Counter top (white, slight overhang toward room)
  place(new THREE.BoxGeometry(0.76, 0.072, BAR_L + 0.18), m(0xFAFAFA, 0.45, 0.14), -0.07, BAR_H + 0.036, 0);
  // Counter edge trim
  place(new THREE.BoxGeometry(0.76, 0.036, BAR_L + 0.18), m(WOOD, 0.40, 0.28), -0.07, BAR_H + 0.090, 0);
  // Footrest rail (box)
  place(new THREE.BoxGeometry(0.044, 0.038, BAR_L - 0.24), m(WOOD, 0.40, 0.30), -0.22, 0.25, 0);

  // Back panel (flat against x=+6 wall; world x=5.97)
  place(new THREE.BoxGeometry(0.055, 1.88, BAR_L + 0.10), m(0xF5F5F5, 0.88, 0.02), 0.73, 0.94, 0);
  // Three shelves on back wall (world x=5.84)
  ([0.52, 1.00, 1.50] as number[]).forEach(sy =>
    place(new THREE.BoxGeometry(0.28, 0.036, BAR_L + 0.04), m(0xE8E8E8, 0.72, 0.04), 0.60, sy, 0));

  // Bottles (cylinder body + neck + cap)
  const makeBottle = (bz: number, sy: number, col: number) => {
    place(new THREE.CylinderGeometry(0.040, 0.048, 0.22, 8), m(col, 0.22, 0.58), 0.60, sy + 0.11, bz);
    place(new THREE.CylinderGeometry(0.017, 0.028, 0.09, 8), m(col, 0.22, 0.58), 0.60, sy + 0.265, bz);
    place(new THREE.SphereGeometry(0.020, 6, 6),              m(0x888888, 0.40, 0.40), 0.60, sy + 0.315, bz);
  };
  const BCOLS = [0x3A7840, 0xA83020, 0xE8C030, 0x284890, 0xD07020, 0x60A050, 0x8848A0];
  const BOFFS = [-1.1, -0.55, 0, 0.55, 1.1];
  BOFFS.forEach((dz, i) => makeBottle(dz, 0.52, BCOLS[i % BCOLS.length]));
  BOFFS.forEach((dz, i) => makeBottle(dz, 1.00, BCOLS[(i + 2) % BCOLS.length]));
  BOFFS.forEach((dz, i) => makeBottle(dz, 1.50, BCOLS[(i + 4) % BCOLS.length]));

  // Wine glasses on counter (very thin cylinder + stem + base)
  const makeGlass = (gz: number) => {
    place(new THREE.CylinderGeometry(0.042, 0.018, 0.15, 10), m(0xDDEEFF, 0.06, 0.12), -0.14, BAR_H + 0.147, gz);
    place(new THREE.CylinderGeometry(0.006, 0.006, 0.10,  8), m(0xDDEEFF, 0.06, 0.12), -0.14, BAR_H + 0.297, gz);
    place(new THREE.CylinderGeometry(0.028, 0.028, 0.012,10), m(0xDDEEFF, 0.06, 0.12), -0.14, BAR_H + 0.348, gz);
  };
  makeGlass(-0.80);
  makeGlass(-0.10);
  makeGlass( 0.60);

  // Bar stools (3, facing bar / +x)
  const makeBarStool = (sz: number) => {
    place(new THREE.CylinderGeometry(0.21, 0.21, 0.052, 14), m(CREAM, 0.82, 0.04), -0.64, 0.71,  sz); // seat pad
    place(new THREE.CylinderGeometry(0.19, 0.19, 0.038, 14), m(LINEN, 0.85, 0.04), -0.64, 0.752, sz); // cushion
    place(new THREE.CylinderGeometry(0.034, 0.034, 0.65, 8), m(WOOD,  0.45, 0.25), -0.64, 0.37,  sz); // stem
    place(new THREE.CylinderGeometry(0.21, 0.21, 0.038, 14), m(WOOD,  0.45, 0.25), -0.64, 0.019, sz); // base
    // footrest cross
    place(new THREE.BoxGeometry(0.36, 0.028, 0.036), m(WOOD, 0.45, 0.25), -0.64, 0.35, sz);
    place(new THREE.BoxGeometry(0.036, 0.028, 0.36), m(WOOD, 0.45, 0.25), -0.64, 0.35, sz);
  };
  makeBarStool(-0.95);
  makeBarStool(0);
  makeBarStool(0.95);

  // Pendant light above bar
  place(new THREE.CylinderGeometry(0.13, 0.09, 0.17, 12), m(0x282828, 0.70, 0.10), -0.45, 2.14, 0); // shade
  addLight(new THREE.PointLight(0xFFE8A0, 0, 10), -0.45, 1.9, 0, 1.6);

  // Small blossom pot at bar end
  roundPlant(ctx, -0.14, BAR_H + 0.072, -BAR_L / 2 + 0.22);
};

// ── Wall computer (M1 of #33) — visuals adopted from PR #36's deviceProps.ts ──
// Wall-mounted room terminal: dark slate housing + bezel + live CanvasTexture
// screen, amber accent strip (0xD4A84B — adapter/keypad palette). Local frame:
// screen faces +z, panel centre at mount height WC_Y; the registry item flips
// it into the room with rot 2 (flush-mount idiom like the bar back-panel).
const WC_W = 0.9;   // housing width
const WC_H = 0.7;   // housing height
const WC_D = 0.12;  // housing depth
const WC_Y = 1.6;   // mount height (panel centre)

const buildWallComputer = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  const HOUSING = 0x2A3444; // gunmetal slate (matches adapter/door frames)
  const BEZEL = 0x3D4A5E;
  const ACCENT = 0xD4A84B;  // keypad gold

  place(new THREE.BoxGeometry(WC_W, WC_H, WC_D - 0.04), m(HOUSING, 0.6, 0.5), 0, WC_Y, -0.02);            // housing (back)
  place(new THREE.BoxGeometry(0.82, 0.60, 0.03), m(BEZEL, 0.55, 0.45), 0, WC_Y + 0.02, WC_D / 2 - 0.015); // bezel
  place(new THREE.BoxGeometry(WC_W, 0.05, 0.03), m(ACCENT, 0.4, 0.5), 0, WC_Y - WC_H / 2 + 0.025, WC_D / 2 - 0.015); // amber strip
  place(new THREE.BoxGeometry(0.20, 0.06, 0.02), m(HOUSING, 0.6, 0.5), 0, WC_Y - WC_H / 2 + 0.025, WC_D / 2 + 0.001); // strip badge

  // ── Screen: live CanvasTexture. Redrawn only by the WallScreenHandle the
  //    World drives at ~1 Hz (permanent home of #36's dev-hook wiring) —
  //    no internal timer. Starts opacity 0 for the morph fade-in.
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 192;
  const c2d = cv.getContext('2d')!;
  const screenTex = new THREE.CanvasTexture(cv);
  screenTex.minFilter = THREE.NearestFilter;
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.generateMipmaps = false;
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, transparent: true, opacity: 0 }); // unlit = emissive read
  const screen = place(new THREE.PlaneGeometry(0.72, 0.50), screenMat, 0, WC_Y + 0.02, WC_D / 2 + 0.002);

  const drawStatus = (status: WallComputerStatus) => {
    c2d.imageSmoothingEnabled = false;
    c2d.fillStyle = '#0A1018';
    c2d.fillRect(0, 0, 256, 192);
    c2d.strokeStyle = '#1E2A38';
    c2d.strokeRect(3.5, 3.5, 249, 185);
    // Header: room name (amber)
    c2d.font = 'bold 16px monospace';
    c2d.textAlign = 'left';
    c2d.textBaseline = 'alphabetic';
    c2d.fillStyle = '#D4A84B';
    c2d.fillText(status.roomName.toUpperCase().slice(0, 16), 14, 28);
    c2d.strokeStyle = '#D4A84B';
    c2d.beginPath(); c2d.moveTo(14, 38); c2d.lineTo(242, 38); c2d.stroke();
    // Peer count (cyan)
    c2d.font = '14px monospace';
    c2d.fillStyle = '#00E5FF';
    c2d.fillText(`PEERS: ${status.peers}`, 14, 62);
    // Node status LED + label
    c2d.beginPath();
    c2d.arc(21, 82, 5, 0, Math.PI * 2);
    c2d.fillStyle = status.nodeOnline ? '#00E676' : '#FF1744';
    c2d.fill();
    c2d.fillStyle = '#8FA3B8';
    c2d.fillText(`NODE ${status.nodeOnline ? 'ONLINE' : 'OFFLINE'}`, 34, 87);
    // Wireframe room-outline motif (the full live view is the FOCUSED DOM UI)
    c2d.strokeStyle = '#3E92B8';
    c2d.strokeRect(150.5, 100.5, 92, 68);
    c2d.fillStyle = '#3E92B8';
    c2d.fillRect(192, 97, 10, 4);   // north door port
    c2d.fillRect(192, 167, 10, 4);  // south door port
    c2d.fillRect(147, 130, 4, 10);  // west door port
    c2d.fillRect(241, 130, 4, 10);  // east door port
    c2d.fillStyle = '#25506A';
    c2d.font = '10px monospace';
    c2d.fillText('MODULE', 172, 140);
    // Honesty rule: no fuel system exists — say so, dimly.
    c2d.fillStyle = '#4A5560';
    c2d.font = '12px monospace';
    c2d.fillText('FUEL — NO SENSOR', 14, 120);
    c2d.fillStyle = '#33404E';
    c2d.font = '10px monospace';
    c2d.fillText('SSF ROOM TERMINAL v1', 14, 178);
    screenTex.needsUpdate = true;
  };

  // Dimmed frame shown while a player is focused (plan §D0.4 hybrid screens).
  const drawInUse = () => {
    c2d.imageSmoothingEnabled = false;
    c2d.fillStyle = '#060A10';
    c2d.fillRect(0, 0, 256, 192);
    c2d.strokeStyle = '#1E2A38';
    c2d.strokeRect(3.5, 3.5, 249, 185);
    c2d.font = 'bold 14px monospace';
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.fillStyle = 'rgba(212, 168, 75, 0.45)';
    c2d.fillText('TERMINAL IN USE', 128, 96);
    screenTex.needsUpdate = true;
  };

  let engaged = false;
  let lastStatus: WallComputerStatus = { roomName: 'FURLONG LOBBY', peers: 0, nodeOnline: false };
  const handle: WallScreenHandle = {
    updateStatus: (status) => {
      lastStatus = status;
      if (engaged) drawInUse(); else drawStatus(status);
    },
    setEngaged: (value) => {
      engaged = value;
      if (engaged) drawInUse(); else drawStatus(lastStatus);
    },
  };
  // Boot frame so the prop is never a black rectangle before the first tick.
  drawStatus(lastStatus);
  screen.userData.wallScreen = handle; // collected by World.addLobbyFurniture
};

// ── Map table / holograph table (M4 of #33) ──────────────────────────────────
// Sturdy dark 2×2 table (4 chunky legs + top) with a holographic disc floating
// above it: emissive cyan plane + a slow-spinning broken emissive ring (the
// gap is what makes the spin readable). flat() = MeshBasicMaterial, the same
// unlit-reads-as-emissive idiom as the fireplace fire layers and wall strips.
// The ring mesh carries userData.holoSpin (rad/s); World.addLobbyFurniture
// collects it and World.update() drives the rotation — same collect-and-drive
// seam as the wall computer's userData.wallScreen handle.
const MT_TOP_Y = 0.84;   // table-top surface height
const MT_HOLO_Y = 1.18;  // holo disc plane height
const HOLO_CYAN = 0x00E5FF;

const buildMapTable = (ctx: BuildCtx) => {
  const { m, flat, place, addLight } = ctx;
  const BODY = 0x232B36;   // dark gunmetal (wall-computer housing family)
  const TRIM = 0x3D4A5E;   // bezel slate
  const ACCENT = 0xD4A84B; // keypad gold

  // Top slab + slate trim lip (footprint is 2×2; visuals inset for clearance)
  place(new THREE.BoxGeometry(1.80, 0.10, 1.80), m(BODY, 0.55, 0.45), 0, MT_TOP_Y - 0.05, 0);
  place(new THREE.BoxGeometry(1.86, 0.04, 1.86), m(TRIM, 0.50, 0.50), 0, MT_TOP_Y - 0.11, 0);
  // Apron under the slab
  place(new THREE.BoxGeometry(1.55, 0.16, 1.55), m(BODY, 0.60, 0.40), 0, MT_TOP_Y - 0.20, 0);
  // Amber accent strip ringing the apron (gold band on the -z/player face)
  place(new THREE.BoxGeometry(1.57, 0.035, 1.57), m(ACCENT, 0.40, 0.50), 0, MT_TOP_Y - 0.145, 0);
  // Four chunky legs
  ([[-0.76, -0.76], [-0.76, 0.76], [0.76, -0.76], [0.76, 0.76]] as [number, number][]).forEach(([lx, lz]) => {
    place(new THREE.BoxGeometry(0.16, MT_TOP_Y - 0.10, 0.16), m(BODY, 0.60, 0.40), lx, (MT_TOP_Y - 0.10) / 2, lz);
    place(new THREE.BoxGeometry(0.20, 0.05, 0.20), m(TRIM, 0.55, 0.45), lx, 0.025, lz); // foot
  });

  // Holo emitter puck at the table centre
  place(new THREE.CylinderGeometry(0.16, 0.20, 0.06, 16), m(TRIM, 0.45, 0.55), 0, MT_TOP_Y + 0.03, 0);
  place(new THREE.CylinderGeometry(0.10, 0.10, 0.015, 16), flat(HOLO_CYAN), 0, MT_TOP_Y + 0.065, 0);

  // Holographic disc — emissive cyan plane floating above the table. The
  // geometry is rotated flat (rotateX) so the MESH keeps identity rotation
  // and the ring below can spin with a plain rotation.y increment.
  const discMat = flat(HOLO_CYAN);
  discMat.userData.baseOpacity = 0.28; // translucent hologram (morph respects it)
  const discGeo = new THREE.CircleGeometry(0.62, 40);
  discGeo.rotateX(-Math.PI / 2); // face +y
  place(discGeo, discMat, 0, MT_HOLO_Y, 0);

  // Slow-spinning broken emissive ring above the disc rim
  const ringMat = flat(0x7FF3FF);
  ringMat.userData.baseOpacity = 0.85;
  const ringGeo = new THREE.TorusGeometry(0.55, 0.018, 8, 48, Math.PI * 1.55);
  ringGeo.rotateX(Math.PI / 2); // lie flat in the XZ plane
  const ring = place(ringGeo, ringMat, 0, MT_HOLO_Y + 0.05, 0);
  ring.userData.holoSpin = 0.6; // rad/s — collected by World.addLobbyFurniture

  // Faint cyan wash over the table surface
  addLight(new THREE.PointLight(HOLO_CYAN, 0, 3.5), 0, MT_HOLO_Y + 0.4, 0, 0.9);
};

// ── Storage trunk (TR2 of #35) — visuals adopted from PR #36's deviceProps.ts ──
// Concept-art-faithful ISS crate: light-gray ribbed shell, orange corner
// reinforcements + latch plates + lid trim, 'ISS-ST04' stencil decal, hinged
// lid sub-Group. The lid animation is update-loop driven with completion
// callbacks (PR #29's door-slide idiom, NOT a detached rAF loop): the builder
// stows a TrunkLidHandle in the lid slab's userData.trunkLid; World collects
// it, drives update(dt) every frame, and requestDeviceFocus wires openLid/
// closeLid into the focus choreography (prepare / onRelease).
const COL_TRUNK_BODY = 0xB8BEC6;   // light-gray ribbed shell
const COL_TRUNK_RIB = 0xA6ADB6;    // slightly darker ribs / panel lines
const COL_TRUNK_ORANGE = 0xE8760A; // corner reinforcements, latch plates, lid trim
const COL_TRUNK_LATCH = 0x6E7680;  // gray latch hardware
const COL_TRUNK_DARK = 0x14181E;   // interior cavity / label plate
const COL_TRUNK_TRAY = 0x2A3038;   // tool-tray layer

// Overall footprint ~1.0w × 0.65h × 0.6d, latch face toward local +z.
const TRUNK_W = 1.0;
const TRUNK_D = 0.6;
const TRUNK_BODY_H = 0.5;    // shell height; lid adds 0.15 → 0.65 total
const TRUNK_LID_H = 0.15;
const TRUNK_WALL_T = 0.05;
const LID_OPEN_ANGLE = -Math.PI * (100 / 180); // negative rotation.x = swing up + backward
const LID_SPEED = 2.4; // rad/s, constant-speed ease

/** One-shot pixel-text decal (star-window CanvasTexture idiom, world.ts). */
function makeStencilTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 48;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#14181E';
  ctx.fillRect(0, 0, 128, 48);
  ctx.strokeStyle = '#3A424C';
  ctx.strokeRect(2.5, 2.5, 123, 43);
  ctx.fillStyle = '#E8ECF2';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 25);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

const buildStorageTrunk = (ctx: BuildCtx) => {
  const { m, place, attach } = ctx;
  const W = TRUNK_W, D = TRUNK_D, BH = TRUNK_BODY_H, LH = TRUNK_LID_H, T = TRUNK_WALL_T;

  // Shared materials (each mesh sets opacity via the morph fade — sharing is
  // safe, the fade writes the same value to every user).
  const bodyMat = m(COL_TRUNK_BODY, 0.65, 0.35);
  const ribMat = m(COL_TRUNK_RIB, 0.7, 0.3);
  const orangeMat = m(COL_TRUNK_ORANGE, 0.5, 0.4);
  const latchMat = m(COL_TRUNK_LATCH, 0.45, 0.6);
  const darkMat = m(COL_TRUNK_DARK, 0.9, 0.1);
  const trayMat = m(COL_TRUNK_TRAY, 0.8, 0.2);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

  // ── Body shell: floor + four walls, leaving a real cavity for the open lid
  place(box(W, T, D), bodyMat, 0, T / 2, 0);                                  // floor
  place(box(W, BH - T, T), bodyMat, 0, (BH + T) / 2, (D - T) / 2);            // front
  place(box(W, BH - T, T), bodyMat, 0, (BH + T) / 2, -(D - T) / 2);           // back
  place(box(T, BH - T, D - 2 * T), bodyMat, -(W - T) / 2, (BH + T) / 2, 0);   // left
  place(box(T, BH - T, D - 2 * T), bodyMat, (W - T) / 2, (BH + T) / 2, 0);    // right

  // ── Interior: dark cavity liner + a hint of a tool-tray layer
  place(box(W - 2 * T, 0.02, D - 2 * T), darkMat, 0, T + 0.01, 0);            // dark bottom
  place(box(W - 2 * T - 0.06, 0.03, D - 2 * T - 0.06), trayMat, 0, 0.30, 0);  // tool tray
  // A few colored blocks suggesting stowed tools on the tray
  const toolBlocks: Array<[number, number, number, number]> = [
    [0xE8760A, -0.28, 0.16, 0.05], // orange driver
    [0x00E5FF, -0.06, 0.10, 0.05], // cyan gauge
    [0xD4A84B, 0.14, 0.20, 0.05],  // amber wrench case
    [0x8899AA, 0.32, 0.08, 0.05],  // gray spares tin
  ];
  toolBlocks.forEach(([color, x, w, h]) => {
    place(box(w, h, 0.14), m(color, 0.6, 0.3), x, 0.315 + h / 2, 0.02);
  });

  // ── Ribs (vertical, front + back faces) and side panel lines
  for (const rx of [-0.32, -0.11, 0.11, 0.32]) {
    place(box(0.055, BH - 0.14, 0.015), ribMat, rx, BH / 2, D / 2 + 0.005);   // front ribs
    place(box(0.055, BH - 0.14, 0.015), ribMat, rx, BH / 2, -D / 2 - 0.005);  // back ribs
  }
  for (const sx of [-1, 1]) {
    place(box(0.015, BH - 0.14, 0.055), ribMat, sx * (W / 2 + 0.005), BH / 2, -0.12); // side rib
    place(box(0.015, BH - 0.14, 0.055), ribMat, sx * (W / 2 + 0.005), BH / 2, 0.12);  // side rib
  }
  // Horizontal panel line across the front, above the label band
  place(box(W - 0.08, 0.02, 0.012), ribMat, 0, 0.40, D / 2 + 0.004);

  // ── Orange corner reinforcements (all four vertical corners)
  for (const cx of [-1, 1]) {
    for (const cz of [-1, 1]) {
      place(box(0.09, BH, 0.02), orangeMat, cx * (W / 2 - 0.045), BH / 2, cz * (D / 2 + 0.006));
      place(box(0.02, BH, 0.09), orangeMat, cx * (W / 2 + 0.006), BH / 2, cz * (D / 2 - 0.045));
    }
  }

  // ── Front hardware: orange latch plates + gray latches, stencil label
  for (const lx of [-0.30, 0.30]) {
    place(box(0.12, 0.16, 0.02), orangeMat, lx, BH - 0.06, D / 2 + 0.008);    // latch plate
    place(box(0.07, 0.10, 0.03), latchMat, lx, BH - 0.07, D / 2 + 0.022);     // latch body
  }
  // Stencil decal: transparent opacity-0 start like every furniture material
  // so it rides the morph fade-in with the rest of the prop.
  const labelMat = new THREE.MeshBasicMaterial({
    map: makeStencilTexture('ISS-ST04'), transparent: true, opacity: 0,
  });
  place(new THREE.PlaneGeometry(0.34, 0.13), labelMat, 0, 0.24, D / 2 + 0.012);

  // ── Lid: its own sub-Group hinged at the BACK top edge. Children sit
  //    forward of the hinge (+z), so negative rotation.x swings the lid
  //    up and backward over the back wall.
  const lid = new THREE.Group();
  lid.name = 'trunkLid';
  lid.position.set(0, BH, -D / 2);
  attach(lid);

  const addLid = (geo: THREE.BoxGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    lid.add(mesh);
    return mesh;
  };
  const lidSlab = addLid(box(W, LH, D), bodyMat, 0, LH / 2, D / 2);                 // lid slab
  addLid(box(W - 2 * T, 0.015, D - 2 * T), darkMat, 0, 0.002, D / 2);               // dark underside
  // Orange lid trim: front edge strip + side edge strips
  addLid(box(W, 0.04, 0.02), orangeMat, 0, 0.04, D + 0.006);
  for (const sx of [-1, 1]) {
    addLid(box(0.02, 0.04, D), orangeMat, sx * (W / 2 + 0.006), 0.04, D / 2);
  }
  // Subtle top handle recess: dark inset with a gray grab bar
  addLid(box(0.30, 0.02, 0.12), darkMat, 0, LH - 0.005, D / 2);
  addLid(box(0.22, 0.025, 0.03), latchMat, 0, LH + 0.002, D / 2);

  // ── Lid animation: constant-speed ease driven from World.update (like the
  //    door slides), completion callbacks fired exactly once on arrival.
  let lidAngle = 0;
  let lidTarget = 0;
  let pendingComplete: (() => void) | null = null;

  const setLidTarget = (target: number, onComplete?: () => void) => {
    if (target === lidTarget && lidAngle !== target) {
      // Same-target re-request while mid-swing: the earlier motion DOES still
      // arrive, so chain both callbacks instead of dropping the first.
      const prev = pendingComplete;
      pendingComplete = onComplete ? (prev ? () => { prev(); onComplete(); } : onComplete) : prev;
      return;
    }
    // A direction-changing call drops the previous callback (its motion never arrives).
    pendingComplete = null;
    lidTarget = target;
    if (lidAngle === lidTarget) { onComplete?.(); return; } // already there → fire once, now
    pendingComplete = onComplete ?? null;
  };

  const handle: TrunkLidHandle = {
    openLid: (onComplete?: () => void) => setLidTarget(LID_OPEN_ANGLE, onComplete),
    closeLid: (onComplete?: () => void) => setLidTarget(0, onComplete),
    update(deltaTime: number): void {
      if (lidAngle === lidTarget) return;
      const diff = lidTarget - lidAngle;
      const step = LID_SPEED * Math.max(0, deltaTime);
      if (Math.abs(diff) <= step) {
        lidAngle = lidTarget;
        lid.rotation.x = lidAngle;
        if (pendingComplete) {
          const cb = pendingComplete;
          pendingComplete = null; // exactly once
          cb();
        }
      } else {
        lidAngle += Math.sign(diff) * step;
        lid.rotation.x = lidAngle;
      }
    },
  };
  lidSlab.userData.trunkLid = handle; // collected by World.addLobbyFurniture
};

// ── Game table (#45 v1) — sturdy lounge table with a flippable two-face top ──
// FACE A: 8×8 checkerboard (live CanvasTexture, NearestFilter — the wall-
// computer screen idiom); FACE B: green card felt with a card-outline motif.
// The top is its own sub-Group pivoted at slab centre: FLIP lifts it, rotates
// 180° about the long (x) axis and settles — update-loop tween with a
// completion callback, exactly the trunk-lid idiom (never a detached rAF).
// The builder stows a GameTableTopHandle in the slab's userData.gameTableTop;
// World collects it, drives update(dt), and repaints the board face from the
// doc-synced game state so spectators see the live game in-world.
const GT_TOP_Y = 0.78;     // top pivot height (slab centre)
const GT_FLIP_TIME = 0.9;  // seconds for the 180° flip
const GT_FLIP_LIFT = 0.5;  // peak lift — the swinging slab clears the apron

// Checkerboard palette (warm frontier family)
const GT_SQ_LIGHT = '#EAD9B0';
const GT_SQ_DARK = '#7A4A28';
const GT_FRAME = '#4A2F1B';
const GT_RED = '#C43C3C';
const GT_RED_RIM = '#8E2626';
const GT_BLACK = '#23252E';
const GT_BLACK_RIM = '#0E0F14';
const GT_CROWN = '#F0C060';

/** Board-face painter shared by the builder (in-world texture). Kept board-
 *  code-compatible with games/checkers.ts (1/2 red man/king, 3/4 black). */
function drawCheckerboard(c2d: CanvasRenderingContext2D, board: number[] | null): void {
  const S = 512, PAD = 32, SQ = (S - PAD * 2) / 8; // 56 px squares
  c2d.imageSmoothingEnabled = false;
  c2d.fillStyle = GT_FRAME;
  c2d.fillRect(0, 0, S, S);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      c2d.fillStyle = (r + c) % 2 === 1 ? GT_SQ_DARK : GT_SQ_LIGHT;
      c2d.fillRect(PAD + c * SQ, PAD + r * SQ, SQ, SQ);
    }
  }
  if (!board) return;
  for (let idx = 0; idx < 64; idx++) {
    const v = board[idx];
    if (v === 0) continue;
    const red = v === 1 || v === 2;
    const king = v === 2 || v === 4;
    const cx = PAD + (idx % 8) * SQ + SQ / 2;
    const cy = PAD + Math.floor(idx / 8) * SQ + SQ / 2;
    c2d.beginPath();
    c2d.arc(cx, cy, SQ * 0.36, 0, Math.PI * 2);
    c2d.fillStyle = red ? GT_RED : GT_BLACK;
    c2d.fill();
    c2d.lineWidth = 4;
    c2d.strokeStyle = red ? GT_RED_RIM : GT_BLACK_RIM;
    c2d.stroke();
    if (king) {
      c2d.fillStyle = GT_CROWN;
      c2d.font = 'bold 26px monospace';
      c2d.textAlign = 'center';
      c2d.textBaseline = 'middle';
      c2d.fillText('K', cx, cy + 1);
    }
  }
}

/** One-shot card-felt face: green baize, darker border, two card outlines +
 *  centre pips. Motif is 180°-rotation-symmetric on purpose — the face is
 *  only ever seen after a flip, so no text that could read upside down. */
function drawCardFelt(c2d: CanvasRenderingContext2D): void {
  const W = 512, H = 256;
  c2d.imageSmoothingEnabled = false;
  c2d.fillStyle = '#14532D';
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = '#1B6B3A';
  c2d.fillRect(10, 10, W - 20, H - 20);
  c2d.strokeStyle = '#0E3B20';
  c2d.lineWidth = 4;
  c2d.strokeRect(20, 20, W - 40, H - 40);
  // Two card outlines, mirrored about the centre (rotation-symmetric)
  const card = (x: number, y: number) => {
    c2d.strokeStyle = 'rgba(240, 240, 230, 0.75)';
    c2d.lineWidth = 3;
    const w = 64, h = 92, rr = 8;
    c2d.beginPath();
    c2d.moveTo(x + rr, y);
    c2d.arcTo(x + w, y, x + w, y + h, rr);
    c2d.arcTo(x + w, y + h, x, y + h, rr);
    c2d.arcTo(x, y + h, x, y, rr);
    c2d.arcTo(x, y, x + w, y, rr);
    c2d.closePath();
    c2d.stroke();
  };
  card(W / 2 - 64 - 22, H / 2 - 46);
  card(W / 2 + 22, H / 2 - 46);
  // Centre diamond pip pair
  c2d.fillStyle = 'rgba(240, 240, 230, 0.55)';
  for (const dy of [-6, 6]) {
    c2d.beginPath();
    c2d.moveTo(W / 2, H / 2 + dy - 10);
    c2d.lineTo(W / 2 + 8, H / 2 + dy);
    c2d.lineTo(W / 2, H / 2 + dy + 10);
    c2d.lineTo(W / 2 - 8, H / 2 + dy);
    c2d.closePath();
    c2d.fill();
  }
}

const buildGameTable = (ctx: BuildCtx) => {
  const { m, place, attach } = ctx;

  // ── Fixed base: apron + four sturdy legs + low stretcher shelf (WOOD family)
  place(new THREE.BoxGeometry(1.50, 0.14, 0.62), m(WOOD, 0.55, 0.15), 0, 0.62, 0);       // apron
  place(new THREE.BoxGeometry(1.40, 0.04, 0.50), m(WOOD, 0.60, 0.12), 0, 0.16, 0);       // stretcher
  ([[-0.72, -0.30], [-0.72, 0.30], [0.72, -0.30], [0.72, 0.30]] as [number, number][]).forEach(([lx, lz]) => {
    place(new THREE.BoxGeometry(0.12, 0.62, 0.12), m(DKWOOD, 0.55, 0.18), lx, 0.31, lz); // leg
    place(new THREE.BoxGeometry(0.15, 0.04, 0.15), m(WOOD, 0.50, 0.20), lx, 0.02, lz);   // foot
  });

  // ── Flippable top: sub-Group pivoted at the slab centre
  const top = new THREE.Group();
  top.name = 'gameTableTop';
  top.position.set(0, GT_TOP_Y, 0);
  attach(top);

  const addTop = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    top.add(mesh);
    return mesh;
  };
  const slab = addTop(new THREE.BoxGeometry(1.76, 0.07, 0.86), m(WOOD, 0.45, 0.20), 0, 0, 0);
  // Thin darker edge band so the flip reads even from far away
  addTop(new THREE.BoxGeometry(1.80, 0.024, 0.90), m(0xA06A32, 0.50, 0.18), 0, 0, 0);

  // FACE A — checkerboard CanvasTexture (NearestFilter, wall-screen idiom).
  const boardCv = document.createElement('canvas');
  boardCv.width = 512; boardCv.height = 512;
  const boardC2d = boardCv.getContext('2d')!;
  const boardTex = new THREE.CanvasTexture(boardCv);
  boardTex.minFilter = THREE.NearestFilter;
  boardTex.magFilter = THREE.NearestFilter;
  boardTex.generateMipmaps = false;
  boardTex.colorSpace = THREE.SRGBColorSpace;
  drawCheckerboard(boardC2d, null); // bare board until a game exists
  const boardMat = new THREE.MeshBasicMaterial({ map: boardTex, transparent: true, opacity: 0 });
  // rotateX(-π/2) faces +y; the extra rotateY(π) points texture-up AWAY from
  // the device front (-z), so board row 0 (black home) reads at the far side
  // for the focused viewer — matching the DOM board's fixed orientation.
  const boardGeo = new THREE.PlaneGeometry(0.74, 0.74);
  boardGeo.rotateX(-Math.PI / 2);
  boardGeo.rotateY(Math.PI);
  addTop(boardGeo, boardMat, 0, 0.037, 0);

  // FACE B — card felt, facing -y until a flip brings it up.
  const feltCv = document.createElement('canvas');
  feltCv.width = 512; feltCv.height = 256;
  drawCardFelt(feltCv.getContext('2d')!);
  const feltTex = new THREE.CanvasTexture(feltCv);
  feltTex.minFilter = THREE.NearestFilter;
  feltTex.magFilter = THREE.NearestFilter;
  feltTex.generateMipmaps = false;
  feltTex.colorSpace = THREE.SRGBColorSpace;
  const feltMat = new THREE.MeshBasicMaterial({ map: feltTex, transparent: true, opacity: 0 });
  const feltGeo = new THREE.PlaneGeometry(1.55, 0.72);
  feltGeo.rotateX(Math.PI / 2);  // face -y
  feltGeo.rotateY(Math.PI);      // texture-up lands away from the viewer post-flip
  addTop(feltGeo, feltMat, 0, -0.037, 0);

  // ── Flip tween: constant-duration smoothstep rotation about the long (x)
  //    axis with a sine lift, driven from World.update (trunk-lid idiom).
  //    The flip is CLIENT-LOCAL in v1 (review F3): cardsUp lives in this
  //    closure and flip() only fires from the local focused UI, so peers can
  //    see different faces of the same table while the game state underneath
  //    stays shared. Doc-sync a per-table cardsUp when the card side is real.
  let flipT = 1;               // 1 = at rest
  let fromAngle = 0;
  let toAngle = 0;
  let cardsUp = false;
  let pendingComplete: (() => void) | null = null;

  const handle: GameTableTopHandle = {
    flip(onComplete?: () => void): boolean {
      if (flipT < 1) return false; // one flip at a time
      fromAngle = toAngle;
      toAngle = fromAngle + Math.PI;
      flipT = 0;
      pendingComplete = onComplete ?? null;
      return true;
    },
    isFlipping(): boolean {
      return flipT < 1;
    },
    isCardsUp(): boolean {
      return cardsUp;
    },
    setBoard(board: number[] | null): void {
      drawCheckerboard(boardC2d, board);
      boardTex.needsUpdate = true;
    },
    update(deltaTime: number): void {
      if (flipT >= 1) return;
      flipT = Math.min(1, flipT + Math.max(0, deltaTime) / GT_FLIP_TIME);
      const s = flipT * flipT * (3 - 2 * flipT); // smoothstep
      top.rotation.x = fromAngle + (toAngle - fromAngle) * s;
      top.position.y = GT_TOP_Y + Math.sin(Math.PI * flipT) * GT_FLIP_LIFT;
      if (flipT >= 1) {
        toAngle = toAngle % (Math.PI * 2); // keep the accumulator bounded
        fromAngle = toAngle;
        top.rotation.x = toAngle;
        top.position.y = GT_TOP_Y;
        cardsUp = !cardsUp;
        if (pendingComplete) {
          const cb = pendingComplete;
          pendingComplete = null; // exactly once
          cb();
        }
      }
    },
  };
  slab.userData.gameTableTop = handle; // collected by World.addLobbyFurniture
};

// ── Definitions ───────────────────────────────────────────────────────────────
const armchairLeftSeats: SeatTemplate[] = [{
  clickBox: { x0: -0.50, z0: -0.50, x1: 0.50, z1: 0.50 },
  front: { x: 1.0, z: 0 },
  sit: { x: 0, z: 0 },
  faceAngle: Math.PI / 2,
}];
const armchairRightSeats: SeatTemplate[] = [{
  clickBox: { x0: -0.50, z0: -0.50, x1: 0.50, z1: 0.50 },
  front: { x: -1.0, z: 0 },
  sit: { x: 0, z: 0 },
  faceAngle: -Math.PI / 2,
}];
// Back sofa: 3 cushions, faces +z (toward the entrance).
const sofaBackSeats: SeatTemplate[] = [
  { clickBox: { x0: -1.50, z0: -0.50, x1: -0.50, z1: 0.50 }, front: { x: -1.0, z: 1.0 }, sit: { x: -1.0, z: 0 }, faceAngle: 0 },
  { clickBox: { x0: -0.50, z0: -0.50, x1:  0.50, z1: 0.50 }, front: { x:  0.0, z: 1.0 }, sit: { x:  0.0, z: 0 }, faceAngle: 0 },
  { clickBox: { x0:  0.50, z0: -0.50, x1:  1.50, z1: 0.50 }, front: { x:  1.0, z: 1.0 }, sit: { x:  1.0, z: 0 }, faceAngle: 0 },
];
// Front sofa: 2 wide halves, faces -z; fronts approach from the SIDES because
// the coffee table pinches the corridor in front (preserved hand-tuned data).
const sofaFrontSeats: SeatTemplate[] = [
  { clickBox: { x0: -1.50, z0: -0.50, x1: 0.00, z1: 0.50 }, front: { x: -2.0, z: 0 }, sit: { x: -1.0, z: 0 }, faceAngle: Math.PI },
  { clickBox: { x0:  0.00, z0: -0.50, x1: 1.50, z1: 0.50 }, front: { x:  2.0, z: 0 }, sit: { x:  1.0, z: 0 }, faceAngle: Math.PI },
];

export const FURNITURE_DEFS: Record<FurnitureKind, FurnitureDef> = {
  'fireplace-wall':     { kind: 'fireplace-wall',     build: buildFireplaceWall,     footprint: { w: 10, d: 1 } },
  'sofa-back':          { kind: 'sofa-back',          build: buildSofa3([[-0.72, 0, 0xC04060], [0, 0, 0x3870C8], [0.72, 0, 0xD89030]]), footprint: { w: 3, d: 1 }, seats: sofaBackSeats },
  'sofa-front':         { kind: 'sofa-front',         build: buildSofa3([[-0.72, -0.3, 0x50A870], [0, -0.3, 0xC04060], [0.72, -0.3, 0x3870C8]]), footprint: { w: 3, d: 1 }, seats: sofaFrontSeats },
  'armchair-left':      { kind: 'armchair-left',      build: buildArmchair(-1),      footprint: { w: 1, d: 1 }, seats: armchairLeftSeats },
  'armchair-right':     { kind: 'armchair-right',     build: buildArmchair(1),       footprint: { w: 1, d: 1 }, seats: armchairRightSeats },
  'coffee-table-back':  { kind: 'coffee-table-back',  build: buildCoffeeTableBack,   footprint: { w: 2, d: 1 } },
  'coffee-table-front': { kind: 'coffee-table-front', build: buildCoffeeTableFront,  footprint: { w: 2, d: 1 } },
  // Bar footprint is expressed per-item (footprintOverride) — the original
  // obstacle box covers the stool strip, not the cabinet body.
  'bar-corner':         { kind: 'bar-corner',         build: buildBarCorner,         footprint: null },
  'lamp-table':         { kind: 'lamp-table',         build: buildLampTable,         footprint: { w: 1, d: 1 } },
  'rug-back':           { kind: 'rug-back',           build: buildRugBack,           footprint: null },
  'rug-front':          { kind: 'rug-front',          build: buildRugFront,          footprint: null },
  'cherry-tree':        { kind: 'cherry-tree',        build: buildCherryTree,        footprint: null },
  'blossom-pot':        { kind: 'blossom-pot',        build: buildBlossomPot,        footprint: null },
  // Wall-mounted room terminal (M1 of #33): footprint null — it hangs on the
  // wall plane and must never become an obstacle. Device template in the
  // local rot-0 frame (screen faces +z):
  //  - front 1.0 in front of the screen; faceAngle π = facing TOWARD the
  //    device (-z locally — opposite of the seats' back-to-chair convention)
  //  - eye at standing height 0.85 in front; anchor on the screen centre
  //    (panel centre y = 1.6, screen offset +0.02).
  'wall-computer': {
    kind: 'wall-computer',
    build: buildWallComputer,
    footprint: null,
    functions: ['roomTerminal'],
    device: {
      kind: 'roomTerminal',
      front: { x: 0, z: 1.0 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.45, z: 0.85 },
      anchor: { x: 0, y: 1.62, z: 0.06 },
    },
  },
  // Holographic map table (M4 of #33): footprint 2×2 — a REAL obstacle (both
  // collision and pathfinding derive from it). Device template in the local
  // rot-0 frame:
  //  - front 0.5 m beyond the +z footprint edge; faceAngle π = facing TOWARD
  //    the table (-z locally — same toward-the-device convention as the
  //    wall computer, opposite of seats)
  //  - eye above the table edge (y 1.6, just inside the +z rim), anchor at
  //    the holo disc centre (y ≈ 1.2) — a gentle downward gaze onto the map.
  'map-table': {
    kind: 'map-table',
    build: buildMapTable,
    footprint: { w: 2, d: 2 },
    functions: ['mapTable'],
    device: {
      kind: 'mapTable',
      front: { x: 0, z: 1.5 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.6, z: 1.15 },
      anchor: { x: 0, y: MT_HOLO_Y, z: 0 },
    },
  },
  'storage-trunk': {
    kind: 'storage-trunk',
    build: buildStorageTrunk,
    footprint: { w: 1, d: 1 },
    functions: ['storageTrunk'],
    device: {
      kind: 'storageTrunk',
      front: { x: 0, z: 1.0 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.35, z: 1.0 },
      anchor: { x: 0, y: 0.3, z: 0 },
    },
  },
  // Flippable game table (#45 v1): footprint 2×1 — a real obstacle. Device
  // template in the local rot-0 frame; the top's open side is -z:
  //  - front 0.5 m beyond the -z footprint edge; faceAngle 0 = facing TOWARD
  //    the table (+z locally — toward-the-device convention, like the others)
  //  - eye above the front edge (y 1.55), anchor at the board centre on the
  //    top surface (y ≈ 0.82) — a downward gaze onto the playing face.
  'game-table': {
    kind: 'game-table',
    build: buildGameTable,
    footprint: { w: 2, d: 1 },
    functions: ['gameTable'],
    device: {
      kind: 'gameTable',
      front: { x: 0, z: -1.0 },
      faceAngle: 0,
      eye: { x: 0, y: 1.55, z: -0.95 },
      anchor: { x: 0, y: 0.82, z: 0 },
    },
  },
};

// ── Item list — today's EXACT lobby layout ────────────────────────────────────
// Obstacle-bearing items appear first, in the same order as the original
// hand-authored OBSTACLES list, so collision-resolution iteration order (and
// therefore sliding behaviour in multi-box corners) is unchanged.
export const FURNITURE: FurnitureItem[] = [
  { id: 'fireplace-wall',        kind: 'fireplace-wall',     pos: { x:  0.0,  z: -5.5 }, rot: 0, movable: false },
  { id: 'sofa-back',             kind: 'sofa-back',          pos: { x:  0.0,  z: -1.5 }, rot: 0, movable: true },
  { id: 'sofa-front',            kind: 'sofa-front',         pos: { x:  0.0,  z:  3.5 }, rot: 0, movable: true },
  { id: 'armchair-left-0',       kind: 'armchair-left',      pos: { x: -4.5,  z: -3.5 }, rot: 0, movable: true },
  { id: 'armchair-left-1',       kind: 'armchair-left',      pos: { x: -4.5,  z: -1.5 }, rot: 0, movable: true },
  { id: 'armchair-left-2',       kind: 'armchair-left',      pos: { x: -4.5,  z:  0.5 }, rot: 0, movable: true },
  { id: 'armchair-left-3',       kind: 'armchair-left',      pos: { x: -4.5,  z:  2.5 }, rot: 0, movable: true },
  { id: 'armchair-right-0',      kind: 'armchair-right',     pos: { x:  4.5,  z: -3.5 }, rot: 0, movable: true },
  { id: 'armchair-right-1',      kind: 'armchair-right',     pos: { x:  4.5,  z: -1.5 }, rot: 0, movable: true },
  { id: 'armchair-right-2',      kind: 'armchair-right',     pos: { x:  4.5,  z:  0.5 }, rot: 0, movable: true },
  { id: 'armchair-right-3',      kind: 'armchair-right',     pos: { x:  4.5,  z:  2.5 }, rot: 0, movable: true },
  { id: 'coffee-table-back',     kind: 'coffee-table-back',  pos: { x:  0.0,  z: -3.5 }, rot: 0, movable: true },
  { id: 'coffee-table-front',    kind: 'coffee-table-front', pos: { x:  0.0,  z:  1.5 }, rot: 0, movable: true },
  // Bar obstacle covers the 1x2-tile stool strip (parity with original list).
  { id: 'bar-corner',            kind: 'bar-corner',         pos: { x:  5.24, z:  3.10 }, rot: 0, movable: false,
    footprintOverride: { x0: 4.00, z0: 3.00, x1: 5.00, z1: 5.00 } },
  { id: 'lamp-table-back-left',  kind: 'lamp-table',         pos: { x: -4.5,  z: -4.5 }, rot: 0, movable: true },
  { id: 'lamp-table-back-right', kind: 'lamp-table',         pos: { x:  4.5,  z: -4.5 }, rot: 0, movable: true },
  { id: 'lamp-table-front-left', kind: 'lamp-table',         pos: { x: -4.5,  z:  3.5 }, rot: 0, movable: true },
  // Original obstacle sits one tile south of the visual (documented mismatch).
  { id: 'lamp-table-front-right', kind: 'lamp-table',        pos: { x:  4.5,  z:  3.5 }, rot: 0, movable: true,
    footprintOverride: { x0: 4.00, z0: 4.00, x1: 5.00, z1: 5.00 } },
  // Holographic map table (#33 M4) in the fireplace-wall map nook: 2×2 box
  // x[1,3] z[-5,-3], EDGE-FLUSH with the fireplace wall (z=-5) and the back
  // coffee table (x=1). Flush edges matter: the A* grid bakes RAW obstacle
  // boxes while the player collides against boxes inflated by PLAYER_R
  // (0.38), so any sub-1.5 m gap between boxes on a through-route is
  // grid-walkable but physically impassable — a permanent wedge trap (the
  // first candidate spot (3,-3) trapped door/seat paths on exactly such a
  // seam against sofa-back). Here every residual gap (east corridor x[3,4]
  // z[-5,-3], west sliver z[-5,-4]) is a DEAD-END nook off the north wall,
  // never a route, and the derived front (2, -2.5) sits in the open
  // z∈(-3,-2) artery. Interior overlaps are dev-asserted below.
  { id: 'map-table',             kind: 'map-table',          pos: { x:  2.0,  z: -4.0 }, rot: 0, movable: true },
  // Decorative items — footprint null, never obstacles.
  { id: 'rug-back',              kind: 'rug-back',           pos: { x:  0.0,  z: -2.0 }, rot: 0, movable: true },
  { id: 'rug-front',             kind: 'rug-front',          pos: { x:  0.0,  z:  3.0 }, rot: 0, movable: true },
  { id: 'cherry-tree-front-left', kind: 'cherry-tree',       pos: { x: -5.0,  z:  4.5 }, rot: 0, movable: true },
  { id: 'cherry-tree-mid-left',  kind: 'cherry-tree',        pos: { x: -5.0,  z:  3.0 }, rot: 0, movable: true }, // moved — bar occupies right-front corner
  { id: 'cherry-tree-back-left', kind: 'cherry-tree',        pos: { x: -4.9,  z: -5.0 }, rot: 0, movable: true },
  { id: 'cherry-tree-back-right', kind: 'cherry-tree',       pos: { x:  4.9,  z: -5.0 }, rot: 0, movable: true },
  { id: 'blossom-pot-back-left', kind: 'blossom-pot',        pos: { x: -4.3,  z: -4.7 }, rot: 0, movable: true },
  { id: 'blossom-pot-back-right', kind: 'blossom-pot',       pos: { x:  4.3,  z: -4.7 }, rot: 0, movable: true },
  { id: 'blossom-pot-front-left', kind: 'blossom-pot',       pos: { x: -3.8,  z:  3.2 }, rot: 0, movable: true },
  { id: 'blossom-pot-front-right', kind: 'blossom-pot',      pos: { x:  3.8,  z:  3.2 }, rot: 0, movable: true },
  // Wall computer on the south interior wall, east of the south door (#33 M1).
  // rot 2 flips the +z-facing screen to face -z into the room. x=1.8 clears
  // the door frame (posts end at |x|=1.0, click box at |x|≤1.0) and the
  // keypad (at x=-1.1 after the door group's rotY=π flip); z=5.97 is the
  // bar back-panel flush-mount plane. Footprint null ⇒ never an obstacle.
  { id: 'wall-computer',         kind: 'wall-computer',      pos: { x:  1.8,  z:  5.97 }, rot: 2, movable: false },
  // Storage trunk on the fireplace wall's west flank (TR2 of #35). The plan's
  // berth-corner suggestion (-2.5, -5.0) overlaps the fireplace obstacle
  // (z[-6,-5]) — verified against itemAabb — so the trunk sits one tile south
  // at (-2.5, -4.5): AABB x[-3,-2] z[-5,-4] touches the hearth at z=-5 without
  // overlap, clear of the back-left lamp table (x[-5,-4] z[-5,-4]) and the
  // back coffee table (x[-1,1] z[-4,-3]). rot 0 = latch face toward +z (into
  // the room); front point (-2.5, -3.5) is a walkable aisle cell.
  { id: 'storage-trunk',         kind: 'storage-trunk',      pos: { x: -2.5,  z: -4.5 }, rot: 0, movable: true },
  // Flippable game table (#45 v1) on the south wall, west of the south door:
  // AABB x[-5,-3] z[5,6], EDGE-FLUSH with the south wall (z=6) so no wall-side
  // sliver exists. Spot chosen against the wedge-trap rule documented on the
  // map-table above (grid bakes RAW boxes, player collides with PLAYER_R-
  // inflated ones): the nearest obstacle, lamp-table-front-left (x[-5,-4]
  // z[3,4]), is a full 1 m away in z — the z[4,5] band between them stays
  // physically passable everywhere (no sub-0.76 m residual), and the corner
  // pocket x[-6,-5] z[4,6] keeps its wide-open east mouth. Clear of the south
  // door (posts/click box |x|≤1.0 — our x1=-3) and of the sofa-front AABB
  // (x[-1.5,1.5] z[3,4]). Front point (-4, 4.5) is open aisle floor; parity:
  // w=2 even → x integer, d=1 odd → z at n+0.5. Overlaps dev-asserted below.
  { id: 'game-table',            kind: 'game-table',         pos: { x: -4.0,  z:  5.5 }, rot: 0, movable: true },
];
// ── TR2 dev-assert: trunk placement must be clear of every other obstacle ────
// Dev-only (plan §TR1 "dev-assert against OBSTACLES at build"). Scoped to the
// trunk rather than a global pairwise check because two PRESERVED legacy boxes
// (bar-corner and lamp-table-front-right footprintOverrides) already overlap
// by design — E1 parity, documented at the top of this file.
function assertPlacementClear(itemId: string): void {
  const item = FURNITURE.find((i) => i.id === itemId);
  const box = item ? itemAabb(item) : null;
  if (!box) return;
  for (const other of FURNITURE) {
    if (other.id === itemId) continue;
    const ob = itemAabb(other);
    if (!ob) continue;
    if (box.x0 < ob.x1 && box.x1 > ob.x0 && box.z0 < ob.z1 && box.z1 > ob.z0) {
      console.error(
        `[furniture] '${itemId}' footprint ${JSON.stringify(box)} overlaps '${other.id}' ${JSON.stringify(ob)}`,
      );
    }
  }
}
if (import.meta.env.DEV) assertPlacementClear('storage-trunk');
if (import.meta.env.DEV) assertPlacementClear('map-table');
if (import.meta.env.DEV) assertPlacementClear('game-table');


// ── Derivation helpers ────────────────────────────────────────────────────────

/** Rotate a local XZ offset by quarter-turns CCW about +y (exact — no FP drift). */
function rotXZ(x: number, z: number, rot: Rot): { x: number; z: number } {
  switch (rot) {
    case 0: return { x, z };
    case 1: return { x: z, z: -x };
    case 2: return { x: -x, z: -z };
    case 3: return { x: -z, z: x };
  }
}

/**
 * Footprint-derived world AABB for a kind as if placed at (pos, rot) —
 * IGNORING any per-item footprintOverride. This is the candidate box the
 * move-furniture validity check (E3) probes with: a MOVED item sheds its
 * hand-authored world-space override (the override encoded the ORIGINAL
 * legacy obstacle; after a move the derived footprint, which matches the
 * visual, is the honest obstacle).
 */
export function footprintAabb(
  kind: FurnitureKind,
  pos: { x: number; z: number },
  rot: Rot,
): Box | null {
  const fp = FURNITURE_DEFS[kind].footprint;
  if (!fp) return null;
  const rotated = rot % 2 === 1;
  const hw = (rotated ? fp.d : fp.w) / 2;
  const hd = (rotated ? fp.w : fp.d) / 2;
  return {
    x0: pos.x - hw, z0: pos.z - hd,
    x1: pos.x + hw, z1: pos.z + hd,
  };
}

/** World-space obstacle AABB for one item, or null for decorative items. */
export function itemAabb(item: FurnitureItem): Box | null {
  if (item.footprintOverride !== undefined) return item.footprintOverride;
  return footprintAabb(item.kind, item.pos, item.rot);
}

/**
 * Snap a candidate centre to the placement lattice (plan §2.6 parity rule):
 * footprint tile-extents are integers, so per axis an ODD tile-extent puts
 * the centre at n+0.5 and an EVEN extent at integer n (rot swaps which
 * extent rules which axis). Items without a footprint (rugs, cherry trees,
 * blossom pots — never obstacles) snap to the plain 0.5 m half-grid.
 *
 * Known parity wart (documented, not fixed): the two sofas' DEFAULT x=0.0
 * sits on the even lattice while their w=3 parity prefers n+0.5 — a moved
 * sofa therefore lands tile-aligned (x at n+0.5) rather than back on the
 * legacy half-tile-offset column. Esc-cancel always restores the exact
 * original position regardless.
 */
export function snapItemPos(
  kind: FurnitureKind,
  rot: Rot,
  x: number,
  z: number,
): { x: number; z: number } {
  const fp = FURNITURE_DEFS[kind].footprint;
  if (!fp) {
    return { x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2 };
  }
  const rotated = rot % 2 === 1;
  const extentX = rotated ? fp.d : fp.w;
  const extentZ = rotated ? fp.w : fp.d;
  const snapAxis = (v: number, extent: number) =>
    Math.round(extent) % 2 === 1 ? Math.floor(v) + 0.5 : Math.round(v);
  return { x: snapAxis(x, extentX), z: snapAxis(z, extentZ) };
}

/** Derive the collision obstacle list (order = FURNITURE order). */
export function buildObstacleList(items: FurnitureItem[]): Box[] {
  const boxes: Box[] = [];
  for (const item of items) {
    const box = itemAabb(item);
    if (box) boxes.push(box);
  }
  return boxes;
}

/**
 * Derive the world-space Seat list. `isWalkable(x, z)` samples the baked
 * pathfinding grid: when a seat's preferred front point is walkable it is
 * used EXACTLY (reproducing every current hand-authored front); otherwise the
 * nearest walkable cell centre around the item's footprint is substituted.
 */
export function buildSeatList(
  items: FurnitureItem[],
  isWalkable: (x: number, z: number) => boolean,
): Seat[] {
  const seats: Seat[] = [];
  for (const item of items) {
    const templates = FURNITURE_DEFS[item.kind].seats;
    if (!templates) continue;
    templates.forEach((t, n) => {
      const sit = rotXZ(t.sit.x, t.sit.z, item.rot);
      const fr  = rotXZ(t.front.x, t.front.z, item.rot);
      const c0  = rotXZ(t.clickBox.x0, t.clickBox.z0, item.rot);
      const c1  = rotXZ(t.clickBox.x1, t.clickBox.z1, item.rot);
      const preferred = { x: item.pos.x + fr.x, z: item.pos.z + fr.z };
      seats.push({
        id: `${item.id}:${n}`,
        clickBox: {
          x0: item.pos.x + Math.min(c0.x, c1.x), z0: item.pos.z + Math.min(c0.z, c1.z),
          x1: item.pos.x + Math.max(c0.x, c1.x), z1: item.pos.z + Math.max(c0.z, c1.z),
        },
        front: computeFront(preferred, itemAabb(item), isWalkable),
        sit: { x: item.pos.x + sit.x, z: item.pos.z + sit.z },
        faceAngle: t.faceAngle + item.rot * (Math.PI / 2),
      });
    });
  }
  return seats;
}

/**
 * Derive the world-space DeviceTarget list (#33 D0 — mirrors buildSeatList:
 * same rotXZ rotation + computeFront walkable-fallback). faceAngle is TOWARD
 * the device (opposite of the seats' back-to-chair convention); eye/anchor y
 * is absolute height, x/z rotate with the item.
 */
export function buildDeviceList(
  items: FurnitureItem[],
  isWalkable: (x: number, z: number) => boolean,
): DeviceTarget[] {
  const devices: DeviceTarget[] = [];
  for (const item of items) {
    const t = FURNITURE_DEFS[item.kind].device;
    if (!t) continue;
    const fr = rotXZ(t.front.x, t.front.z, item.rot);
    const eye = rotXZ(t.eye.x, t.eye.z, item.rot);
    const anchor = rotXZ(t.anchor.x, t.anchor.z, item.rot);
    const preferred = { x: item.pos.x + fr.x, z: item.pos.z + fr.z };
    devices.push({
      id: item.id,
      kind: t.kind,
      front: computeFront(preferred, itemAabb(item), isWalkable),
      faceAngle: normalizeAngle(t.faceAngle + item.rot * (Math.PI / 2)),
      eye: new THREE.Vector3(item.pos.x + eye.x, t.eye.y, item.pos.z + eye.z),
      anchor: new THREE.Vector3(item.pos.x + anchor.x, t.anchor.y, item.pos.z + anchor.z),
    });
  }
  return devices;
}

/** Wrap an angle to (-π, π] so rotated facings stay in canonical range. */
function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle <= -Math.PI) angle += Math.PI * 2;
  return angle;
}

/** Pathfinding cell size (kept in sync with pathfinding.ts CELL_SIZE). */
const CELL = 0.5;

/**
 * Preferred front point if its grid cell is walkable, else the walkable cell
 * centre nearest to it in a band around the item footprint. The fallback is
 * dormant in the default layout (every hand-authored front is walkable) —
 * it exists for moved furniture (E3).
 */
function computeFront(
  preferred: { x: number; z: number },
  aabb: Box | null,
  isWalkable: (x: number, z: number) => boolean,
): { x: number; z: number } {
  if (isWalkable(preferred.x, preferred.z)) return preferred;
  if (!aabb) return preferred;
  const cellCentre = (w: number) => (Math.floor(w / CELL) + 0.5) * CELL;
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (let wx = cellCentre(aabb.x0 - 1.25); wx <= aabb.x1 + 1.25; wx += CELL) {
    for (let wz = cellCentre(aabb.z0 - 1.25); wz <= aabb.z1 + 1.25; wz += CELL) {
      // Skip cells whose centre is inside the footprint itself.
      if (wx > aabb.x0 && wx < aabb.x1 && wz > aabb.z0 && wz < aabb.z1) continue;
      if (!isWalkable(wx, wz)) continue;
      const d = (wx - preferred.x) ** 2 + (wz - preferred.z) ** 2;
      if (d < bestD) { bestD = d; best = { x: wx, z: wz }; }
    }
  }
  return best ?? preferred;
}

// ── Visual construction ───────────────────────────────────────────────────────

/**
 * Build one furniture item as a THREE.Group positioned/rotated per the item.
 * Meshes start fully transparent (opacity 0) for the morph fade-in; point
 * lights carry their fade target in userData.targetIntensity.
 */
export function buildItemGroup(item: FurnitureItem): THREE.Group {
  const group = new THREE.Group();
  const ctx: BuildCtx = {
    m: (color, rough = 0.72, metal = 0.06, em = 0x000000, emI = 0) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: em, emissiveIntensity: emI, transparent: true, opacity: 0 }),
    flat: (color) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 }),
    place: (geo, mat, x, y, z, ry = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      group.add(mesh);
      return mesh;
    },
    addLight: (light, x, y, z, targetIntensity) => {
      light.position.set(x, y, z);
      light.userData.targetIntensity = targetIntensity;
      group.add(light);
    },
    attach: (obj) => group.add(obj),
  };
  const def = FURNITURE_DEFS[item.kind];
  def.build(ctx);
  // Device items: tag every mesh so the main.ts raycast pass can route a
  // click anywhere on the prop into world.requestDeviceFocus(item.id).
  if (def.device) {
    group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.userData.isDevice = true;
        obj.userData.deviceId = item.id;
      }
    });
  }
  group.name = item.id;
  group.position.set(item.pos.x, 0, item.pos.z);
  group.rotation.y = item.rot * (Math.PI / 2);
  return group;
}
