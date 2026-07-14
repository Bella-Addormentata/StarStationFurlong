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
import type { DeviceTarget, DeviceTemplate, WallComputerStatus, WallScreenHandle } from './devices';

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
  | 'map-table';

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
];

// ── Placement dev-assert (M4): the map table must occupy a genuinely clear
// 2×2 — its AABB interior may not intersect any other item's obstacle box.
// Scoped to the map table only: two LEGACY boxes deliberately overlap (bar
// strip vs front-right lamp override, preserved E1 parity), so an all-pairs
// assert would fire on hand-authored history rather than new mistakes.
{
  const table = FURNITURE.find((i) => i.kind === 'map-table');
  const a = table ? itemAabb(table) : null;
  if (table && a) {
    for (const other of FURNITURE) {
      if (other === table) continue;
      const b = itemAabb(other);
      if (!b) continue;
      const overlaps = a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
      console.assert(!overlaps,
        `[furniture] map-table footprint overlaps '${other.id}' — move one of them`);
    }
  }
}

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

/** World-space obstacle AABB for one item, or null for decorative items. */
export function itemAabb(item: FurnitureItem): Box | null {
  if (item.footprintOverride !== undefined) return item.footprintOverride;
  const fp = FURNITURE_DEFS[item.kind].footprint;
  if (!fp) return null;
  const rotated = item.rot % 2 === 1;
  const hw = (rotated ? fp.d : fp.w) / 2;
  const hd = (rotated ? fp.w : fp.d) / 2;
  return {
    x0: item.pos.x - hw, z0: item.pos.z - hd,
    x1: item.pos.x + hw, z1: item.pos.z + hd,
  };
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
