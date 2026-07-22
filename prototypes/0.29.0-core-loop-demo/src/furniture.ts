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

import * as THREE from "three";
import type { Seat } from "./seats";
import type {
  DeviceTarget,
  DeviceTemplate,
  WallComputerStatus,
  WallScreenHandle,
  TrunkLidHandle,
  GameTableTopHandle,
  CloneVatHandle,
} from "./devices";
// 🎰 #69: the in-world roulette wheel disc is painted with the REAL pocket
// order/colors from the pure engine — one source of truth with the focused UI.
import { WHEEL_ORDER, pocketColor } from "./games/roulette";

// ── Shared XZ-plane AABB type (re-exported by obstacles.ts) ───────────────────
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Quarter-turns CCW about +y. All E1 items are rot 0 (today's layout). */
export type Rot = 0 | 1 | 2 | 3;

export type FurnitureKind =
  | "fireplace-wall"
  | "sofa-back"
  | "sofa-front"
  | "armchair-left"
  | "armchair-right"
  | "coffee-table-back"
  | "coffee-table-front"
  | "bar-corner"
  | "lamp-table"
  | "rug-back"
  | "rug-front"
  | "cherry-tree"
  | "blossom-pot"
  | "wall-computer"
  | "map-table"
  | "storage-trunk"
  | "game-table"
  | "fuel-tank"
  | "engine-block"
  | "helm-console"
  | "brick-wall"
  | "window-wall"
  | "cashier-atm"
  | "roulette-table"
  | "casino-booth"
  | "casino-gold-wall"
  | "casino-orb-lamp"
  | "chandelier"
  | "pendant-lamp"
  | "paper-lantern"
  | "neon-ring"
  | "sun-lamp"
  | "skylight"
  | "charging-dock"
  | "lazy-pool"
  | "hot-tub"
  | "classic-pool"
  | "classic-hot-tub"
  | "bunk-bed"
  | "clone-vat";

export interface FurnitureItem {
  id: string;
  kind: FurnitureKind;
  pos: { x: number; z: number };
  rot: Rot;
  /** false: fixed room structure (wall computer — the edit-mode entry point). */
  movable: boolean;
  /**
   * E1 parity escape hatch: when present, this exact box is used as the
   * obstacle instead of the footprint-derived AABB (null ⇒ no obstacle).
   */
  footprintOverride?: Box | null;
  /**
   * 🛰️ Hull stacking (hull.ts): id of the exterior item this one is mounted
   * ON (tank on tank, engine on the outermost tank). Absent ⇒ on the wall
   * (or interior). `pos` stays world-absolute alongside it — LWW-safe, and
   * an orphaned child (parent removed by a racing peer) keeps a valid pose.
   */
  mountParent?: string;
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
  /**
   * 🛏️ Avatar-root HEIGHT while on the seat (metres above the floor) — bunk
   * mattress tops. Default 0 (every ground-level chair/sofa seat).
   */
  sitY?: number;
  /**
   * 🛏️ true ⇒ the occupant LIES DOWN (rig 'sleep' pose) instead of sitting.
   * Head points OPPOSITE the faceAngle direction (the recline tips backward),
   * so faceAngle = the feet-ward axis of the berth.
   */
  lie?: boolean;
  /** 🏊 true ⇒ the occupant renders the 'swim' pose (pool water seats). */
  swim?: boolean;
  /**
   * 🏊‍♂️ true ⇒ this seat is a high-dive launch pad: clicking a swim seat of
   * the SAME item while seated here triggers a parabolic dive instead of the
   * usual stand-up-and-walk (see player.ts DIVE phase).
   */
  dive?: boolean;
}

/**
 * 🎰 A designated STANDING position at a table (#76) — authored in the item's
 * LOCAL rot-0 frame, like SeatTemplate. Unlike a seat there is no sit slide:
 * the avatar just walks to the point and faces the table. Multiple stands ring
 * one table (roulette: 6, chess: 2) so several players can gather.
 */
export interface StandTemplate {
  /** Stand-point offset in the item's local rot-0 frame. */
  stand: { x: number; z: number };
  /** World facing while standing (atan2(nx,nz): +z=0, +x=π/2, -z=π, -x=-π/2)
   *  — points TOWARD the table. */
  faceAngle: number;
  /** 🎰 'wheelHead' = the spin position, reserved for the room owner or the
   *  owner's robot (see #76 / #77). Regular stands are open to anyone. */
  role?: "wheelHead";
}

/** A StandTemplate derived into world space (see buildStandList). */
export interface StandSlot {
  id: string;
  front: { x: number; z: number };
  faceAngle: number;
  role?: "wheelHead";
}

/** Build-time helpers bound to the item's group (all coordinates local). */
export interface BuildCtx {
  m: (
    color: number,
    rough?: number,
    metal?: number,
    em?: number,
    emI?: number,
  ) => THREE.MeshStandardMaterial;
  flat: (color: number) => THREE.MeshBasicMaterial;
  place: (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    ry?: number,
  ) => THREE.Mesh;
  addLight: (
    light: THREE.PointLight,
    x: number,
    y: number,
    z: number,
    targetIntensity: number,
  ) => void;
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
  /** 🎰 Designated standing positions ringing a table (#76) — see StandTemplate.
   *  Present on the game tables (roulette, chess). */
  stands?: StandTemplate[];
  /** Capability tags — #30 plan §1.2: capabilities = function-tagged furniture. */
  functions?: string[];
  /**
   * Device-focus template (local frame, rot 0) — items whose def carries one
   * become clickable focus targets via buildDeviceList() (#33 D0).
   */
  device?: DeviceTemplate;
  /**
   * 🚀 Placement mode (owner request — exterior fittings). 'exterior-wall'
   * items mount on the OUTSIDE of a room wall (main engines; future solar
   * panels / manipulator arm use the same mode): they snap to the outer wall
   * lines via snapExteriorPos (rot derived from the wall — local +z, the
   * business end, points AWAY from the room), edit-mode carry + validation
   * route to validateExteriorPlacement, and their AABB lies wholly outside
   * the walkable square so they never obstruct the interior. Absent ⇒ the
   * normal interior floor placement. 'both' (🛰️ hull work): the kind places
   * on the interior floor by default AND accepts hull mounting — fuel tanks
   * live either side of the wall.
   */
  mount?: "exterior-wall" | "both";
  /**
   * 🛰️ Hull stacking rules (hull.ts): what this kind can sit on out there
   * ('wall' and/or a face another item provides), and the face its own outer
   * side offers. Capability-tag style, like `functions`: a tank accepts
   * wall|tankFace and provides tankFace; an engine accepts both but provides
   * nothing (bells stay outermost).
   */
  attach?: { accepts: Array<"wall" | "tankFace">; provides?: "tankFace" };
}

// ── Warm frontier colour palette (moved from world.addLobbyFurniture) ─────────
const CREAM = 0xfaf0e0; // warm linen white (sofa)
const LINEN = 0xf5e8d2; // warm ivory (cushions)
const BEIGE = 0xe8d8c4; // warm taupe (armrests)
const WOOD = 0xc8924e; // honey golden wood
const DKWOOD = 0xf0f0f0; // white (bookshelves / cabinets)
const STONE = 0xffffff; // pure white (fireplace)
const TERRA = 0xd87a48; // light terracotta (pots)
const PK1 = 0xffb7c5; // cherry blossom light pink
const PK2 = 0xff8fab; // cherry blossom mid pink
const PK3 = 0xffd6e0; // cherry blossom pale pink
const RUG_A = 0xd4905e; // rug warm rust (lighter)
const RUG_B = 0xbc7848; // rug border

// ── Builders ──────────────────────────────────────────────────────────────────
// Geometry, materials and offsets are verbatim from the original
// world.addLobbyFurniture() (positions rebased to the item origin).

// Small potted cherry blossom — shared by 'blossom-pot' and the bar corner.
const roundPlant = (ctx: BuildCtx, px: number, py: number, pz: number) => {
  ctx.place(
    new THREE.CylinderGeometry(0.11, 0.08, 0.17, 12),
    ctx.m(TERRA, 0.85, 0.07),
    px,
    py + 0.085,
    pz,
  );
  ctx.place(
    new THREE.SphereGeometry(0.16, 10, 10),
    ctx.m(PK1, 0.88, 0.02),
    px,
    py + 0.27,
    pz,
  );
  ctx.place(
    new THREE.SphereGeometry(0.12, 10, 10),
    ctx.m(PK3, 0.84, 0.02),
    px + 0.1,
    py + 0.23,
    pz + 0.05,
  );
};

// Rug stacks — 3 layers each, slight y stagger avoids z-fighting.
const buildRugBack = ({ m, place }: BuildCtx) => {
  place(
    new THREE.BoxGeometry(8.0, 0.018, 6.0),
    m(RUG_A, 0.98, 0.0),
    0,
    0.009,
    0,
  );
  place(
    new THREE.BoxGeometry(7.6, 0.02, 5.6),
    m(RUG_B, 0.98, 0.0),
    0,
    0.011,
    0,
  );
  place(
    new THREE.BoxGeometry(7.2, 0.022, 5.2),
    m(0xe8a878, 0.98, 0.0),
    0,
    0.013,
    0,
  );
};
const buildRugFront = ({ m, place }: BuildCtx) => {
  place(
    new THREE.BoxGeometry(6.0, 0.018, 4.0),
    m(0xd4b090, 0.98, 0.0),
    0,
    0.009,
    0,
  );
  place(
    new THREE.BoxGeometry(5.6, 0.02, 3.6),
    m(0xbc9878, 0.98, 0.0),
    0,
    0.011,
    0,
  );
  place(
    new THREE.BoxGeometry(5.2, 0.022, 3.2),
    m(0xe0c8a8, 0.98, 0.0),
    0,
    0.013,
    0,
  );
};

// Integrated fireplace + bookcase wall (composite, movable: false).
// Layout: [bookcase SW=2.90] [stone pillar PW=0.52] [opening FW=2.60] [pillar] [bookcase]
const buildFireplaceWall = (ctx: BuildCtx) => {
  const { m, flat, place, addLight } = ctx;
  const FZ = -0.05; // front face z, local (item at z=-5.5 → world -5.55)
  const UH = 2.65; // body height
  const UD = 0.46; // depth
  const FW = 2.6; // opening interior width
  const FH = 1.82; // opening interior height
  const PW = 0.52; // stone pillar width
  const SW = 2.9; // bookcase panel width each side
  const BX = FW / 2 + PW + SW / 2; // bookcase centre x ≈ 3.27
  const CW = (BX + SW / 2) * 2 + 0.18; // cornice full width ≈ 9.62
  const MT = UH + 0.26; // mantle shelf top surface y ≈ 2.91
  const OMH = UH - FH - 0.28; // overmantel height ≈ 0.55

  // Continuous base plinth
  place(
    new THREE.BoxGeometry(CW, 0.13, UD + 0.14),
    m(0xf5f5f5, 0.82, 0.04),
    0,
    0.065,
    FZ,
  );

  // Left & right bookcase bodies
  place(
    new THREE.BoxGeometry(SW, UH, UD),
    m(DKWOOD, 0.82, 0.04),
    -BX,
    UH / 2,
    FZ,
  );
  place(
    new THREE.BoxGeometry(SW, UH, UD),
    m(DKWOOD, 0.82, 0.04),
    BX,
    UH / 2,
    FZ,
  );

  // White stone pillars flanking opening
  place(
    new THREE.BoxGeometry(PW, UH, UD),
    m(STONE, 0.9, 0.04),
    -(FW / 2 + PW / 2),
    UH / 2,
    FZ,
  );
  place(
    new THREE.BoxGeometry(PW, UH, UD),
    m(STONE, 0.9, 0.04),
    FW / 2 + PW / 2,
    UH / 2,
    FZ,
  );

  // Hearth floor slab (slight forward projection)
  place(
    new THREE.BoxGeometry(FW + 0.22, 0.07, UD + 0.14),
    m(STONE, 0.85, 0.05),
    0,
    0.035,
    FZ,
  );

  // Lintel above opening
  place(
    new THREE.BoxGeometry(FW + PW * 2, 0.28, UD),
    m(STONE, 0.88, 0.05),
    0,
    FH + 0.14,
    FZ,
  );

  // Overmantel infill (above lintel up to top)
  place(
    new THREE.BoxGeometry(FW + PW * 2, OMH, UD),
    m(STONE, 0.92, 0.03),
    0,
    FH + 0.28 + OMH / 2,
    FZ,
  );

  // Dark fireback (recessed, fire panels render in front)
  place(
    new THREE.BoxGeometry(FW - 0.08, FH - 0.04, 0.06),
    m(0x190d04, 0.96, 0.04),
    0,
    FH / 2,
    FZ - UD / 2 + 0.03,
  );

  // Fire layers — self-illuminated
  place(
    new THREE.BoxGeometry(2.06, 1.06, 0.04),
    flat(0xff3200),
    0,
    0.62,
    FZ - 0.02,
  );
  place(
    new THREE.BoxGeometry(1.52, 0.9, 0.04),
    flat(0xff6600),
    0,
    0.71,
    FZ - 0.015,
  );
  place(
    new THREE.BoxGeometry(0.98, 0.7, 0.04),
    flat(0xffaa00),
    0,
    0.83,
    FZ - 0.01,
  );
  place(
    new THREE.BoxGeometry(0.52, 0.48, 0.04),
    flat(0xffe030),
    0,
    0.99,
    FZ - 0.005,
  );
  place(new THREE.BoxGeometry(0.24, 0.28, 0.04), flat(0xfffbb0), 0, 1.14, FZ);

  // Logs
  place(
    new THREE.CylinderGeometry(0.1, 0.1, 2.1, 8),
    m(0x5a2812, 0.9, 0.04),
    0,
    0.14,
    FZ,
    Math.PI * 0.5,
  );
  place(
    new THREE.CylinderGeometry(0.08, 0.08, 1.8, 8),
    m(0x5a2812, 0.9, 0.04),
    0.2,
    0.22,
    FZ,
    Math.PI * 0.5 + 0.3,
  );

  // Top cornice (full span + overhang)
  place(
    new THREE.BoxGeometry(CW, 0.16, UD + 0.22),
    m(0xf8f8f8, 0.78, 0.06),
    0,
    UH + 0.08,
    FZ,
  );

  // Mantle shelf (projects forward slightly)
  place(
    new THREE.BoxGeometry(CW, 0.1, UD + 0.28),
    m(WOOD, 0.5, 0.2),
    0,
    UH + 0.21,
    FZ + 0.04,
  );

  // Bookcase shelf boards — 3 per side
  const shelfW = SW - 0.06;
  ([0.56, 1.2, 1.84] as number[]).forEach((ys) => {
    place(
      new THREE.BoxGeometry(shelfW, 0.04, UD - 0.06),
      m(0xe8e8e8, 0.72, 0.04),
      -BX,
      ys,
      FZ,
    );
    place(
      new THREE.BoxGeometry(shelfW, 0.04, UD - 0.06),
      m(0xe8e8e8, 0.72, 0.04),
      BX,
      ys,
      FZ,
    );
  });

  // Books on shelves
  const wallBks1: [number, number][] = [
    [0xd09070, 0.13],
    [0x6888a8, 0.11],
    [0x78a868, 0.12],
    [0xd0b048, 0.11],
    [0x9068a0, 0.1],
    [0xc05050, 0.12],
    [0x5a90b8, 0.11],
    [0xb07848, 0.11],
  ];
  const wallBks2: [number, number][] = [
    [0x70a880, 0.12],
    [0xc08048, 0.11],
    [0x5880b0, 0.13],
    [0xa8b068, 0.11],
    [0xd07868, 0.13],
    [0x8070a0, 0.11],
    [0xc09050, 0.12],
    [0x7090a8, 0.1],
  ];
  const wallBks3: [number, number][] = [
    [0x9870b0, 0.11],
    [0xd08858, 0.12],
    [0x60a890, 0.12],
    [0xb8a048, 0.11],
    [0xa06070, 0.13],
    [0x7888c0, 0.12],
    [0x90b070, 0.12],
  ];
  const placeWallBooks = (
    cx: number,
    shelfY: number,
    books: [number, number][],
    bookH: number,
  ) => {
    let bo = cx - SW / 2 + 0.05;
    books.forEach(([c, w]) => {
      place(
        new THREE.BoxGeometry(w, bookH, 0.26),
        m(c, 0.8, 0.04),
        bo + w / 2,
        shelfY + bookH / 2 + 0.04,
        FZ + 0.01,
      );
      bo += w + 0.01;
    });
  };
  placeWallBooks(-BX, 0.56, wallBks1, 0.26);
  placeWallBooks(BX, 0.56, wallBks1, 0.28);
  placeWallBooks(-BX, 1.2, wallBks2, 0.22);
  placeWallBooks(BX, 1.2, wallBks2, 0.24);
  placeWallBooks(-BX, 1.84, wallBks3, 0.2);
  placeWallBooks(BX, 1.84, wallBks3, 0.22);

  // Candles on mantle
  place(
    new THREE.CylinderGeometry(0.05, 0.038, 0.34, 10),
    m(0xf8e8b0, 0.45, 0.1),
    -1.35,
    MT + 0.17,
    FZ + 0.1,
  );
  place(
    new THREE.CylinderGeometry(0.05, 0.038, 0.34, 10),
    m(0xf8e8b0, 0.45, 0.1),
    1.35,
    MT + 0.17,
    FZ + 0.1,
  );
  place(
    new THREE.SphereGeometry(0.028, 8, 8),
    flat(0xffee88),
    -1.35,
    MT + 0.37,
    FZ + 0.1,
  );
  place(
    new THREE.SphereGeometry(0.028, 8, 8),
    flat(0xffee88),
    1.35,
    MT + 0.37,
    FZ + 0.1,
  );
  // Mantle vase with cherry blossom
  place(
    new THREE.CylinderGeometry(0.13, 0.09, 0.3, 14),
    m(0x90b8a8, 0.42, 0.38),
    0,
    MT + 0.15,
    FZ + 0.1,
  );
  place(
    new THREE.SphereGeometry(0.09, 10, 10),
    m(PK1, 0.88, 0.02),
    0,
    MT + 0.39,
    FZ + 0.08,
  );
  // Fire and candle lights
  addLight(new THREE.PointLight(0xff7a30, 0, 14), 0, 1.2, FZ + 1.0, 2.8);
  addLight(
    new THREE.PointLight(0xffcc66, 0, 5),
    -1.35,
    MT + 0.5,
    FZ + 0.4,
    0.6,
  );
  addLight(new THREE.PointLight(0xffcc66, 0, 5), 1.35, MT + 0.5, FZ + 0.4, 0.6);
};

// Wall armchair — backDir: -1 backrest toward x=-6 (faces +x), +1 toward x=+6.
const buildArmchair =
  (backDir: number) =>
  ({ m, place }: BuildCtx) => {
    place(
      new THREE.BoxGeometry(0.92, 0.24, 0.92),
      m(CREAM, 0.82, 0.05),
      0,
      0.22,
      0,
    );
    place(
      new THREE.BoxGeometry(0.22, 0.66, 0.92),
      m(CREAM, 0.82, 0.05),
      backDir * 0.46,
      0.71,
      0,
    );
    place(
      new THREE.BoxGeometry(0.92, 0.46, 0.22),
      m(BEIGE, 0.78, 0.06),
      0,
      0.45,
      -0.46,
    );
    place(
      new THREE.BoxGeometry(0.92, 0.46, 0.22),
      m(BEIGE, 0.78, 0.06),
      0,
      0.45,
      0.46,
    );
    place(
      new THREE.BoxGeometry(0.76, 0.13, 0.76),
      m(LINEN, 0.85, 0.04),
      0,
      0.39,
      0,
    );
    place(
      new THREE.BoxGeometry(0.13, 0.44, 0.76),
      m(LINEN, 0.85, 0.04),
      backDir * 0.39,
      0.64,
      0,
    );
    (
      [
        [0.34, -0.35],
        [0.34, 0.35],
        [-0.34, -0.35],
        [-0.34, 0.35],
      ] as [number, number][]
    ).forEach(([dx, dz]) =>
      place(
        new THREE.CylinderGeometry(0.038, 0.038, 0.15, 8),
        m(WOOD, 0.45, 0.25),
        dx,
        0.075,
        dz,
      ),
    );
  };

// 3-seater sofa core (both lobby sofas use faceZ = -1 — backrest on the -z side)
// plus the coloured throw cushions that previously lived in addAtmosphereEffects.
const buildSofa3 =
  (cushions: Array<[number, number, number]>) =>
  ({ m, place }: BuildCtx) => {
    const faceZ = -1;
    place(
      new THREE.BoxGeometry(2.4, 0.24, 0.96),
      m(CREAM, 0.82, 0.05),
      0,
      0.22,
      0,
    );
    place(
      new THREE.BoxGeometry(2.4, 0.66, 0.22),
      m(CREAM, 0.82, 0.05),
      0,
      0.71,
      faceZ * 0.46,
    ); // backrest
    place(
      new THREE.BoxGeometry(0.24, 0.46, 0.96),
      m(BEIGE, 0.78, 0.06),
      -1.2,
      0.45,
      0,
    );
    place(
      new THREE.BoxGeometry(0.24, 0.46, 0.96),
      m(BEIGE, 0.78, 0.06),
      1.2,
      0.45,
      0,
    );
    ([-0.74, 0, 0.74] as number[]).forEach((dx) =>
      place(
        new THREE.BoxGeometry(0.72, 0.13, 0.82),
        m(LINEN, 0.85, 0.04),
        dx,
        0.39,
        0,
      ),
    );
    ([-0.74, 0, 0.74] as number[]).forEach((dx) =>
      place(
        new THREE.BoxGeometry(0.68, 0.44, 0.22),
        m(LINEN, 0.85, 0.04),
        dx,
        0.64,
        faceZ * 0.39,
      ),
    );
    (
      [
        [1.06, 0.39],
        [1.06, -0.39],
        [-1.06, 0.39],
        [-1.06, -0.39],
      ] as [number, number][]
    ).forEach(([dx, dz]) =>
      place(
        new THREE.CylinderGeometry(0.042, 0.042, 0.15, 8),
        m(WOOD, 0.45, 0.25),
        dx,
        0.075,
        dz,
      ),
    );
    // Coloured throw cushions [dx, dz, colour]
    cushions.forEach(([dx, dz, col]) =>
      place(
        new THREE.BoxGeometry(0.6, 0.09, 0.6),
        m(col, 0.82, 0.02),
        dx,
        0.47,
        dz,
      ),
    );
  };

// Coffee tables — shared frame, per-zone décor (verbatim from original).
const coffeeTableFrame = ({ m, place }: BuildCtx) => {
  place(new THREE.BoxGeometry(2.0, 0.06, 1.0), m(WOOD, 0.4, 0.22), 0, 0.37, 0);
  (
    [
      [0.9, 0.38],
      [0.9, -0.38],
      [-0.9, 0.38],
      [-0.9, -0.38],
    ] as [number, number][]
  ).forEach(([lx, lz]) =>
    place(
      new THREE.BoxGeometry(0.06, 0.32, 0.06),
      m(WOOD, 0.45, 0.2),
      lx,
      0.16,
      lz,
    ),
  );
};
const buildCoffeeTableBack = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  coffeeTableFrame(ctx);
  place(
    new THREE.CylinderGeometry(0.06, 0.048, 0.08, 12),
    m(TERRA, 0.85, 0.08),
    -0.4,
    0.44,
    0,
  );
  place(
    new THREE.SphereGeometry(0.09, 10, 10),
    m(PK1, 0.88, 0.02),
    -0.4,
    0.56,
    0,
  );
  place(
    new THREE.BoxGeometry(0.18, 0.032, 0.12),
    m(0xd09060, 0.8, 0.05),
    0.35,
    0.41,
    0,
  );
  place(
    new THREE.BoxGeometry(0.18, 0.032, 0.12),
    m(0x6a9468, 0.8, 0.05),
    0.35,
    0.443,
    0,
  );
};
const buildCoffeeTableFront = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  coffeeTableFrame(ctx);
  place(
    new THREE.CylinderGeometry(0.05, 0.04, 0.07, 12),
    m(TERRA, 0.85, 0.08),
    -0.3,
    0.44,
    0,
  );
  place(
    new THREE.SphereGeometry(0.08, 10, 10),
    m(PK2, 0.88, 0.02),
    -0.3,
    0.54,
    0,
  );
  place(
    new THREE.BoxGeometry(0.18, 0.032, 0.12),
    m(0xa09060, 0.8, 0.05),
    0.3,
    0.41,
    0,
  );
  place(
    new THREE.BoxGeometry(0.16, 0.032, 0.12),
    m(0x5a90a8, 0.8, 0.05),
    0.3,
    0.442,
    0,
  );
};

// Corner lamp table with shaded lamp + point light.
const buildLampTable = ({ m, place, addLight }: BuildCtx) => {
  place(
    new THREE.CylinderGeometry(0.28, 0.24, 0.048, 18),
    m(WOOD, 0.4, 0.22),
    0,
    0.54,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.038, 0.038, 0.5, 8),
    m(DKWOOD, 0.55, 0.18),
    0,
    0.27,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.17, 0.17, 0.04, 14),
    m(DKWOOD, 0.55, 0.18),
    0,
    0.02,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.055, 0.075, 0.2, 10),
    m(DKWOOD, 0.5, 0.2),
    0,
    0.72,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.18, 0.12, 0.28, 14),
    m(0xf8e8c0, 0.88, 0.02, 0xffd080, 0.55),
    0,
    0.96,
    0,
  );
  addLight(new THREE.PointLight(0xffd080, 0, 7), 0, 1.1, 0, 1.0);
};

const buildCasinoBooth = ({ m, place }: BuildCtx) => {
  const velvet = m(0x981f3f, 0.9, 0.01);
  const velvetDark = m(0x4e0c20, 0.94, 0.01);
  const gold = m(0xf2c258, 0.2, 0.82, 0x8a4808, 0.2);
  place(new THREE.BoxGeometry(1.9, 0.28, 0.92), velvetDark, 0, 0.24, 0);
  place(new THREE.BoxGeometry(1.9, 0.72, 0.24), velvetDark, 0, 0.73, -0.43);
  for (const x of [-0.48, 0.48]) {
    place(new THREE.BoxGeometry(0.82, 0.16, 0.72), velvet, x, 0.45, 0.03);
    place(new THREE.BoxGeometry(0.78, 0.48, 0.16), velvet, x, 0.75, -0.31);
    for (const bx of [-0.2, 0.2]) {
      place(new THREE.SphereGeometry(0.035, 7, 6), gold, x + bx, 0.76, -0.22);
    }
  }
  for (const x of [-0.96, 0.96]) {
    place(new THREE.BoxGeometry(0.16, 0.52, 0.92), gold, x, 0.42, 0);
    place(new THREE.BoxGeometry(0.24, 0.12, 1.0), gold, x, 0.7, 0);
  }
};

const buildCasinoGoldWall = ({ m, place }: BuildCtx) => {
  const gold = m(0xf1bd4f, 0.2, 0.84, 0x713607, 0.16);
  const goldLight = m(0xffdc82, 0.16, 0.76, 0x9e540e, 0.22);
  const lacquer = m(0x140d12, 0.18, 0.38);
  const emerald = m(0x07563f, 0.3, 0.3, 0x063b2c, 0.14);
  const crystal = m(0xffe8a8, 0.08, 0.12, 0xffc85a, 0.65);
  place(new THREE.BoxGeometry(1.6, 2.85, 0.34), lacquer, 0, 1.425, 0);
  place(new THREE.BoxGeometry(1.22, 2.35, 0.4), emerald, 0, 1.43, -0.01);
  for (const y of [0.18, 1.42, 2.68]) {
    place(new THREE.BoxGeometry(1.72, 0.12, 0.45), goldLight, 0, y, 0.02);
  }
  for (const x of [-0.68, 0.68]) {
    place(new THREE.BoxGeometry(0.16, 2.65, 0.48), goldLight, x, 1.38, 0.03);
  }
  place(
    new THREE.CylinderGeometry(0.44, 0.34, 0.25, 12),
    goldLight,
    0,
    2.98,
    0,
  );
  place(new THREE.OctahedronGeometry(0.34, 1), crystal, 0, 3.34, 0);
  place(new THREE.TorusGeometry(0.48, 0.06, 8, 24), gold, 0, 3.34, 0);
};

const buildCasinoOrbLamp = ({ m, place, addLight }: BuildCtx) => {
  const gold = m(0xf2c45d, 0.18, 0.84, 0x874507, 0.2);
  const dark = m(0x1a0d14, 0.2, 0.42);
  place(new THREE.BoxGeometry(0.58, 0.18, 0.58), gold, 0, 0.09, 0);
  place(new THREE.BoxGeometry(0.42, 0.62, 0.42), dark, 0, 0.49, 0);
  place(new THREE.CylinderGeometry(0.1, 0.13, 0.35, 9), gold, 0, 0.95, 0);
  place(
    new THREE.OctahedronGeometry(0.34, 1),
    m(0xffe7a3, 0.08, 0.12, 0xffbd45, 1.0),
    0,
    1.28,
    0,
  );
  place(new THREE.TorusGeometry(0.38, 0.035, 8, 24), gold, 0, 1.28, 0);
  addLight(new THREE.PointLight(0xffc65a, 0, 6), 0, 1.35, 0, 1.8);
};

// 🕯️ Ceiling chandelier — a HANGING light fixture. Footprint null (you walk
// under it), and its meshes live HIGH in the local frame (y ≈ 2.6–4.0) so the
// item's floor x,z drops it above that spot and it dangles from the ~4 m
// ceiling. It carries the room's PRACTICAL light — two warm point lights that
// ride the morph fade-in like every furniture light — turning "room lighting"
// into a placeable, movable object. (The sky/fog backdrop stays a scene-level
// concern; a fixture lights the room, it doesn't repaint the horizon.) The
// candle-bulbs GLOW via emissive material rather than being real lights, so a
// chandelier costs the renderer only 2 lights no matter how ornate it looks.
const buildChandelier = ({ m, place, addLight }: BuildCtx) => {
  const gold = m(0xf2c45d, 0.22, 0.85, 0x6a3d05, 0.22);
  const wax = m(0xfff2dc, 0.6, 0.02);
  const flame = m(0xffe6b0, 0.1, 0.0, 0xffbe55, 1.0);
  const crystal = m(0xdfeeff, 0.05, 0.12, 0x9cc4ff, 0.35);

  // Ceiling canopy + slim suspension rod down to the fixture body.
  place(new THREE.CylinderGeometry(0.2, 0.24, 0.09, 16), gold, 0, 3.95, 0);
  place(new THREE.CylinderGeometry(0.035, 0.035, 0.86, 8), gold, 0, 3.5, 0);

  // Two gold tier rings + a central column and finial.
  place(new THREE.TorusGeometry(0.58, 0.045, 10, 32), gold, 0, 3.05, 0, Math.PI / 2);
  place(new THREE.TorusGeometry(0.36, 0.04, 10, 28), gold, 0, 2.82, 0, Math.PI / 2);
  place(new THREE.CylinderGeometry(0.06, 0.09, 0.42, 12), gold, 0, 2.86, 0);
  place(new THREE.SphereGeometry(0.09, 12, 12), gold, 0, 2.66, 0);

  // Candle-bulbs around each ring (wax cup + emissive flame — no real light).
  const ring = (n: number, radius: number, y: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      place(new THREE.CylinderGeometry(0.035, 0.045, 0.16, 8), wax, x, y + 0.08, z);
      place(new THREE.SphereGeometry(0.05, 8, 8), flame, x, y + 0.2, z);
    }
  };
  ring(8, 0.58, 3.05);
  ring(5, 0.36, 2.82);

  // Crystal drops dangling below the outer ring (glow faintly, not lights).
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    place(new THREE.OctahedronGeometry(0.06, 0), crystal, Math.cos(a) * 0.5, 2.72, Math.sin(a) * 0.5);
  }

  // The actual room lighting: a warm downlight that reaches the walls, plus a
  // soft up-glow so the ceiling around the canopy reads as lit.
  addLight(new THREE.PointLight(0xffd39a, 0, 16), 0, 2.7, 0, 3.4);
  addLight(new THREE.PointLight(0xffb968, 0, 6), 0, 3.6, 0, 0.9);
};

// 🪔 Modern pendant — a slim rod and a shallow metal dome shade with a warm
// glowing underside. Understated; reads "contemporary lounge". Same ceiling-
// hung convention as the chandelier (footprint null, meshes high, one light).
const buildPendantLamp = ({ m, place, addLight }: BuildCtx) => {
  const metal = m(0x2a2f38, 0.35, 0.7);
  const rim = m(0xc9ccd2, 0.3, 0.8);
  const glow = m(0xffe9c4, 0.1, 0.0, 0xffcf87, 1.0);

  place(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 12), metal, 0, 3.95, 0);
  place(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 8), metal, 0, 3.53, 0);
  // Shallow dome shade (cone, wide side down), a bright rim, and the glowing bulb.
  place(new THREE.ConeGeometry(0.52, 0.34, 24, 1, true), metal, 0, 3.16, 0);
  place(new THREE.TorusGeometry(0.5, 0.02, 8, 28), rim, 0, 3.0, 0, Math.PI / 2);
  place(new THREE.SphereGeometry(0.13, 12, 12), glow, 0, 3.05, 0);
  addLight(new THREE.PointLight(0xffd6a0, 0, 13), 0, 2.95, 0, 2.7);
};

// 🏮 Paper lantern — a soft glowing warm globe on a cord. Cheap and cozy; the
// whole ball is emissive so it reads as lit paper even before its gentle light.
const buildPaperLantern = ({ m, place, addLight }: BuildCtx) => {
  const cap = m(0x3b2a1c, 0.6, 0.05);
  const paper = m(0xffe4b0, 0.5, 0.0, 0xffd18a, 0.9);

  place(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6), cap, 0, 3.55, 0);
  place(new THREE.CylinderGeometry(0.09, 0.11, 0.05, 12), cap, 0, 3.2, 0);
  place(new THREE.SphereGeometry(0.4, 18, 14), paper, 0, 2.78, 0);
  place(new THREE.CylinderGeometry(0.09, 0.07, 0.05, 12), cap, 0, 2.38, 0);
  addLight(new THREE.PointLight(0xffca82, 0, 10), 0, 2.78, 0, 1.9);
};

// 🎰 Neon ring — a suspended halo of glowing tube, casino/nightlife energy. Two
// concentric emissive rings (cyan + magenta) and a cool bright ring light.
const buildNeonRing = ({ m, place, addLight }: BuildCtx) => {
  const mount = m(0x14181f, 0.4, 0.6);
  const cyan = m(0x1a3a44, 0.2, 0.1, 0x2fe6ff, 1.4);
  const magenta = m(0x3a1a30, 0.2, 0.1, 0xff4fd8, 1.2);

  place(new THREE.CylinderGeometry(0.14, 0.16, 0.06, 12), mount, 0, 3.95, 0);
  // Three thin drop wires out to the ring so it reads as suspended.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    place(new THREE.CylinderGeometry(0.01, 0.01, 0.95, 6), mount,
      Math.cos(a) * 0.45, 3.5, Math.sin(a) * 0.45);
  }
  place(new THREE.TorusGeometry(0.92, 0.05, 12, 48), cyan, 0, 3.02, 0, Math.PI / 2);
  place(new THREE.TorusGeometry(0.58, 0.04, 12, 40), magenta, 0, 3.02, 0, Math.PI / 2);
  addLight(new THREE.PointLight(0x59e6ff, 0, 15), 0, 2.9, 0, 2.4);
  addLight(new THREE.PointLight(0xff6fdf, 0, 8), 0, 2.9, 0, 1.0);
};

// ☀️ Sun-lamp — a bright, cool-white skylight panel. Unlike the warm fixtures
// this floods the room with DAYLIGHT-temperature light, so a pool or bright
// venue placed in a windowless module still reads as sunlit (the sky backdrop
// stays a scene concern, but the DECK is lit). Big flat emissive panel + frame.
const buildSunLamp = ({ m, place, addLight }: BuildCtx) => {
  const frame = m(0xd8dde4, 0.3, 0.7);
  const panel = m(0xf3f8ff, 0.1, 0.0, 0xeaf3ff, 1.0);

  // Frame border (four bars) + the glowing panel just below the ceiling.
  const B = 0.9;
  place(new THREE.BoxGeometry(2 * B + 0.12, 0.08, 0.12), frame, 0, 3.9, B);
  place(new THREE.BoxGeometry(2 * B + 0.12, 0.08, 0.12), frame, 0, 3.9, -B);
  place(new THREE.BoxGeometry(0.12, 0.08, 2 * B + 0.12), frame, B, 3.9, 0);
  place(new THREE.BoxGeometry(0.12, 0.08, 2 * B + 0.12), frame, -B, 3.9, 0);
  place(new THREE.BoxGeometry(2 * B, 0.05, 2 * B), panel, 0, 3.86, 0);
  // Bright cool daylight flooding down, plus a soft fill.
  addLight(new THREE.PointLight(0xdcebff, 0, 20), 0, 3.6, 0, 5.0);
  addLight(new THREE.PointLight(0xffffff, 0, 10), 0, 2.6, 0, 1.4);
};

// 🪟 Skylight — a REAL structural glass ceiling panel: metal mullion frame with
// a 2×2 pane grid + faint transparent glazing that looks out at the space
// backdrop (nebula + stars + orbiting planet, un-hidden by the outdoor-deck
// theme), plus one warm "sunlight through the glass" flood for the beach feel.
// Footprint null (overhead — you walk right under it). CRITICAL: the glass sets
// material.userData.baseOpacity (NOT raw .opacity) so the morph/reveal keeps it
// translucent instead of snapping it opaque — the latent buildWindowWall bug.
const buildSkylight = ({ m, place, addLight }: BuildCtx) => {
  const frameMat = m(0x9aa6b4, 0.4, 0.72); // hull-slate mullions
  const B = 1.1;
  // Outer frame (four bars) at the ceiling line.
  place(new THREE.BoxGeometry(2 * B + 0.14, 0.1, 0.14), frameMat, 0, 3.92, B);
  place(new THREE.BoxGeometry(2 * B + 0.14, 0.1, 0.14), frameMat, 0, 3.92, -B);
  place(new THREE.BoxGeometry(0.14, 0.1, 2 * B + 0.14), frameMat, B, 3.92, 0);
  place(new THREE.BoxGeometry(0.14, 0.1, 2 * B + 0.14), frameMat, -B, 3.92, 0);
  // Mullion cross-bars → a 2×2 pane grid.
  place(new THREE.BoxGeometry(2 * B, 0.06, 0.06), frameMat, 0, 3.9, 0);
  place(new THREE.BoxGeometry(0.06, 0.06, 2 * B), frameMat, 0, 3.9, 0);
  // The glass: barely-there blue tint, transparent both sides, no depth write —
  // the space view beyond is the point. baseOpacity, never raw opacity.
  const glass = m(0x9bd4e8, 0.05, 0.0, 0x0a1a2a, 0.06);
  glass.side = THREE.DoubleSide;
  glass.depthWrite = false;
  glass.userData.baseOpacity = 0.14;
  place(new THREE.BoxGeometry(2 * B, 0.03, 2 * B), glass, 0, 3.86, 0);
  // Warm flood so the deck reads sunlit even before the backdrop is seen.
  addLight(new THREE.PointLight(0xffe9c4, 0, 22), 0, 3.5, 0, 4.5);
};

// 🔌 Charging dock (#77) — a low pad + a back post with a green charge light
// where the robot servant returns to recharge when idle. Footprint null (a low
// pad you can step over); the bot stands on it. The world hands its world pose
// to the PoolWaiter, which walks here after DOCK_AFTER_SECS of no fox nearby.
const buildChargingDock = ({ m, place }: BuildCtx) => {
  const metal = m(0x3a4048, 0.4, 0.7);
  const dark = m(0x14181e, 0.5, 0.5);
  const glow = m(0x2fe6a0, 0.2, 0.1, 0x2fe6a0, 1.2); // charge-green indicator
  place(new THREE.CylinderGeometry(0.55, 0.62, 0.08, 20), metal, 0, 0.04, 0); // pad
  place(new THREE.CylinderGeometry(0.42, 0.42, 0.02, 20), dark, 0, 0.09, 0); // inlay
  place(new THREE.TorusGeometry(0.34, 0.03, 8, 28), glow, 0, 0.1, 0, Math.PI / 2); // ring
  place(new THREE.BoxGeometry(0.16, 0.92, 0.16), metal, 0, 0.5, -0.5); // post
  place(new THREE.BoxGeometry(0.26, 0.26, 0.03), dark, 0, 0.62, -0.42); // plate
  place(new THREE.BoxGeometry(0.09, 0.18, 0.05), glow, -0.03, 0.66, -0.4); // ⚡ bolt
  place(new THREE.BoxGeometry(0.09, 0.18, 0.05), glow, 0.03, 0.58, -0.4);
};

// Tall cherry blossom tree (no collision — footprint: null, documented drift).
const buildCherryTree = ({ m, place }: BuildCtx) => {
  place(
    new THREE.CylinderGeometry(0.22, 0.17, 0.4, 14),
    m(TERRA, 0.85, 0.07),
    0,
    0.2,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.235, 0.225, 0.048, 14),
    m(0xc06840, 0.8, 0.05),
    0,
    0.43,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.058, 0.082, 1.22, 8),
    m(0x4a2a18, 0.85, 0.05),
    0,
    1.04,
    0,
  );
  place(new THREE.SphereGeometry(0.44, 12, 12), m(PK1, 0.88, 0.02), 0, 1.88, 0);
  place(
    new THREE.SphereGeometry(0.36, 12, 12),
    m(PK2, 0.86, 0.02),
    -0.34,
    1.66,
    0.18,
  );
  place(
    new THREE.SphereGeometry(0.34, 12, 12),
    m(PK2, 0.86, 0.02),
    0.34,
    1.66,
    -0.16,
  );
  place(
    new THREE.SphereGeometry(0.28, 12, 12),
    m(PK3, 0.84, 0.02),
    -0.12,
    2.2,
    0,
  );
  place(
    new THREE.SphereGeometry(0.22, 12, 12),
    m(PK1, 0.88, 0.02),
    0.28,
    2.0,
    0.2,
  );
};

// Small cherry blossom accent (sits at lamp-table top height).
const buildBlossomPot = (ctx: BuildCtx) => roundPlant(ctx, 0, 0.56, 0);

// Bar corner (right-front, hugging x=+6 wall) — composite, moves as ONE unit.
const buildBarCorner = (ctx: BuildCtx) => {
  const { m, place, addLight } = ctx;
  // Item origin = original bar body centre (BAR_X=5.24, BAR_Z=3.10).
  const BAR_L = 2.8; // bar length (z direction)  world z range: 1.70 → 4.50
  const BAR_H = 1.08; // counter height

  // Cabinet body
  place(
    new THREE.BoxGeometry(0.58, BAR_H, BAR_L),
    m(DKWOOD, 0.78, 0.06),
    0,
    BAR_H / 2,
    0,
  );
  // Counter top (white, slight overhang toward room)
  place(
    new THREE.BoxGeometry(0.76, 0.072, BAR_L + 0.18),
    m(0xfafafa, 0.45, 0.14),
    -0.07,
    BAR_H + 0.036,
    0,
  );
  // Counter edge trim
  place(
    new THREE.BoxGeometry(0.76, 0.036, BAR_L + 0.18),
    m(WOOD, 0.4, 0.28),
    -0.07,
    BAR_H + 0.09,
    0,
  );
  // Footrest rail (box)
  place(
    new THREE.BoxGeometry(0.044, 0.038, BAR_L - 0.24),
    m(WOOD, 0.4, 0.3),
    -0.22,
    0.25,
    0,
  );

  // Back panel (flat against x=+6 wall; world x=5.97)
  place(
    new THREE.BoxGeometry(0.055, 1.88, BAR_L + 0.1),
    m(0xf5f5f5, 0.88, 0.02),
    0.73,
    0.94,
    0,
  );
  // Three shelves on back wall (world x=5.84)
  ([0.52, 1.0, 1.5] as number[]).forEach((sy) =>
    place(
      new THREE.BoxGeometry(0.28, 0.036, BAR_L + 0.04),
      m(0xe8e8e8, 0.72, 0.04),
      0.6,
      sy,
      0,
    ),
  );

  // Bottles (cylinder body + neck + cap)
  const makeBottle = (bz: number, sy: number, col: number) => {
    place(
      new THREE.CylinderGeometry(0.04, 0.048, 0.22, 8),
      m(col, 0.22, 0.58),
      0.6,
      sy + 0.11,
      bz,
    );
    place(
      new THREE.CylinderGeometry(0.017, 0.028, 0.09, 8),
      m(col, 0.22, 0.58),
      0.6,
      sy + 0.265,
      bz,
    );
    place(
      new THREE.SphereGeometry(0.02, 6, 6),
      m(0x888888, 0.4, 0.4),
      0.6,
      sy + 0.315,
      bz,
    );
  };
  const BCOLS = [
    0x3a7840, 0xa83020, 0xe8c030, 0x284890, 0xd07020, 0x60a050, 0x8848a0,
  ];
  const BOFFS = [-1.1, -0.55, 0, 0.55, 1.1];
  BOFFS.forEach((dz, i) => makeBottle(dz, 0.52, BCOLS[i % BCOLS.length]));
  BOFFS.forEach((dz, i) => makeBottle(dz, 1.0, BCOLS[(i + 2) % BCOLS.length]));
  BOFFS.forEach((dz, i) => makeBottle(dz, 1.5, BCOLS[(i + 4) % BCOLS.length]));

  // Wine glasses on counter (very thin cylinder + stem + base)
  const makeGlass = (gz: number) => {
    place(
      new THREE.CylinderGeometry(0.042, 0.018, 0.15, 10),
      m(0xddeeff, 0.06, 0.12),
      -0.14,
      BAR_H + 0.147,
      gz,
    );
    place(
      new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8),
      m(0xddeeff, 0.06, 0.12),
      -0.14,
      BAR_H + 0.297,
      gz,
    );
    place(
      new THREE.CylinderGeometry(0.028, 0.028, 0.012, 10),
      m(0xddeeff, 0.06, 0.12),
      -0.14,
      BAR_H + 0.348,
      gz,
    );
  };
  makeGlass(-0.8);
  makeGlass(-0.1);
  makeGlass(0.6);

  // Bar stools (3, facing bar / +x)
  const makeBarStool = (sz: number) => {
    place(
      new THREE.CylinderGeometry(0.21, 0.21, 0.052, 14),
      m(CREAM, 0.82, 0.04),
      -0.64,
      0.71,
      sz,
    ); // seat pad
    place(
      new THREE.CylinderGeometry(0.19, 0.19, 0.038, 14),
      m(LINEN, 0.85, 0.04),
      -0.64,
      0.752,
      sz,
    ); // cushion
    place(
      new THREE.CylinderGeometry(0.034, 0.034, 0.65, 8),
      m(WOOD, 0.45, 0.25),
      -0.64,
      0.37,
      sz,
    ); // stem
    place(
      new THREE.CylinderGeometry(0.21, 0.21, 0.038, 14),
      m(WOOD, 0.45, 0.25),
      -0.64,
      0.019,
      sz,
    ); // base
    // footrest cross
    place(
      new THREE.BoxGeometry(0.36, 0.028, 0.036),
      m(WOOD, 0.45, 0.25),
      -0.64,
      0.35,
      sz,
    );
    place(
      new THREE.BoxGeometry(0.036, 0.028, 0.36),
      m(WOOD, 0.45, 0.25),
      -0.64,
      0.35,
      sz,
    );
  };
  makeBarStool(-0.95);
  makeBarStool(0);
  makeBarStool(0.95);

  // Pendant light above bar
  place(
    new THREE.CylinderGeometry(0.13, 0.09, 0.17, 12),
    m(0x282828, 0.7, 0.1),
    -0.45,
    2.14,
    0,
  ); // shade
  addLight(new THREE.PointLight(0xffe8a0, 0, 10), -0.45, 1.9, 0, 1.6);

  // Small blossom pot at bar end
  roundPlant(ctx, -0.14, BAR_H + 0.072, -BAR_L / 2 + 0.22);
};

// ── Wall computer (M1 of #33) — visuals adopted from PR #36's deviceProps.ts ──
// Wall-mounted room terminal: dark slate housing + bezel + live CanvasTexture
// screen, amber accent strip (0xD4A84B — adapter/keypad palette). Local frame:
// screen faces +z, panel centre at mount height WC_Y; the registry item flips
// it into the room with rot 2 (flush-mount idiom like the bar back-panel).
const WC_W = 0.9; // housing width
const WC_H = 0.7; // housing height
const WC_D = 0.12; // housing depth
const WC_Y = 1.6; // mount height (panel centre)

const buildWallComputer = (ctx: BuildCtx) => {
  const { m, place } = ctx;
  const HOUSING = 0x2a3444; // gunmetal slate (matches adapter/door frames)
  const BEZEL = 0x3d4a5e;
  const ACCENT = 0xd4a84b; // keypad gold

  place(
    new THREE.BoxGeometry(WC_W, WC_H, WC_D - 0.04),
    m(HOUSING, 0.6, 0.5),
    0,
    WC_Y,
    -0.02,
  ); // housing (back)
  place(
    new THREE.BoxGeometry(0.82, 0.6, 0.03),
    m(BEZEL, 0.55, 0.45),
    0,
    WC_Y + 0.02,
    WC_D / 2 - 0.015,
  ); // bezel
  place(
    new THREE.BoxGeometry(WC_W, 0.05, 0.03),
    m(ACCENT, 0.4, 0.5),
    0,
    WC_Y - WC_H / 2 + 0.025,
    WC_D / 2 - 0.015,
  ); // amber strip
  place(
    new THREE.BoxGeometry(0.2, 0.06, 0.02),
    m(HOUSING, 0.6, 0.5),
    0,
    WC_Y - WC_H / 2 + 0.025,
    WC_D / 2 + 0.001,
  ); // strip badge

  // ── Screen: live CanvasTexture. Redrawn only by the WallScreenHandle the
  //    World drives at ~1 Hz (permanent home of #36's dev-hook wiring) —
  //    no internal timer. Starts opacity 0 for the morph fade-in.
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 192;
  const c2d = cv.getContext("2d")!;
  const screenTex = new THREE.CanvasTexture(cv);
  screenTex.minFilter = THREE.NearestFilter;
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.generateMipmaps = false;
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({
    map: screenTex,
    transparent: true,
    opacity: 0,
  }); // unlit = emissive read
  const screen = place(
    new THREE.PlaneGeometry(0.72, 0.5),
    screenMat,
    0,
    WC_Y + 0.02,
    WC_D / 2 + 0.002,
  );

  const drawStatus = (status: WallComputerStatus) => {
    c2d.imageSmoothingEnabled = false;
    c2d.fillStyle = "#0A1018";
    c2d.fillRect(0, 0, 256, 192);
    c2d.strokeStyle = "#1E2A38";
    c2d.strokeRect(3.5, 3.5, 249, 185);
    // Header: room name (amber)
    c2d.font = "bold 16px monospace";
    c2d.textAlign = "left";
    c2d.textBaseline = "alphabetic";
    c2d.fillStyle = "#D4A84B";
    c2d.fillText(status.roomName.toUpperCase().slice(0, 16), 14, 28);
    c2d.strokeStyle = "#D4A84B";
    c2d.beginPath();
    c2d.moveTo(14, 38);
    c2d.lineTo(242, 38);
    c2d.stroke();
    // Peer count (cyan)
    c2d.font = "14px monospace";
    c2d.fillStyle = "#00E5FF";
    c2d.fillText(`PEERS: ${status.peers}`, 14, 62);
    // Node status LED + label
    c2d.beginPath();
    c2d.arc(21, 82, 5, 0, Math.PI * 2);
    c2d.fillStyle = status.nodeOnline ? "#00E676" : "#FF1744";
    c2d.fill();
    c2d.fillStyle = "#8FA3B8";
    c2d.fillText(`NODE ${status.nodeOnline ? "ONLINE" : "OFFLINE"}`, 34, 87);
    // Wireframe room-outline motif (the full live view is the FOCUSED DOM UI)
    c2d.strokeStyle = "#3E92B8";
    c2d.strokeRect(150.5, 100.5, 92, 68);
    c2d.fillStyle = "#3E92B8";
    c2d.fillRect(192, 97, 10, 4); // north door port
    c2d.fillRect(192, 167, 10, 4); // south door port
    c2d.fillRect(147, 130, 4, 10); // west door port
    c2d.fillRect(241, 130, 4, 10); // east door port
    c2d.fillStyle = "#25506A";
    c2d.font = "10px monospace";
    c2d.fillText("MODULE", 172, 140);
    // Honesty rule: no fuel system exists — say so, dimly.
    c2d.fillStyle = "#4A5560";
    c2d.font = "12px monospace";
    c2d.fillText("FUEL — NO SENSOR", 14, 120);
    c2d.fillStyle = "#33404E";
    c2d.font = "10px monospace";
    c2d.fillText("SSF ROOM TERMINAL v1", 14, 178);
    screenTex.needsUpdate = true;
  };

  // Dimmed frame shown while a player is focused (plan §D0.4 hybrid screens).
  const drawInUse = () => {
    c2d.imageSmoothingEnabled = false;
    c2d.fillStyle = "#060A10";
    c2d.fillRect(0, 0, 256, 192);
    c2d.strokeStyle = "#1E2A38";
    c2d.strokeRect(3.5, 3.5, 249, 185);
    c2d.font = "bold 14px monospace";
    c2d.textAlign = "center";
    c2d.textBaseline = "middle";
    c2d.fillStyle = "rgba(212, 168, 75, 0.45)";
    c2d.fillText("TERMINAL IN USE", 128, 96);
    screenTex.needsUpdate = true;
  };

  let engaged = false;
  let lastStatus: WallComputerStatus = {
    roomName: "FURLONG LOBBY",
    peers: 0,
    nodeOnline: false,
  };
  const handle: WallScreenHandle = {
    updateStatus: (status) => {
      lastStatus = status;
      if (engaged) drawInUse();
      else drawStatus(status);
    },
    setEngaged: (value) => {
      engaged = value;
      if (engaged) drawInUse();
      else drawStatus(lastStatus);
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
const MT_TOP_Y = 0.84; // table-top surface height
const MT_HOLO_Y = 1.18; // holo disc plane height
const HOLO_CYAN = 0x00e5ff;

const buildMapTable = (ctx: BuildCtx) => {
  const { m, flat, place, addLight } = ctx;
  const BODY = 0x232b36; // dark gunmetal (wall-computer housing family)
  const TRIM = 0x3d4a5e; // bezel slate
  const ACCENT = 0xd4a84b; // keypad gold

  // Top slab + slate trim lip (footprint is 2×2; visuals inset for clearance)
  place(
    new THREE.BoxGeometry(1.8, 0.1, 1.8),
    m(BODY, 0.55, 0.45),
    0,
    MT_TOP_Y - 0.05,
    0,
  );
  place(
    new THREE.BoxGeometry(1.86, 0.04, 1.86),
    m(TRIM, 0.5, 0.5),
    0,
    MT_TOP_Y - 0.11,
    0,
  );
  // Apron under the slab
  place(
    new THREE.BoxGeometry(1.55, 0.16, 1.55),
    m(BODY, 0.6, 0.4),
    0,
    MT_TOP_Y - 0.2,
    0,
  );
  // Amber accent strip ringing the apron (gold band on the -z/player face)
  place(
    new THREE.BoxGeometry(1.57, 0.035, 1.57),
    m(ACCENT, 0.4, 0.5),
    0,
    MT_TOP_Y - 0.145,
    0,
  );
  // Four chunky legs
  (
    [
      [-0.76, -0.76],
      [-0.76, 0.76],
      [0.76, -0.76],
      [0.76, 0.76],
    ] as [number, number][]
  ).forEach(([lx, lz]) => {
    place(
      new THREE.BoxGeometry(0.16, MT_TOP_Y - 0.1, 0.16),
      m(BODY, 0.6, 0.4),
      lx,
      (MT_TOP_Y - 0.1) / 2,
      lz,
    );
    place(
      new THREE.BoxGeometry(0.2, 0.05, 0.2),
      m(TRIM, 0.55, 0.45),
      lx,
      0.025,
      lz,
    ); // foot
  });

  // Holo emitter puck at the table centre
  place(
    new THREE.CylinderGeometry(0.16, 0.2, 0.06, 16),
    m(TRIM, 0.45, 0.55),
    0,
    MT_TOP_Y + 0.03,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.1, 0.1, 0.015, 16),
    flat(HOLO_CYAN),
    0,
    MT_TOP_Y + 0.065,
    0,
  );

  // Holographic disc — emissive cyan plane floating above the table. The
  // geometry is rotated flat (rotateX) so the MESH keeps identity rotation
  // and the ring below can spin with a plain rotation.y increment.
  const discMat = flat(HOLO_CYAN);
  discMat.userData.baseOpacity = 0.28; // translucent hologram (morph respects it)
  const discGeo = new THREE.CircleGeometry(0.62, 40);
  discGeo.rotateX(-Math.PI / 2); // face +y
  place(discGeo, discMat, 0, MT_HOLO_Y, 0);

  // Slow-spinning broken emissive ring above the disc rim
  const ringMat = flat(0x7ff3ff);
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
const COL_TRUNK_BODY = 0xb8bec6; // light-gray ribbed shell
const COL_TRUNK_RIB = 0xa6adb6; // slightly darker ribs / panel lines
const COL_TRUNK_ORANGE = 0xe8760a; // corner reinforcements, latch plates, lid trim
const COL_TRUNK_LATCH = 0x6e7680; // gray latch hardware
const COL_TRUNK_DARK = 0x14181e; // interior cavity / label plate
const COL_TRUNK_TRAY = 0x2a3038; // tool-tray layer

// Overall footprint ~1.0w × 0.65h × 0.6d, latch face toward local +z.
const TRUNK_W = 1.0;
const TRUNK_D = 0.6;
const TRUNK_BODY_H = 0.5; // shell height; lid adds 0.15 → 0.65 total
const TRUNK_LID_H = 0.15;
const TRUNK_WALL_T = 0.05;
const LID_OPEN_ANGLE = -Math.PI * (100 / 180); // negative rotation.x = swing up + backward
const LID_SPEED = 2.4; // rad/s, constant-speed ease

/** One-shot pixel-text decal (star-window CanvasTexture idiom, world.ts). */
function makeStencilTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 48;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#14181E";
  ctx.fillRect(0, 0, 128, 48);
  ctx.strokeStyle = "#3A424C";
  ctx.strokeRect(2.5, 2.5, 123, 43);
  ctx.fillStyle = "#E8ECF2";
  ctx.font = "bold 18px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 25);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

const buildStorageTrunk = (ctx: BuildCtx) => {
  const { m, place, attach } = ctx;
  const W = TRUNK_W,
    D = TRUNK_D,
    BH = TRUNK_BODY_H,
    LH = TRUNK_LID_H,
    T = TRUNK_WALL_T;

  // Shared materials (each mesh sets opacity via the morph fade — sharing is
  // safe, the fade writes the same value to every user).
  const bodyMat = m(COL_TRUNK_BODY, 0.65, 0.35);
  const ribMat = m(COL_TRUNK_RIB, 0.7, 0.3);
  const orangeMat = m(COL_TRUNK_ORANGE, 0.5, 0.4);
  const latchMat = m(COL_TRUNK_LATCH, 0.45, 0.6);
  const darkMat = m(COL_TRUNK_DARK, 0.9, 0.1);
  const trayMat = m(COL_TRUNK_TRAY, 0.8, 0.2);
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);

  // ── Body shell: floor + four walls, leaving a real cavity for the open lid
  place(box(W, T, D), bodyMat, 0, T / 2, 0); // floor
  place(box(W, BH - T, T), bodyMat, 0, (BH + T) / 2, (D - T) / 2); // front
  place(box(W, BH - T, T), bodyMat, 0, (BH + T) / 2, -(D - T) / 2); // back
  place(box(T, BH - T, D - 2 * T), bodyMat, -(W - T) / 2, (BH + T) / 2, 0); // left
  place(box(T, BH - T, D - 2 * T), bodyMat, (W - T) / 2, (BH + T) / 2, 0); // right

  // ── Interior: dark cavity liner + a hint of a tool-tray layer
  place(box(W - 2 * T, 0.02, D - 2 * T), darkMat, 0, T + 0.01, 0); // dark bottom
  place(box(W - 2 * T - 0.06, 0.03, D - 2 * T - 0.06), trayMat, 0, 0.3, 0); // tool tray
  // A few colored blocks suggesting stowed tools on the tray
  const toolBlocks: Array<[number, number, number, number]> = [
    [0xe8760a, -0.28, 0.16, 0.05], // orange driver
    [0x00e5ff, -0.06, 0.1, 0.05], // cyan gauge
    [0xd4a84b, 0.14, 0.2, 0.05], // amber wrench case
    [0x8899aa, 0.32, 0.08, 0.05], // gray spares tin
  ];
  toolBlocks.forEach(([color, x, w, h]) => {
    place(box(w, h, 0.14), m(color, 0.6, 0.3), x, 0.315 + h / 2, 0.02);
  });

  // ── Ribs (vertical, front + back faces) and side panel lines
  for (const rx of [-0.32, -0.11, 0.11, 0.32]) {
    place(box(0.055, BH - 0.14, 0.015), ribMat, rx, BH / 2, D / 2 + 0.005); // front ribs
    place(box(0.055, BH - 0.14, 0.015), ribMat, rx, BH / 2, -D / 2 - 0.005); // back ribs
  }
  for (const sx of [-1, 1]) {
    place(
      box(0.015, BH - 0.14, 0.055),
      ribMat,
      sx * (W / 2 + 0.005),
      BH / 2,
      -0.12,
    ); // side rib
    place(
      box(0.015, BH - 0.14, 0.055),
      ribMat,
      sx * (W / 2 + 0.005),
      BH / 2,
      0.12,
    ); // side rib
  }
  // Horizontal panel line across the front, above the label band
  place(box(W - 0.08, 0.02, 0.012), ribMat, 0, 0.4, D / 2 + 0.004);

  // ── Orange corner reinforcements (all four vertical corners)
  for (const cx of [-1, 1]) {
    for (const cz of [-1, 1]) {
      place(
        box(0.09, BH, 0.02),
        orangeMat,
        cx * (W / 2 - 0.045),
        BH / 2,
        cz * (D / 2 + 0.006),
      );
      place(
        box(0.02, BH, 0.09),
        orangeMat,
        cx * (W / 2 + 0.006),
        BH / 2,
        cz * (D / 2 - 0.045),
      );
    }
  }

  // ── Front hardware: orange latch plates + gray latches, stencil label
  for (const lx of [-0.3, 0.3]) {
    place(box(0.12, 0.16, 0.02), orangeMat, lx, BH - 0.06, D / 2 + 0.008); // latch plate
    place(box(0.07, 0.1, 0.03), latchMat, lx, BH - 0.07, D / 2 + 0.022); // latch body
  }
  // Stencil decal: transparent opacity-0 start like every furniture material
  // so it rides the morph fade-in with the rest of the prop.
  const labelMat = new THREE.MeshBasicMaterial({
    map: makeStencilTexture("ISS-ST04"),
    transparent: true,
    opacity: 0,
  });
  place(new THREE.PlaneGeometry(0.34, 0.13), labelMat, 0, 0.24, D / 2 + 0.012);

  // ── Lid: its own sub-Group hinged at the BACK top edge. Children sit
  //    forward of the hinge (+z), so negative rotation.x swings the lid
  //    up and backward over the back wall.
  const lid = new THREE.Group();
  lid.name = "trunkLid";
  lid.position.set(0, BH, -D / 2);
  attach(lid);

  const addLid = (
    geo: THREE.BoxGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    lid.add(mesh);
    return mesh;
  };
  const lidSlab = addLid(box(W, LH, D), bodyMat, 0, LH / 2, D / 2); // lid slab
  addLid(box(W - 2 * T, 0.015, D - 2 * T), darkMat, 0, 0.002, D / 2); // dark underside
  // Orange lid trim: front edge strip + side edge strips
  addLid(box(W, 0.04, 0.02), orangeMat, 0, 0.04, D + 0.006);
  for (const sx of [-1, 1]) {
    addLid(box(0.02, 0.04, D), orangeMat, sx * (W / 2 + 0.006), 0.04, D / 2);
  }
  // Subtle top handle recess: dark inset with a gray grab bar
  addLid(box(0.3, 0.02, 0.12), darkMat, 0, LH - 0.005, D / 2);
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
      pendingComplete = onComplete
        ? prev
          ? () => {
              prev();
              onComplete();
            }
          : onComplete
        : prev;
      return;
    }
    // A direction-changing call drops the previous callback (its motion never arrives).
    pendingComplete = null;
    lidTarget = target;
    if (lidAngle === lidTarget) {
      onComplete?.();
      return;
    } // already there → fire once, now
    pendingComplete = onComplete ?? null;
  };

  const handle: TrunkLidHandle = {
    openLid: (onComplete?: () => void) =>
      setLidTarget(LID_OPEN_ANGLE, onComplete),
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
const GT_TOP_Y = 0.78; // top pivot height (slab centre)
const GT_FLIP_TIME = 0.9; // seconds for the 180° flip
const GT_FLIP_LIFT = 0.5; // peak lift — the swinging slab clears the apron

// Checkerboard palette (warm frontier family)
const GT_SQ_LIGHT = "#EAD9B0";
const GT_SQ_DARK = "#7A4A28";
const GT_FRAME = "#4A2F1B";
const GT_RED = "#C43C3C";
const GT_RED_RIM = "#8E2626";
const GT_BLACK = "#23252E";
const GT_BLACK_RIM = "#0E0F14";
const GT_CROWN = "#F0C060";

/** Board-face painter shared by the builder (in-world texture). Kept board-
 *  code-compatible with games/checkers.ts (1/2 red man/king, 3/4 black). */
function drawCheckerboard(
  c2d: CanvasRenderingContext2D,
  board: number[] | null,
): void {
  const S = 512,
    PAD = 32,
    SQ = (S - PAD * 2) / 8; // 56 px squares
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
      c2d.font = "bold 26px monospace";
      c2d.textAlign = "center";
      c2d.textBaseline = "middle";
      c2d.fillText("K", cx, cy + 1);
    }
  }
}

/** One-shot card-felt face: green baize, darker border, two card outlines +
 *  centre pips. Motif is 180°-rotation-symmetric on purpose — the face is
 *  only ever seen after a flip, so no text that could read upside down. */
function drawCardFelt(c2d: CanvasRenderingContext2D): void {
  const W = 512,
    H = 256;
  c2d.imageSmoothingEnabled = false;
  c2d.fillStyle = "#14532D";
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = "#1B6B3A";
  c2d.fillRect(10, 10, W - 20, H - 20);
  c2d.strokeStyle = "#0E3B20";
  c2d.lineWidth = 4;
  c2d.strokeRect(20, 20, W - 40, H - 40);
  // Two card outlines, mirrored about the centre (rotation-symmetric)
  const card = (x: number, y: number) => {
    c2d.strokeStyle = "rgba(240, 240, 230, 0.75)";
    c2d.lineWidth = 3;
    const w = 64,
      h = 92,
      rr = 8;
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
  c2d.fillStyle = "rgba(240, 240, 230, 0.55)";
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
  place(
    new THREE.BoxGeometry(1.5, 0.14, 0.62),
    m(WOOD, 0.55, 0.15),
    0,
    0.62,
    0,
  ); // apron
  place(new THREE.BoxGeometry(1.4, 0.04, 0.5), m(WOOD, 0.6, 0.12), 0, 0.16, 0); // stretcher
  (
    [
      [-0.72, -0.3],
      [-0.72, 0.3],
      [0.72, -0.3],
      [0.72, 0.3],
    ] as [number, number][]
  ).forEach(([lx, lz]) => {
    place(
      new THREE.BoxGeometry(0.12, 0.62, 0.12),
      m(DKWOOD, 0.55, 0.18),
      lx,
      0.31,
      lz,
    ); // leg
    place(
      new THREE.BoxGeometry(0.15, 0.04, 0.15),
      m(WOOD, 0.5, 0.2),
      lx,
      0.02,
      lz,
    ); // foot
  });

  // ── Flippable top: sub-Group pivoted at the slab centre
  const top = new THREE.Group();
  top.name = "gameTableTop";
  top.position.set(0, GT_TOP_Y, 0);
  attach(top);

  const addTop = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    top.add(mesh);
    return mesh;
  };
  const slab = addTop(
    new THREE.BoxGeometry(1.76, 0.07, 0.86),
    m(WOOD, 0.45, 0.2),
    0,
    0,
    0,
  );
  // Thin darker edge band so the flip reads even from far away
  addTop(
    new THREE.BoxGeometry(1.8, 0.024, 0.9),
    m(0xa06a32, 0.5, 0.18),
    0,
    0,
    0,
  );

  // FACE A — checkerboard CanvasTexture (NearestFilter, wall-screen idiom).
  const boardCv = document.createElement("canvas");
  boardCv.width = 512;
  boardCv.height = 512;
  const boardC2d = boardCv.getContext("2d")!;
  const boardTex = new THREE.CanvasTexture(boardCv);
  boardTex.minFilter = THREE.NearestFilter;
  boardTex.magFilter = THREE.NearestFilter;
  boardTex.generateMipmaps = false;
  boardTex.colorSpace = THREE.SRGBColorSpace;
  drawCheckerboard(boardC2d, null); // bare board until a game exists
  const boardMat = new THREE.MeshBasicMaterial({
    map: boardTex,
    transparent: true,
    opacity: 0,
  });
  // rotateX(-π/2) faces +y; the extra rotateY(π) points texture-up AWAY from
  // the device front (-z), so board row 0 (black home) reads at the far side
  // for the focused viewer — matching the DOM board's fixed orientation.
  const boardGeo = new THREE.PlaneGeometry(0.74, 0.74);
  boardGeo.rotateX(-Math.PI / 2);
  boardGeo.rotateY(Math.PI);
  addTop(boardGeo, boardMat, 0, 0.037, 0);

  // FACE B — card felt, facing -y until a flip brings it up.
  const feltCv = document.createElement("canvas");
  feltCv.width = 512;
  feltCv.height = 256;
  drawCardFelt(feltCv.getContext("2d")!);
  const feltTex = new THREE.CanvasTexture(feltCv);
  feltTex.minFilter = THREE.NearestFilter;
  feltTex.magFilter = THREE.NearestFilter;
  feltTex.generateMipmaps = false;
  feltTex.colorSpace = THREE.SRGBColorSpace;
  const feltMat = new THREE.MeshBasicMaterial({
    map: feltTex,
    transparent: true,
    opacity: 0,
  });
  const feltGeo = new THREE.PlaneGeometry(1.55, 0.72);
  feltGeo.rotateX(Math.PI / 2); // face -y
  feltGeo.rotateY(Math.PI); // texture-up lands away from the viewer post-flip
  addTop(feltGeo, feltMat, 0, -0.037, 0);

  // ── Flip tween: constant-duration smoothstep rotation about the long (x)
  //    axis with a sine lift, driven from World.update (trunk-lid idiom).
  //    The flip is CLIENT-LOCAL in v1 (review F3): cardsUp lives in this
  //    closure and flip() only fires from the local focused UI, so peers can
  //    see different faces of the same table while the game state underneath
  //    stays shared. Doc-sync a per-table cardsUp when the card side is real.
  let flipT = 1; // 1 = at rest
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
const armchairLeftSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: 1.0, z: 0 },
    sit: { x: 0, z: 0 },
    faceAngle: Math.PI / 2,
  },
];
const armchairRightSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: -1.0, z: 0 },
    sit: { x: 0, z: 0 },
    faceAngle: -Math.PI / 2,
  },
];
// Back sofa: 3 cushions, faces +z (toward the entrance).
const sofaBackSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1.5, z0: -0.5, x1: -0.5, z1: 0.5 },
    front: { x: -1.0, z: 1.0 },
    sit: { x: -1.0, z: 0 },
    faceAngle: 0,
  },
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: 0.0, z: 1.0 },
    sit: { x: 0.0, z: 0 },
    faceAngle: 0,
  },
  {
    clickBox: { x0: 0.5, z0: -0.5, x1: 1.5, z1: 0.5 },
    front: { x: 1.0, z: 1.0 },
    sit: { x: 1.0, z: 0 },
    faceAngle: 0,
  },
];
// Front sofa: 2 wide halves, faces -z; fronts approach from the SIDES because
// the coffee table pinches the corridor in front (preserved hand-tuned data).
const sofaFrontSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1.5, z0: -0.5, x1: 0.0, z1: 0.5 },
    front: { x: -2.0, z: 0 },
    sit: { x: -1.0, z: 0 },
    faceAngle: Math.PI,
  },
  {
    clickBox: { x0: 0.0, z0: -0.5, x1: 1.5, z1: 0.5 },
    front: { x: 2.0, z: 0 },
    sit: { x: 1.0, z: 0 },
    faceAngle: Math.PI,
  },
];

const casinoBoothSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1, z0: -0.5, x1: 0, z1: 0.5 },
    front: { x: -0.48, z: 1.0 },
    sit: { x: -0.48, z: 0.03 },
    faceAngle: 0,
  },
  {
    clickBox: { x0: 0, z0: -0.5, x1: 1, z1: 0.5 },
    front: { x: 0.48, z: 1.0 },
    sit: { x: 0.48, z: 0.03 },
    faceAngle: 0,
  },
];

// 🛏️ Bunk-bed berth heights + templates — order matters: findSeatAt returns
// the FIRST clickBox containing the floor click, so the TOP bunk's narrow
// ladder-end strip is listed first and the bottom bunk sweeps up the rest of
// the bed. Both lie head toward +x (local): faceAngle -π/2 points the FEET at
// the ladder end (the sleep recline tips the head opposite the facing). The
// shared front point sits off the ladder end — the only guaranteed-open face
// when the bed is tucked flush into a wall nook.
export const BUNK_BOTTOM_Y = 0.32; // bottom mattress top surface (avatar root)
export const BUNK_TOP_Y = 1.32; // top mattress top surface (avatar root)

// 🏊 Lido pool tuning — shared by the local dive phase (player.ts) and the
// remote arc reconstruction (world.ts) so both ends replay the SAME trajectory
// (the movement tick carries no y — see network/protocol.ts flag bits 4/5).
// Habbo-Lido layout: the walkable deck (y=0) is a raised white-tile platform
// and the water lies BELOW its edge. world.applyRoomVisuals hides the room's
// solid floor plane in the outdoor room so the sunken water actually shows —
// the lazy-pool item's deck slabs provide all visible flooring instead.
export const POOL_WATER_Y = -0.35; // water surface (splash spawn height)
export const POOL_SWIM_Y = -0.52; // avatar-root y while swimming (head above water)
export const DIVE_TIME = 0.9; // seconds board-tip → water
export const DIVE_ARC_LIFT = 0.55; // parabola apex above the straight chord

/** 🛑📐 #80: same `?octagon=1` preview flag world.ts reads. When on, the pool
 *  sinks into the BASEMENT through a real floor hole (a solid rect basin bottom
 *  is drawn in) instead of the legacy hidden-whole-floor trick. */
const OCTAGON_HULL =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("octagon") === "1";

/** 🏊 Lazy-pool water footprint in the item's LOCAL frame (west waterline →
 *  east tile wall × ±halfZ). buildLazyPool aliases these to WX/HX/HZ; the
 *  floor-hole cutter (poolHoleRect) + the rect basin bottom use them too. */
export const POOL_WATER_WEST = 5.15; // WX — west waterline (near the room bound)
export const POOL_WATER_EAST = 3.4; // HX — east tile wall
export const POOL_WATER_HALFZ = 2.9; // HZ

// ── 🌉 Hot-tub footbridge geometry — single source of truth shared by the
// lazy-pool builder (visual planks), the hot-tub seat approach path (the fox
// WALKS the arch instead of gliding through it) and the remote-replica y
// derivation in world.ts. Local frame of the pool/hot-tub items (both at the
// room origin in the default layout).
const BRIDGE_X = -0.2; // deck centreline x
const BRIDGE_HALF_W = 0.41; // walkable half-width (plank BoxGeometry w 0.82)
const BRIDGE_Z_ISLAND = 1.18; // island-end plank centre z
const BRIDGE_Z_SHORE = 3.26; // shore-end plank centre z
const BRIDGE_RISE_BASE = 0.28; // plank-centre height at both ends
const BRIDGE_RISE_ARC = 0.28; // extra rise at the crest (z ≈ 2.22)
const BRIDGE_PLANK_HALF = 0.04; // plank half-thickness → deck TOP offset
/** ♨️ Tub water disc height (buildHotTub water mesh) — splash spawn point. */
export const HOT_TUB_WATER_Y = 0.565;

/** Deck-TOP height of the footbridge at local z ∈ [island, shore]. */
function bridgeTopAt(lz: number): number {
  const t = (lz - BRIDGE_Z_ISLAND) / (BRIDGE_Z_SHORE - BRIDGE_Z_ISLAND);
  return (
    BRIDGE_RISE_BASE + Math.sin(t * Math.PI) * BRIDGE_RISE_ARC + BRIDGE_PLANK_HALF
  );
}

/**
 * 🌉 Deck-top height of the hot-tub footbridge at world (x, z), or null when
 * the point is off the bridge (or the room has no hot tub). Remote replicas
 * derive a bridge-walking peer's y from this — the movement tick carries no y.
 */
export function bridgeDeckY(
  items: FurnitureItem[],
  x: number,
  z: number,
): number | null {
  const tub = items.find((item) => item.id === "pool-hot-tub");
  if (!tub) return null;
  const lx = x - tub.pos.x;
  const lz = z - tub.pos.z;
  if (Math.abs(lx - BRIDGE_X) > BRIDGE_HALF_W) return null;
  if (lz < BRIDGE_Z_ISLAND || lz > BRIDGE_Z_SHORE) return null;
  return bridgeTopAt(lz);
}

/**
 * 🌉 Forgiving click test for the footbridge deck. Padded beyond the strict
 * walkable strip: the click ray is intersected with the FLOOR plane, so a
 * click on the raised deck lands with a small parallax offset in xz.
 * findSeatAt routes these clicks into the hot tub — the bridge exists only
 * to reach it.
 */
export function isBridgeClick(
  items: FurnitureItem[],
  x: number,
  z: number,
): boolean {
  const tub = items.find((item) => item.id === "pool-hot-tub");
  if (!tub) return false;
  const lx = x - tub.pos.x;
  const lz = z - tub.pos.z;
  return (
    Math.abs(lx - BRIDGE_X) <= BRIDGE_HALF_W + 0.25 &&
    lz >= BRIDGE_Z_ISLAND - 0.2 &&
    lz <= BRIDGE_Z_SHORE + 0.2
  );
}
const bunkBedSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1.0, z0: -0.5, x1: -0.62, z1: 0.5 },
    front: { x: -1.5, z: 0 },
    sit: { x: 0.05, z: 0 },
    faceAngle: -Math.PI / 2,
    sitY: BUNK_TOP_Y,
    lie: true,
  },
  {
    clickBox: { x0: -0.62, z0: -0.5, x1: 1.0, z1: 0.5 },
    front: { x: -1.5, z: 0 },
    sit: { x: 0.05, z: 0 },
    faceAngle: -Math.PI / 2,
    sitY: BUNK_BOTTOM_Y,
    lie: true,
  },
];

// ── 🏊 Pool seats — Habbo Hotel-style jump-in (lazy-pool) ───────────────────
// Eight seats cover the full pool interior in a compass-rose layout.
// sitY: POOL_SWIM_Y (-0.52) drops the avatar below the deck edge so only the
// head bobs above the water plane (POOL_WATER_Y = -0.35) — Habbo Lido style.
// The `front` points are in the 1.5 m walkable corridors around the 7×6
// obstacle so A* can always reach them; `sit` positions are inside the pool
// (non-walkable obstacle zone — the avatar teleports there after the walk).
// All coordinates are in the LOCAL frame of the furniture item (pool at 0,0).
const poolSeats: SeatTemplate[] = [
  // 🏊‍♂️ DIVING BOARD seat — listed FIRST so it takes click priority near the tower.
  // The tower stands between the two north doors (0, -4.35), board reaching
  // SOUTH over the water. Player clicks tower/board → walks to the north-deck
  // approach → avatar appears on the high-board tip facing the pool, then can
  // click pool water to jump in. clickBox covers the tower shaft and most of
  // the board (z1 stops at -1.6 so it never shadows the hot-tub clickBoxes);
  // isDiveTower clicks route the clicked MESH's world x/z here.
  {
    clickBox: { x0: -0.8, z0: -4.9, x1: 0.8, z1: -1.6 },
    front: { x: 0, z: -4.9 },
    sit: { x: 0, z: -1.7 },
    faceAngle: 0,
    sitY: 4.55,
    dive: true,
  },
  // ⛱️ Green lounger berths on the south deck — walk up and LIE DOWN (same
  // lie machinery as the bunks; peers see the sleep pose via flags bit2).
  // Head rests on the inclined backrest at the south (+z) end, so the
  // feet-ward axis is north: faceAngle π. Listed BEFORE the water seats so
  // clicks near a chair pick the chair, not a wade-in.
  {
    clickBox: { x0: -4.4, z0: 4.0, x1: -3.2, z1: 5.2 },
    front: { x: -3.8, z: 3.75 },
    sit: { x: -3.8, z: 4.5 },
    faceAngle: Math.PI,
    sitY: 0.36,
    lie: true,
  },
  {
    clickBox: { x0: -2.7, z0: 4.0, x1: -1.5, z1: 5.2 },
    front: { x: -2.1, z: 3.75 },
    sit: { x: -2.1, z: 4.5 },
    faceAngle: Math.PI,
    sitY: 0.36,
    lie: true,
  },
  {
    clickBox: { x0: 1.1, z0: 4.0, x1: 2.3, z1: 5.2 },
    front: { x: 1.7, z: 3.75 },
    sit: { x: 1.7, z: 4.5 },
    faceAngle: Math.PI,
    sitY: 0.36,
    lie: true,
  },
  {
    clickBox: { x0: 2.8, z0: 4.0, x1: 4.0, z1: 5.2 },
    front: { x: 3.4, z: 3.75 },
    sit: { x: 3.4, z: 4.5 },
    faceAngle: Math.PI,
    sitY: 0.36,
    lie: true,
  },
  // East — avatar faces west toward island
  {
    clickBox: { x0: 0.5, z0: -1.5, x1: 4.5, z1: 1.5 },
    front: { x: 4.0, z: 0.0 },
    sit: { x: 2.5, z: 0.0 },
    faceAngle: -Math.PI / 2,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // West — avatar faces east toward island
  {
    clickBox: { x0: -4.5, z0: -1.5, x1: -0.5, z1: 1.5 },
    front: { x: -4.0, z: 0.0 },
    sit: { x: -2.5, z: 0.0 },
    faceAngle: Math.PI / 2,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // South — avatar faces north toward island (pool is centered at z=0, south corridor z[3,5])
  {
    clickBox: { x0: -1.5, z0: 0.5, x1: 1.5, z1: 4.5 },
    front: { x: 0.0, z: 3.5 },
    sit: { x: 0.0, z: 2.2 },
    faceAngle: Math.PI,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // North — avatar faces south toward island (north corridor z[-5,-3])
  {
    clickBox: { x0: -1.5, z0: -4.5, x1: 1.5, z1: -0.5 },
    front: { x: 0.0, z: -3.5 },
    sit: { x: 0.0, z: -2.2 },
    faceAngle: 0,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // NE corner
  {
    clickBox: { x0: 0.5, z0: -4.5, x1: 4.5, z1: -0.5 },
    front: { x: 4.0, z: -3.5 },
    sit: { x: 2.2, z: -2.2 },
    faceAngle: (-Math.PI * 3) / 4,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // SE corner
  {
    clickBox: { x0: 0.5, z0: 0.5, x1: 4.5, z1: 4.5 },
    front: { x: 4.0, z: 3.5 },
    sit: { x: 2.2, z: 2.2 },
    faceAngle: (Math.PI * 3) / 4,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // SW corner
  {
    clickBox: { x0: -4.5, z0: 0.5, x1: -0.5, z1: 4.5 },
    front: { x: -4.0, z: 3.5 },
    sit: { x: -2.2, z: 2.2 },
    faceAngle: Math.PI / 4,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
  // NW corner (front avoids hot-tub obstacle at world (-4,-4))
  {
    clickBox: { x0: -4.5, z0: -4.5, x1: -0.5, z1: -0.5 },
    front: { x: -4.0, z: -3.0 },
    sit: { x: -2.2, z: -2.2 },
    faceAngle: -Math.PI / 4,
    sitY: POOL_SWIM_Y,
    swim: true,
  },
];

// ── 🛁 Hot-tub seats — soak together (hot-tub, 4 spots) ──────────────────────
// sitY 0.28: chest above the waterline of the raised drum, legs hidden inside.
// Fronts are just outside the 3×3 obstacle (blocked ones fall back to the
// nearest walkable cell via computeFront); sit positions are inside the tub.
const hotTubSeats: SeatTemplate[] = [
  {
    clickBox: { x0: 0.0, z0: -1.5, x1: 1.5, z1: 1.5 },
    front: { x: 1.85, z: 0.0 },
    sit: { x: 0.62, z: 0.0 },
    faceAngle: -Math.PI / 2,
    sitY: 0.28,
  },
  {
    clickBox: { x0: -1.5, z0: -1.5, x1: 0.0, z1: 1.5 },
    front: { x: -1.85, z: 0.0 },
    sit: { x: -0.62, z: 0.0 },
    faceAngle: Math.PI / 2,
    sitY: 0.28,
  },
  {
    clickBox: { x0: -1.5, z0: 0.0, x1: 1.5, z1: 1.5 },
    front: { x: 0.0, z: 1.85 },
    sit: { x: 0.0, z: 0.62 },
    faceAngle: Math.PI,
    sitY: 0.28,
  },
  {
    clickBox: { x0: -1.5, z0: -1.5, x1: 1.5, z1: 0.0 },
    front: { x: 0.0, z: -1.85 },
    sit: { x: 0.0, z: -0.62 },
    faceAngle: 0,
    sitY: 0.28,
  },
];

// 🏊 CLASSIC pool (PR #70 replica) seats — dive board on the EAST tower, four
// south-deck loungers, and the swim ring. Distinct from poolSeats (the #72
// rework moved the dive between the north doors + the hot tub to the centre).
const classicPoolSeats: SeatTemplate[] = [
  { clickBox: { x0: 2.5, z0: -2.5, x1: 4.9, z1: -1.1 },
    front: { x: 4.4, z: -1.75 }, sit: { x: 1.2, z: -1.75 },
    faceAngle: -Math.PI / 2, sitY: 4.55, dive: true },
  { clickBox: { x0: -4.4, z0: 4.0, x1: -3.2, z1: 5.2 },
    front: { x: -3.8, z: 3.75 }, sit: { x: -3.8, z: 4.5 },
    faceAngle: Math.PI, sitY: 0.36, lie: true },
  { clickBox: { x0: -2.7, z0: 4.0, x1: -1.5, z1: 5.2 },
    front: { x: -2.1, z: 3.75 }, sit: { x: -2.1, z: 4.5 },
    faceAngle: Math.PI, sitY: 0.36, lie: true },
  { clickBox: { x0: 1.1, z0: 4.0, x1: 2.3, z1: 5.2 },
    front: { x: 1.7, z: 3.75 }, sit: { x: 1.7, z: 4.5 },
    faceAngle: Math.PI, sitY: 0.36, lie: true },
  { clickBox: { x0: 2.8, z0: 4.0, x1: 4.0, z1: 5.2 },
    front: { x: 3.4, z: 3.75 }, sit: { x: 3.4, z: 4.5 },
    faceAngle: Math.PI, sitY: 0.36, lie: true },
  { clickBox: { x0: 0.5, z0: -1.5, x1: 4.5, z1: 1.5 },
    front: { x: 4.0, z: 0.0 }, sit: { x: 2.5, z: 0.0 },
    faceAngle: -Math.PI / 2, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: -4.5, z0: -1.5, x1: -0.5, z1: 1.5 },
    front: { x: -4.0, z: 0.0 }, sit: { x: -2.5, z: 0.0 },
    faceAngle: Math.PI / 2, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: -1.5, z0: 0.5, x1: 1.5, z1: 4.5 },
    front: { x: 0.0, z: 3.5 }, sit: { x: 0.0, z: 2.2 },
    faceAngle: Math.PI, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: -1.5, z0: -4.5, x1: 1.5, z1: -0.5 },
    front: { x: 0.0, z: -3.5 }, sit: { x: 0.0, z: -2.2 },
    faceAngle: 0, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: 0.5, z0: -4.5, x1: 4.5, z1: -0.5 },
    front: { x: 4.0, z: -3.5 }, sit: { x: 2.2, z: -2.2 },
    faceAngle: (-Math.PI * 3) / 4, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: 0.5, z0: 0.5, x1: 4.5, z1: 4.5 },
    front: { x: 4.0, z: 3.5 }, sit: { x: 2.2, z: 2.2 },
    faceAngle: (Math.PI * 3) / 4, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: -4.5, z0: 0.5, x1: -0.5, z1: 4.5 },
    front: { x: -4.0, z: 3.5 }, sit: { x: -2.2, z: 2.2 },
    faceAngle: Math.PI / 4, sitY: POOL_SWIM_Y, swim: true },
  { clickBox: { x0: -4.5, z0: -4.5, x1: -0.5, z1: -0.5 },
    front: { x: -4.0, z: -3.0 }, sit: { x: -2.2, z: -2.2 },
    faceAngle: -Math.PI / 4, sitY: POOL_SWIM_Y, swim: true },
];

const classicHotTubSeats: SeatTemplate[] = [
  { clickBox: { x0: 0.0, z0: -1.5, x1: 1.5, z1: 1.5 },
    front: { x: 1.85, z: 0.0 }, sit: { x: 0.62, z: 0.0 },
    faceAngle: -Math.PI / 2, sitY: 0.28 },
  { clickBox: { x0: -1.5, z0: -1.5, x1: 0.0, z1: 1.5 },
    front: { x: -1.85, z: 0.0 }, sit: { x: -0.62, z: 0.0 },
    faceAngle: Math.PI / 2, sitY: 0.28 },
  { clickBox: { x0: -1.5, z0: 0.0, x1: 1.5, z1: 1.5 },
    front: { x: 0.0, z: 1.85 }, sit: { x: 0.0, z: 0.62 },
    faceAngle: Math.PI, sitY: 0.28 },
  { clickBox: { x0: -1.5, z0: -1.5, x1: 1.5, z1: 0.0 },
    front: { x: 0.0, z: -1.85 }, sit: { x: 0.0, z: -0.62 },
    faceAngle: 0, sitY: 0.28 },
];

// 🎰 Roulette table (2×1 footprint): 6 standing positions ringing it. The -x
// SHORT END is the WHEEL HEAD — reserved for the owner / their croupier robot.
// Two positions on each long (z) face + one on the +x end make up the other 5.
// faceAngle points toward the table centre (atan2(nx,nz): +z=0,+x=π/2,-z=π,-x=-π/2).
// Offsets clear the table's collision zone so the avatar can stand exactly on
// each front (a front INSIDE the collision inflation leaves it stranded ~0.2 m
// short, which blocks the device-focus arrival). Long faces sit 1.0 m beyond
// the ±0.5 z-edge; the ends 0.9 m beyond the ±1.0 x-edge.
const rouletteStands: StandTemplate[] = [
  { stand: { x: -1.9, z: 0.0 }, faceAngle: Math.PI / 2, role: "wheelHead" },
  { stand: { x: 1.9, z: 0.0 }, faceAngle: -Math.PI / 2 },
  { stand: { x: -0.7, z: -1.5 }, faceAngle: 0 },
  { stand: { x: 0.7, z: -1.5 }, faceAngle: 0 },
  { stand: { x: -0.7, z: 1.5 }, faceAngle: Math.PI },
  { stand: { x: 0.7, z: 1.5 }, faceAngle: Math.PI },
];

// ♟️ Chess / game table (2×1): 2 positions facing off across the board.
const gameTableStands: StandTemplate[] = [
  { stand: { x: 0.0, z: -1.5 }, faceAngle: 0 },
  { stand: { x: 0.0, z: 1.5 }, faceAngle: Math.PI },
];

export const FURNITURE_DEFS: Record<FurnitureKind, FurnitureDef> = {
  "fireplace-wall": {
    kind: "fireplace-wall",
    build: buildFireplaceWall,
    footprint: { w: 10, d: 1 },
  },
  "sofa-back": {
    kind: "sofa-back",
    build: buildSofa3([
      [-0.72, 0, 0xc04060],
      [0, 0, 0x3870c8],
      [0.72, 0, 0xd89030],
    ]),
    footprint: { w: 3, d: 1 },
    seats: sofaBackSeats,
  },
  "sofa-front": {
    kind: "sofa-front",
    build: buildSofa3([
      [-0.72, -0.3, 0x50a870],
      [0, -0.3, 0xc04060],
      [0.72, -0.3, 0x3870c8],
    ]),
    footprint: { w: 3, d: 1 },
    seats: sofaFrontSeats,
  },
  "armchair-left": {
    kind: "armchair-left",
    build: buildArmchair(-1),
    footprint: { w: 1, d: 1 },
    seats: armchairLeftSeats,
  },
  "armchair-right": {
    kind: "armchair-right",
    build: buildArmchair(1),
    footprint: { w: 1, d: 1 },
    seats: armchairRightSeats,
  },
  "coffee-table-back": {
    kind: "coffee-table-back",
    build: buildCoffeeTableBack,
    footprint: { w: 2, d: 1 },
  },
  "coffee-table-front": {
    kind: "coffee-table-front",
    build: buildCoffeeTableFront,
    footprint: { w: 2, d: 1 },
  },
  // The DEFAULT bar keeps its hand-authored footprintOverride (the stool
  // strip); once MOVED the override sheds and this real footprint takes over
  // (2×3 covers counter + stools) so the bar still blocks walking. Wall-flush
  // re-placement is out of interior bounds — like the fireplace, sliding it
  // off the wall is one-way toward the room.
  "bar-corner": {
    kind: "bar-corner",
    build: buildBarCorner,
    footprint: { w: 2, d: 3 },
  },
  "lamp-table": {
    kind: "lamp-table",
    build: buildLampTable,
    footprint: { w: 1, d: 1 },
  },
  "casino-booth": {
    kind: "casino-booth",
    build: buildCasinoBooth,
    footprint: { w: 2, d: 1 },
    seats: casinoBoothSeats,
  },
  "casino-gold-wall": {
    kind: "casino-gold-wall",
    build: buildCasinoGoldWall,
    footprint: null,
  },
  "casino-orb-lamp": {
    kind: "casino-orb-lamp",
    build: buildCasinoOrbLamp,
    footprint: null,
  },
  "chandelier": {
    kind: "chandelier",
    build: buildChandelier,
    footprint: null,
  },
  "pendant-lamp": {
    kind: "pendant-lamp",
    build: buildPendantLamp,
    footprint: null,
  },
  "paper-lantern": {
    kind: "paper-lantern",
    build: buildPaperLantern,
    footprint: null,
  },
  "neon-ring": {
    kind: "neon-ring",
    build: buildNeonRing,
    footprint: null,
  },
  "sun-lamp": {
    kind: "sun-lamp",
    build: buildSunLamp,
    footprint: null,
  },
  "skylight": {
    kind: "skylight",
    build: buildSkylight,
    footprint: null,
  },
  "charging-dock": {
    kind: "charging-dock",
    build: buildChargingDock,
    footprint: null,
    functions: ["robotDock"],
    // 🤖 #77C s3: clicking the dock opens the robot PROGRAMMING panel. Approach
    // from the pad's +z side and face the control post (at local -z, plate y≈0.62).
    device: {
      kind: "robotDock",
      front: { x: 0, z: 1.0 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.2, z: 0.85 },
      anchor: { x: 0, y: 0.62, z: -0.4 },
    },
  },
  "rug-back": { kind: "rug-back", build: buildRugBack, footprint: null },
  "rug-front": { kind: "rug-front", build: buildRugFront, footprint: null },
  "cherry-tree": {
    kind: "cherry-tree",
    build: buildCherryTree,
    footprint: null,
  },
  "blossom-pot": {
    kind: "blossom-pot",
    build: buildBlossomPot,
    footprint: null,
  },
  // Wall-mounted room terminal (M1 of #33): footprint null — it hangs on the
  // wall plane and must never become an obstacle. Device template in the
  // local rot-0 frame (screen faces +z):
  //  - front 1.0 in front of the screen; faceAngle π = facing TOWARD the
  //    device (-z locally — opposite of the seats' back-to-chair convention)
  //  - eye at standing height 0.85 in front; anchor on the screen centre
  //    (panel centre y = 1.6, screen offset +0.02).
  "wall-computer": {
    kind: "wall-computer",
    build: buildWallComputer,
    footprint: null,
    functions: ["roomTerminal"],
    device: {
      kind: "roomTerminal",
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
  "map-table": {
    kind: "map-table",
    build: buildMapTable,
    footprint: { w: 2, d: 2 },
    functions: ["mapTable"],
    device: {
      kind: "mapTable",
      front: { x: 0, z: 1.5 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.6, z: 1.15 },
      anchor: { x: 0, y: MT_HOLO_Y, z: 0 },
    },
  },
  "storage-trunk": {
    kind: "storage-trunk",
    build: buildStorageTrunk,
    footprint: { w: 1, d: 1 },
    functions: ["storageTrunk"],
    device: {
      kind: "storageTrunk",
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
  "game-table": {
    kind: "game-table",
    build: buildGameTable,
    footprint: { w: 2, d: 1 },
    functions: ["gameTable"],
    stands: gameTableStands,
    device: {
      kind: "gameTable",
      front: { x: 0, z: -1.0 },
      faceAngle: 0,
      eye: { x: 0, y: 1.55, z: -0.95 },
      anchor: { x: 0, y: 0.82, z: 0 },
    },
  },
  // ── 🚀 Ship fittings (#30 SH1) — capability = the `functions` TAG, not the
  // kind (spaceship-conversion-plan.md invariant: future part variants tag
  // the same capability; the helm/exterior count by tag). ──
  // 🛰️ Dual-mode (hull work): tanks place on the interior floor as before AND
  // mount on the hull — where they provide the tankFace other layers stack on.
  "fuel-tank": {
    kind: "fuel-tank",
    build: buildFuelTank,
    footprint: { w: 2, d: 1 },
    functions: ["fuelTank"],
    mount: "both",
    attach: { accepts: ["wall", "tankFace"], provides: "tankFace" },
  },
  // 🚀 Main thrust array — EXTERIOR-WALL mounted (owner request): the engine
  // hangs on the OUTSIDE of a wall, bells pointing away from the room. The
  // capability tag is unchanged, so the helm/exterior ship checks still count
  // it; only the placement mode and the visual sculpt changed.
  "engine-block": {
    kind: "engine-block",
    build: buildEngineBlock,
    footprint: { w: 2, d: 1 },
    functions: ["engine"],
    // 🛰️ Engines accept the wall OR a tank stack's outer face — and provide
    // nothing: the bells stay outermost (clear exhaust, always).
    mount: "exterior-wall",
    attach: { accepts: ["wall", "tankFace"] },
  },
  // 🧱🪟 Modular wall sections (movable; placed on a side wall's line they
  // replace the built-in brick — see world.updateSideWallCoverage).
  "brick-wall": {
    kind: "brick-wall",
    build: buildBrickWall,
    footprint: { w: 4, d: 1 },
  },
  "window-wall": {
    kind: "window-wall",
    build: buildWindowWall,
    footprint: { w: 4, d: 1 },
  },
  // ── 🏝️ Poolside leisure anchors for the outdoor casino zone. ──
  // Interior leisure furniture (owner request: movable/removable like any
  // piece). No `mount` — a 7×6 pool / 3×3 tub is not a hull fitting, so edit
  // mode keeps them on the interior floor and never snaps them onto a wall.
  "lazy-pool": {
    kind: "lazy-pool",
    build: buildLazyPool,
    footprint: { w: 7, d: 6 },
    seats: poolSeats,
  },
  "hot-tub": {
    kind: "hot-tub",
    build: buildHotTub,
    footprint: { w: 3, d: 3 },
    seats: hotTubSeats,
  },
  // 🏊 Classic pool (PR #70 replica): east dive tower, corner hot tub.
  "classic-pool": {
    kind: "classic-pool",
    build: buildClassicPool,
    footprint: { w: 7, d: 6 },
    seats: classicPoolSeats,
  },
  "classic-hot-tub": {
    kind: "classic-hot-tub",
    build: buildClassicHotTub,
    footprint: { w: 3, d: 3 },
    seats: classicHotTubSeats,
  },
  // ── 🎰 Casino fixtures (#69 G1/G2) — device fronts face -z (helm idiom). ──
  "cashier-atm": {
    kind: "cashier-atm",
    build: buildCashierAtm,
    footprint: { w: 1, d: 1 },
    functions: ["casinoCashier"],
    device: {
      kind: "cashier",
      front: { x: 0, z: -1.0 },
      faceAngle: 0,
      eye: { x: 0, y: 1.5, z: -0.9 },
      anchor: { x: 0, y: 1.3, z: 0 },
    },
  },
  "roulette-table": {
    kind: "roulette-table",
    build: buildRouletteTable,
    footprint: { w: 2, d: 1 },
    functions: ["rouletteTable"],
    stands: rouletteStands,
    device: {
      kind: "roulette",
      front: { x: 0, z: -1.0 },
      faceAngle: 0,
      eye: { x: 0, y: 1.7, z: -0.95 },
      anchor: { x: 0, y: 0.85, z: 0 },
    },
  },
  // 🧬 Clone vat — the diegetic spawn point (owner request). 1×1 obstacle,
  // no seats. The DEVICE panel is the spawn-point picker ("wake up here");
  // the decant choreography itself stays with World.respawnAtVat. Front is
  // the door face (+z at rot 0 — the walk-out side).
  "clone-vat": {
    kind: "clone-vat",
    build: buildCloneVat,
    footprint: { w: 1, d: 1 },
    functions: ["cloneVat"],
    device: {
      kind: "cloneVat",
      front: { x: 0, z: 1.0 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.6, z: 0.95 },
      anchor: { x: 0, y: 1.2, z: 0 },
    },
  },
  // 🛏️ Bunk bed — two lie-down berths (SeatTemplates with sitY + lie), no
  // device. Footprint 2×1 = a real obstacle; builder + templates live below
  // (function declarations hoist, matching the ship-fittings precedent).
  "bunk-bed": {
    kind: "bunk-bed",
    build: buildBunkBed,
    footprint: { w: 2, d: 1 },
    functions: ["sleepBerth"],
    seats: bunkBedSeats,
  },
  "helm-console": {
    kind: "helm-console",
    build: buildHelmConsole,
    footprint: { w: 2, d: 1 },
    functions: ["helm"],
    device: {
      kind: "helm",
      front: { x: 0, z: -1.0 },
      faceAngle: 0,
      eye: { x: 0, y: 1.5, z: -0.9 },
      anchor: { x: 0, y: 1.05, z: 0.2 },
    },
  },
};

// ── 🚀 Ship fittings (#30 SH1) — the parts that turn a module into a ship ────
// Interior halves only; the EXTERIOR dress (engine bells on the hull, saddle
// tanks on the roof) renders in exteriorView.ts from the same furniture
// records. Function declarations (hoisted — FURNITURE_DEFS above references
// them; the other builders predate the table, these follow the game-table).

function buildFuelTank({ m, place }: BuildCtx) {
  // Skid + cradles + horizontal tank + hazard band + valve wheel.
  place(
    new THREE.BoxGeometry(1.7, 0.14, 0.8),
    m(0x2a3444, 0.7, 0.35),
    0,
    0.07,
    0,
  );
  for (const sx of [-0.55, 0.55]) {
    place(
      new THREE.BoxGeometry(0.14, 0.36, 0.78),
      m(0x2a3444, 0.7, 0.35),
      sx,
      0.3,
      0,
    );
  }
  const tank = place(
    new THREE.CylinderGeometry(0.36, 0.36, 1.55, 18),
    m(0xc8cdd8, 0.35, 0.75),
    0,
    0.72,
    0,
  );
  tank.rotation.z = Math.PI / 2;
  const band = place(
    new THREE.CylinderGeometry(0.37, 0.37, 0.18, 18),
    m(0xffb300, 0.5, 0.4),
    0,
    0.72,
    0,
  );
  band.rotation.z = Math.PI / 2;
  for (const sx of [-0.775, 0.775]) {
    const cap = place(
      new THREE.SphereGeometry(0.36, 14, 10),
      m(0xb8bfcc, 0.4, 0.7),
      sx,
      0.72,
      0,
    );
    cap.scale.x = 0.45;
  }
  const wheel = place(
    new THREE.TorusGeometry(0.11, 0.025, 8, 16),
    m(0xd4a84b, 0.45, 0.5),
    0,
    1.14,
    0,
  );
  wheel.rotation.x = Math.PI / 2;
  place(
    new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8),
    m(0x8a93a0, 0.5, 0.6),
    0,
    1.08,
    0,
  );
}

// 🚀 Main thrust array (owner request — DRASTIC rework of the old interior
// reactor pillar). Now an EXTERIOR-WALL mount, styled after the concept art's
// C-11 module stern: a gunmetal mounting plate flat against the hull, a
// clustered array of engine bells pointing local +z (AWAY from the room — the
// wall-derived rot guarantees that), orange feed-line straps lashed across
// the cluster, and a warm idle glow deep in every throat. Local frame:
// footprint 2×1, hull face at z = -0.5, bells reach to z ≈ +0.5.
function buildEngineBlock(ctx: BuildCtx) {
  const { m, flat, place, addLight } = ctx;
  const HULL = 0x8a93a0; // steel gray (station family)
  const DARKM = 0x37474f; // dark machinery
  const BODY = 0x2a3444; // gunmetal plate
  const PIPE_O = 0xe8760a; // orange feed lines (concept-art lashing)
  const GLOW = 0xfff0c8; // warm idle glow in the throats

  // Mounting plate + standoff frame against the hull
  place(new THREE.BoxGeometry(1.9, 2.3, 0.1), m(BODY, 0.6, 0.4), 0, 1.2, -0.44);
  place(
    new THREE.BoxGeometry(1.7, 2.1, 0.1),
    m(DARKM, 0.55, 0.45),
    0,
    1.2,
    -0.34,
  );
  for (const [bx, by] of [
    [-0.8, 0.25],
    [0.8, 0.25],
    [-0.8, 2.15],
    [0.8, 2.15],
  ] as [number, number][]) {
    place(
      new THREE.BoxGeometry(0.16, 0.16, 0.22),
      m(HULL, 0.5, 0.6),
      bx,
      by,
      -0.36,
    ); // corner standoffs
  }

  // Bell cluster: 3 big bells low, 2 staggered above (hex-ish packing like
  // the art). Each bell = gimbal block + throat + flared nozzle + rim + glow.
  const bells: Array<[number, number, number]> = [
    // [x, y, scale]
    [-0.62, 0.62, 1.0],
    [0.62, 0.62, 1.0],
    [0, 0.55, 1.15],
    [-0.34, 1.55, 0.85],
    [0.34, 1.55, 0.85],
  ];
  for (const [bx, by, s] of bells) {
    // Gimbal block on the plate
    place(
      new THREE.BoxGeometry(0.26 * s, 0.26 * s, 0.18),
      m(DARKM, 0.5, 0.5),
      bx,
      by,
      -0.24,
    );
    // Throat (narrow) → nozzle (flared) — cylinder axis is y, tip toward +z
    const throat = place(
      new THREE.CylinderGeometry(0.1 * s, 0.14 * s, 0.22, 12),
      m(HULL, 0.35, 0.75),
      bx,
      by,
      -0.08,
    );
    throat.rotation.x = Math.PI / 2;
    const nozzle = place(
      new THREE.CylinderGeometry(0.3 * s, 0.11 * s, 0.55, 16, 1, true),
      m(DARKM, 0.4, 0.7),
      bx,
      by,
      0.24,
    );
    nozzle.rotation.x = -Math.PI / 2;
    (nozzle.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    // Bell rim + warm glow disc recessed in the mouth
    const rim = place(
      new THREE.TorusGeometry(0.3 * s, 0.028, 8, 20),
      m(HULL, 0.4, 0.7),
      bx,
      by,
      0.51,
    );
    rim.rotation.x = 0; // torus already faces +z
    place(new THREE.CircleGeometry(0.2 * s, 16), flat(GLOW), bx, by, 0.4);
  }

  // Orange feed lines lashed across the cluster (horizontal + diagonal)
  for (const [ly, lz] of [
    [1.1, -0.18],
    [0.28, -0.2],
  ] as [number, number][]) {
    const line = place(
      new THREE.CylinderGeometry(0.035, 0.035, 1.75, 8),
      m(PIPE_O, 0.5, 0.4),
      0,
      ly,
      lz,
    );
    line.rotation.z = Math.PI / 2;
  }
  const diag = place(
    new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8),
    m(PIPE_O, 0.5, 0.4),
    0.1,
    1.2,
    -0.26,
  );
  diag.rotation.z = Math.PI / 3;
  // Coolant manifold ridge along the top + amber marker strip
  place(
    new THREE.BoxGeometry(1.5, 0.16, 0.3),
    m(HULL, 0.45, 0.65),
    0,
    2.32,
    -0.28,
  );
  place(
    new THREE.BoxGeometry(0.6, 0.06, 0.02),
    m(0xd4a84b, 0.4, 0.5, 0xd4a84b, 0.6),
    0,
    2.05,
    -0.285,
  );

  // Faint warm wash over the bell mouths (idle engines, not firing)
  addLight(new THREE.PointLight(0xffd9a0, 0, 4), 0, 1.1, 0.9, 0.9);
}

function buildHelmConsole({ m, flat, place }: BuildCtx) {
  // Flight desk + angled dash + main screen + throttle + stick.
  place(
    new THREE.BoxGeometry(1.7, 0.1, 0.7),
    m(0x2a3444, 0.6, 0.4),
    0,
    0.72,
    0,
  );
  for (const sx of [-0.72, 0.72]) {
    place(
      new THREE.BoxGeometry(0.14, 0.7, 0.6),
      m(0x37474f, 0.6, 0.4),
      sx,
      0.36,
      0,
    );
  }
  const dash = place(
    new THREE.BoxGeometry(1.6, 0.5, 0.08),
    m(0x1c262e, 0.6, 0.4),
    0,
    1.05,
    0.26,
  );
  dash.rotation.x = -0.5;
  const screen = place(
    new THREE.PlaneGeometry(1.3, 0.34),
    flat(0x0a2a3a),
    0,
    1.07,
    0.215,
  );
  screen.rotation.x = -0.5;
  const glowLine = place(
    new THREE.PlaneGeometry(1.1, 0.05),
    flat(0x00e5ff),
    0,
    1.12,
    0.2,
  );
  glowLine.rotation.x = -0.5;
  place(
    new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8),
    m(0xd4a84b, 0.45, 0.5),
    -0.45,
    0.86,
    -0.05,
  );
  place(
    new THREE.SphereGeometry(0.045, 10, 8),
    m(0xff1744, 0.5, 0.3),
    -0.45,
    0.97,
    -0.05,
  );
  place(
    new THREE.BoxGeometry(0.16, 0.05, 0.22),
    m(0x37474f, 0.5, 0.5),
    0.42,
    0.78,
    -0.05,
  );
}

// ── 🧱🪟 Modular wall sections (owner request) ────────────────────────────────
// Placeable wall pieces: a solid brick section and a WINDOW section with real
// glass. Placed along a structural side wall's line, they REPLACE it (world
// hides the built-in brick wall for that side — see updateSideWallCoverage),
// so a window section becomes a genuine view out: stars, the planet, and
// the docked-module projections beyond the glass.

function buildBrickWall({ m, place }: BuildCtx) {
  // Brick slab + mortar grooves + coping cap (matches the built-in wall look).
  place(new THREE.BoxGeometry(4, 3.4, 0.3), m(0x8a4a3a, 0.85, 0.05), 0, 1.7, 0);
  for (const gy of [0.6, 1.25, 1.9, 2.55]) {
    place(
      new THREE.BoxGeometry(3.96, 0.05, 0.32),
      m(0x1a2835, 0.9, 0.02),
      0,
      gy,
      0,
    );
  }
  place(
    new THREE.BoxGeometry(4.06, 0.12, 0.36),
    m(0xb8c8d8, 0.75, 0.05),
    0,
    3.46,
    0,
  );
}

function buildWindowWall({ m, place }: BuildCtx) {
  // Brick frame around a big glazed opening (1.0..2.6 high, 3.0 wide).
  place(new THREE.BoxGeometry(4, 1.0, 0.3), m(0x8a4a3a, 0.85, 0.05), 0, 0.5, 0); // sill course
  place(new THREE.BoxGeometry(4, 0.8, 0.3), m(0x8a4a3a, 0.85, 0.05), 0, 3.0, 0); // header course
  for (const sx of [-1.75, 1.75]) {
    place(
      new THREE.BoxGeometry(0.5, 1.6, 0.3),
      m(0x8a4a3a, 0.85, 0.05),
      sx,
      1.8,
      0,
    ); // jamb piers
  }
  place(
    new THREE.BoxGeometry(3.1, 0.1, 0.34),
    m(0x2a3444, 0.6, 0.4),
    0,
    1.02,
    0,
  ); // frame sill
  place(
    new THREE.BoxGeometry(3.1, 0.1, 0.34),
    m(0x2a3444, 0.6, 0.4),
    0,
    2.58,
    0,
  ); // frame head
  for (const sx of [-1.5, 0, 1.5]) {
    place(
      new THREE.BoxGeometry(0.08, 1.56, 0.34),
      m(0x2a3444, 0.6, 0.4),
      sx,
      1.8,
      0,
    ); // mullions
  }
  // The glass: barely-there blue, transparent both sides — the view is the point.
  const glass = place(
    new THREE.PlaneGeometry(3.0, 1.5),
    m(0x9bd4e8, 0.05, 0.1),
    0,
    1.8,
    0,
  );
  const gm = glass.material as THREE.MeshStandardMaterial;
  gm.transparent = true;
  gm.opacity = 0.16;
  gm.side = THREE.DoubleSide;
  place(
    new THREE.BoxGeometry(4.06, 0.12, 0.36),
    m(0xb8c8d8, 0.75, 0.05),
    0,
    3.46,
    0,
  ); // coping
}

// ── 🏝️ Outdoor leisure set — lazy pool + hot tub ────────────────────────────
// These are poolside scene anchors for the outdoor casino zone. Both are
// dual-mode mounts (`mount: 'both'`) so exterior-view rendering picks them up
// whenever their item position sits outside the room walls.

/** 🏊 White pool tile + blue-gray grout canvas (Habbo Lido idiom). The 64px
 *  canvas holds a 2×2 tile cell; repeat is chosen so one tile ≈ 0.5 m —
 *  i.e. pass the surface size in metres. */
function makePoolTileTex(
  rx: number,
  ry: number,
  blue = false,
): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 64;
  const c = cv.getContext("2d")!;
  // 🧊 Calippo-Lido palette: soft powder-blue tile with WHITE grout on the
  // walls; white checkerboard with a whisper of blue on the deck.
  c.fillStyle = blue ? "#FFFFFF" : "#D9E8F2"; // grout
  c.fillRect(0, 0, 64, 64);
  const cols = blue
    ? ["#A9CBE9", "#9FC4E5", "#B2D1EC", "#A4C8E7"] // pale sky-blue wall tile
    : ["#FFFFFF", "#EDF5FB", "#FBFDFF", "#EFF6FB"]; // white/blue-white checker
  const tiles: Array<[number, number, string]> = [
    [0, 0, cols[0]],
    [32, 0, cols[1]],
    [0, 32, cols[3]],
    [32, 32, cols[2]],
  ];
  for (const [x, y, fill] of tiles) {
    c.fillStyle = fill;
    c.fillRect(x + 1, y + 1, 30, 30);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Repeat doubled: the canvas holds a 2×2 cell, so this reads as ~0.25 m
  // tiles — the small, fine Habbo grid.
  tex.repeat.set(rx * 2, ry * 2);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tiled standard material wired for the morph fade-in (opacity 0 start). */
function poolTileMat(
  rx: number,
  ry: number,
  blue = false,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: makePoolTileTex(rx, ry, blue),
    roughness: 0.86,
    metalness: 0.03,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
}

/** 🌊 Vertical gradient canvas — `stops` top→bottom. Used for the infinity
 *  pool's depth-graded water and its dark overflow face. */
function makeGradientTex(stops: string[], w = 4, h = 128): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d")!;
  const g = c.createLinearGradient(0, 0, 0, h);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Unlit gradient material (fade-machinery wired, DoubleSide). */
function gradientMat(stops: string[]): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: makeGradientTex(stops),
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
}

/** 🌊 Radial water disc material — smooth deep-centre → light-rim gradient
 *  (stops[0] = centre). The continuous ramp is what reads as WATER, where
 *  hard concentric rings read as paint. */
function radialWaterMat(stops: string[]): THREE.MeshBasicMaterial {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 128;
  const c = cv.getContext("2d")!;
  const g = c.createRadialGradient(64, 64, 6, 64, 64, 64);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
  });
}

function buildLazyPool({ m, flat, place, addLight }: BuildCtx) {
  // Tropical island resort wrapped around the original functional basin.
  // Water bounds, surface height, dive coordinates and interaction tags stay
  // stable; this builder only changes the room's visual language.
  const TILE = 0xf3f9fb; // white pool tile (plain faces)
  const WATER_MID = 0x46aebd; // submerged basin walls (visible through water)
  const CHROME = 0xd8e2e8; // ladder metal
  const SAND = 0xe8d493;
  const SAND_LIGHT = 0xf2e2a8;
  const WOOD = 0x76502e;
  const WOOD_DARK = 0x4a321f;
  const LEAF = 0x397a3d;
  const LEAF_LIGHT = 0x58a94f;
  const ROCK = 0x66705f;
  const CHAIR_Y = 0xe6a72f;

  // Water basin: x[-3.4,3.4] z[-2.9,2.9] — the hole just inside the 7×6
  // footprint so the walkable corridors never overlap open water.
  const HX = POOL_WATER_EAST,
    HZ = POOL_WATER_HALFZ;
  const WATER_Y = -0.35; // keep == POOL_WATER_Y
  const EDGE_BOT = -0.95; // tiled deck-edge wall reaches below the water

  // 🌊 The water is ASYMMETRIC: it spans from the tiled east wall all the way
  // WEST to the room edge (the west deck IS water), meeting TWO infinity
  // edges — west and south — in an open L-shaped horizon corner.
  const WX = POOL_WATER_WEST; // west waterline (near the room bound)

  // ── Deck slabs: north + south full width, east only (no west deck).
  place(
    new THREE.BoxGeometry(10.4, 0.12, 5.2 - HZ),
    poolTileMat(10.4, 5.2 - HZ),
    0,
    0.06,
    -(HZ + (5.2 - HZ) / 2),
  );
  place(
    new THREE.BoxGeometry(10.4, 0.12, 5.2 - HZ),
    poolTileMat(10.4, 5.2 - HZ),
    0,
    0.06,
    HZ + (5.2 - HZ) / 2,
  );
  place(
    new THREE.BoxGeometry(5.2 - HX, 0.12, HZ * 2),
    poolTileMat(5.2 - HX, HZ * 2),
    HX + (5.2 - HX) / 2,
    0.06,
    0,
  );

  // Warm sand overlays turn the three walkable deck bands into one island.
  // They are visual skins only; the lazy-pool footprint remains authoritative.
  place(
    new THREE.BoxGeometry(10.35, 0.035, 5.15 - HZ),
    m(SAND, 0.98, 0),
    0,
    0.14,
    -(HZ + (5.15 - HZ) / 2),
  );
  place(
    new THREE.BoxGeometry(10.35, 0.035, 5.15 - HZ),
    m(SAND_LIGHT, 0.98, 0),
    0,
    0.14,
    HZ + (5.15 - HZ) / 2,
  );
  place(
    new THREE.BoxGeometry(5.15 - HX, 0.035, HZ * 2),
    m(SAND, 0.98, 0),
    HX + (5.15 - HX) / 2,
    0.14,
    0,
  );

  const mkRock = (x: number, z: number, scale: number, color = ROCK) => {
    const rock = place(
      new THREE.DodecahedronGeometry(0.42 * scale, 0),
      m(color, 0.96, 0.02),
      x,
      0.28 * scale,
      z,
    );
    rock.scale.set(1.0, 0.78, 0.82);
  };
  const mkPalm = (x: number, z: number, scale = 1, lean = 0) => {
    const trunk = place(
      new THREE.CylinderGeometry(0.11 * scale, 0.18 * scale, 1.75 * scale, 7),
      m(0x8a5a31, 0.92, 0.02),
      x,
      0.98 * scale,
      z,
    );
    trunk.rotation.z = lean;
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2;
      const crownX = x + Math.sin(lean) * 0.55 * scale;
      const leaf = place(
        new THREE.ConeGeometry(0.26 * scale, 1.35 * scale, 5),
        m(i % 2 ? LEAF : LEAF_LIGHT, 0.94, 0.01),
        crownX,
        1.92 * scale,
        z,
        angle,
      );
      leaf.rotation.z = Math.PI / 2.8;
      leaf.rotation.y = angle;
    }
    place(
      new THREE.SphereGeometry(0.16 * scale, 7, 5),
      m(0x5b3a22, 0.9, 0.01),
      x,
      1.88 * scale,
      z,
    );
  };

  // Dense rocky planting at the far corners frames the room without blocking
  // either paired north door or the near-camera south/east sightlines.
  for (const [rx, rz, rs] of [
    [-4.9, -4.9, 1.2],
    [-4.35, -5.0, 0.9],
    [4.35, -4.95, 1.05],
    [4.9, -4.65, 0.8],
    [-5.0, -4.25, 0.85],
    [5.0, -4.1, 0.75],
  ] as Array<[number, number, number]>)
    mkRock(rx, rz, rs);
  mkPalm(-4.45, -4.25, 0.92, -0.08);
  mkPalm(4.55, -4.05, 0.86, 0.08);

  // ── Deck-edge walls: tiled on north/east; gradient infinity faces on the
  // south (weir) and WEST (open horizon into space).
  const edgeH = 0.12 - EDGE_BOT;
  const edgeY = (0.12 + EDGE_BOT) / 2;
  const spanW = WX + HX; // north/south edge length (west→east)
  const spanC = (HX - WX) / 2; // its centre x
  place(
    new THREE.BoxGeometry(spanW, edgeH, 0.12),
    poolTileMat(spanW, edgeH),
    spanC,
    edgeY,
    -(HZ - 0.06),
  );
  place(
    new THREE.BoxGeometry(spanW, edgeH, 0.12),
    gradientMat(["#2A6E86", "#153B54", "#060E1C"]),
    spanC,
    edgeY,
    HZ - 0.06,
  ); // 🌊 south weir
  place(
    new THREE.BoxGeometry(0.12, edgeH, HZ * 2),
    gradientMat(["#2A6E86", "#153B54", "#060E1C"]),
    -(WX - 0.06),
    edgeY,
    0,
  ); // 🌊 west horizon
  place(
    new THREE.BoxGeometry(0.12, edgeH, HZ * 2),
    poolTileMat(HZ * 2, edgeH),
    HX - 0.06,
    edgeY,
    0,
  );
  // White coping band on the DECK edges only (north + east) — both infinity
  // edges stay bare so the waterline is the last thing you see.
  place(
    new THREE.BoxGeometry(spanW + 0.3, 0.07, 0.4),
    m(0xfafdfe, 0.8, 0.03),
    spanC,
    0.155,
    -HZ,
  );
  place(
    new THREE.BoxGeometry(0.4, 0.07, HZ * 2),
    m(0xfafdfe, 0.8, 0.03),
    HX,
    0.155,
    0,
  );

  // ── Stepped deck peninsulas cutting into the basin — breaks the boring
  // rectangle into the meandering Habbo pool outline. Full-height white-tile
  // blocks inside the (unwalkable) footprint zone, purely visual.
  const mkCut = (x0: number, z0: number, x1: number, z1: number) => {
    const w = x1 - x0,
      d = z1 - z0;
    place(
      new THREE.BoxGeometry(w, 0.12 - EDGE_BOT, d),
      poolTileMat(Math.max(w, d), 1.1),
      (x0 + x1) / 2,
      (0.12 + EDGE_BOT) / 2,
      (z0 + z1) / 2,
    );
    place(
      new THREE.BoxGeometry(w + 0.16, 0.07, d + 0.16),
      m(0xfafdfe, 0.8, 0.03),
      (x0 + x1) / 2,
      0.155,
      (z0 + z1) / 2,
    );
  };
  mkCut(2.55, -2.9, 3.4, -2.05); // NE corner peninsula

  // ── Submerged basin lining: teal walls read through the water — the
  // layered turquoise Habbo look. North + east only (infinity edges bare).
  place(
    new THREE.BoxGeometry(WX + HX - 0.2, 0.65, 0.06),
    flat(WATER_MID),
    (HX - WX) / 2,
    -0.625,
    -(HZ - 0.15),
  );
  place(
    new THREE.BoxGeometry(0.06, 0.65, HZ * 2 - 0.1),
    flat(WATER_MID),
    HX - 0.15,
    -0.625,
    0,
  );

  // (The central timber pavilion / pool bar that used to fill the north gap
  //  was removed — the 🤖 PoolWaiter robot serves drinks table-side instead;
  //  see poolWaiter.ts. The potted greenery below stays as north-deck decor.)

  // Dense potted greenery on the north deck.
  for (const [plantX, plantZ] of [
    [-2.05, -4.65],
    [2.05, -4.6],
    [-2.12, -3.45],
    [2.12, -3.42],
  ] as Array<[number, number]>) {
    place(
      new THREE.CylinderGeometry(0.22, 0.18, 0.34, 8),
      m(0xb7733c, 0.9, 0.02),
      plantX,
      0.31,
      plantZ,
    );
    for (const leafAngle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const leaf = place(
        new THREE.ConeGeometry(0.13, 0.7, 5),
        m(leafAngle === 0 ? LEAF_LIGHT : LEAF, 0.9, 0.01),
        plantX,
        0.76,
        plantZ,
      );
      leaf.rotation.z = Math.PI / 2.7;
      leaf.rotation.y = leafAngle;
    }
  }

  // ── Lazy river: an irregular outer bank curls around the central hot-tub
  // island. The established swim bounds stay intact for multiplayer state.
  // Hoisted to module scope (lazyRiverShape) so poolHoleCells cuts the floor to
  // the SAME curve — the water and the hole always agree.
  const makeLazyRiver = lazyRiverShape;

  // 🕳️ #80: solid rect pool BOTTOM across the full water footprint. With the
  // octagon floor hole cut, looking down the hole you see a real basin bottom
  // sinking into the basement instead of the void; without the octagon flag the
  // legacy hidden-floor pool is unchanged (skip it). Sits just under the
  // organic lazy-river tint, which the rect can't reach in the corners.
  if (OCTAGON_HULL) {
    place(
      new THREE.BoxGeometry(WX + HX, 0.08, HZ * 2),
      m(0x0e3244, 0.98, 0.02),
      (HX - WX) / 2,
      EDGE_BOT - 0.02,
      0,
    );
  }

  const tintGeo = new THREE.ShapeGeometry(makeLazyRiver(), 48);
  tintGeo.rotateX(-Math.PI / 2);
  const tint = place(tintGeo, flat(0x1c5a74), 0, EDGE_BOT + 0.01, 0);
  (tint.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.95;

  const waterGeo = new THREE.ShapeGeometry(makeLazyRiver(), 48);
  waterGeo.rotateX(-Math.PI / 2);
  const water = place(
    waterGeo,
    gradientMat(["#7CD8DF", "#3FA9BC", "#1F6E88"]),
    0,
    WATER_Y,
    0,
  );
  (water.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.85;

  // Raised sandy island supports the hot tub and makes the river loop legible.
  place(
    new THREE.CylinderGeometry(1.55, 1.65, 0.18, 36),
    m(SAND_LIGHT, 0.98, 0),
    0,
    0.09,
    0,
  );
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const rock = place(
      new THREE.DodecahedronGeometry(0.22 + (i % 3) * 0.025, 0),
      m(i % 2 ? 0x9f9278 : 0x887b66, 0.96, 0.01),
      Math.cos(angle) * 1.58,
      0.15,
      Math.sin(angle) * 1.31,
      -angle,
    );
    rock.scale.set(1.35, 0.55, 0.75);
  }

  // A short timber footbridge runs through the centre gap between the south
  // beach chairs, linking that deck to the hot-tub island.
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    const bridgeZ = BRIDGE_Z_ISLAND + t * (BRIDGE_Z_SHORE - BRIDGE_Z_ISLAND);
    const bridgeY = bridgeTopAt(bridgeZ) - BRIDGE_PLANK_HALF;
    place(
      new THREE.BoxGeometry(BRIDGE_HALF_W * 2, 0.08, 0.24),
      m(i % 2 ? WOOD : WOOD_DARK, 0.84, 0.05),
      BRIDGE_X,
      bridgeY,
      bridgeZ,
    );
  }

  // Habbo pool-party floaties: striped ring, beach ball and green raft.
  const ring = place(
    new THREE.TorusGeometry(0.42, 0.14, 8, 16),
    m(0xe84e55, 0.6, 0.03),
    -2.85,
    WATER_Y + 0.12,
    -1.75,
  );
  ring.rotation.x = Math.PI / 2;
  const ball = place(
    new THREE.SphereGeometry(0.34, 10, 8),
    m(0xf5d94e, 0.55, 0.03),
    1.8,
    WATER_Y + 0.3,
    -1.35,
  );
  ball.rotation.z = 0.35;
  const raft = place(
    new THREE.CapsuleGeometry(0.32, 1.35, 5, 10),
    m(0x67bd4c, 0.65, 0.02),
    0.25,
    WATER_Y + 0.12,
    1.7,
  );
  raft.rotation.z = Math.PI / 2;
  raft.rotation.y = -0.25;
  for (const eyeX of [-0.34, 0.34]) {
    place(
      new THREE.SphereGeometry(0.08, 7, 5),
      flat(0xf5f7e9),
      0.9 + eyeX,
      WATER_Y + 0.28,
      1.53,
    );
  }

  // Sparkle flecks on the surface (fixed pseudo-random layout).
  const sparkles: Array<[number, number]> = [
    [-2.6, -1.9],
    [-1.3, -2.3],
    [0.4, -1.6],
    [1.9, -2.1],
    [2.8, -0.9],
    [-2.9, 0.4],
    [-1.6, 1.2],
    [-0.2, 0.6],
    [1.1, 1.7],
    [2.4, 0.9],
    [-2.1, 2.2],
    [-0.8, -0.6],
    [0.9, -0.2],
    [2.0, 2.3],
    [-4.5, -1.8],
    [-4.1, 0.6],
    [-4.7, 1.9],
    [-3.8, -0.4], // west expanse
  ];
  for (const [sx, sz] of sparkles) {
    const fleckGeo = new THREE.PlaneGeometry(0.09, 0.09);
    fleckGeo.rotateX(-Math.PI / 2);
    const fleck = place(fleckGeo, flat(0xffffff), sx, WATER_Y + 0.01, sz);
    (fleck.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.8;
  }

  // Buoy lines with little red flags meandering across the water (Habbo Lido
  // marks its swim lanes with flagged buoy strings, not straight lane ropes).
  for (const z of [-0.95, 1.05]) {
    const rope = place(
      new THREE.BoxGeometry(WX + HX - 0.4, 0.03, 0.03),
      flat(0xf4fbff),
      (HX - WX) / 2,
      WATER_Y + 0.02,
      z,
    );
    (rope.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.9;
    let idx = 0;
    for (let x = -4.8; x <= 3.0; x += 0.6) {
      const c = idx % 2 === 0 ? 0xe04040 : 0xf6fafc;
      const buoy = place(
        new THREE.SphereGeometry(0.06, 8, 6),
        m(c, 0.56, 0.04),
        x,
        WATER_Y + 0.03,
        z,
      );
      buoy.scale.y = 0.6;
      // 🚩 Every 5th buoy carries a red flag on a tiny mast.
      if (idx % 5 === 0) {
        place(
          new THREE.CylinderGeometry(0.008, 0.008, 0.18, 4),
          m(0xb9c4cc, 0.6, 0.2),
          x,
          WATER_Y + 0.12,
          z,
        );
        place(
          new THREE.BoxGeometry(0.1, 0.06, 0.012),
          m(0xe03030, 0.8, 0.02),
          x + 0.06,
          WATER_Y + 0.17,
          z,
        );
      }
      idx++;
    }
  }

  // ── Chrome ladders hooked over the deck edge into the water. ──
  const chrome = () => m(CHROME, 0.35, 0.65);
  const mkLadder = (side: 1 | -1, lz: number) => {
    for (const dz of [-0.18, 0.18]) {
      // Rail dropping from deck level into the water, hugging the edge wall.
      place(
        new THREE.CylinderGeometry(0.032, 0.032, 1.0, 8),
        chrome(),
        side * (HX - 0.14),
        -0.28,
        lz + dz,
      );
      // Hook over the coping onto the deck.
      const hook = place(
        new THREE.CylinderGeometry(0.03, 0.03, 0.36, 8),
        chrome(),
        side * (HX + 0.02),
        0.24,
        lz + dz,
      );
      hook.rotation.z = Math.PI / 2;
      place(
        new THREE.CylinderGeometry(0.03, 0.03, 0.24, 8),
        chrome(),
        side * (HX + 0.18),
        0.14,
        lz + dz,
      );
    }
    for (const ry of [0.0, -0.3, -0.6]) {
      const rung = place(
        new THREE.CylinderGeometry(0.022, 0.022, 0.4, 8),
        chrome(),
        side * (HX - 0.14),
        ry,
        lz,
      );
      rung.rotation.x = Math.PI / 2;
    }
  };
  mkLadder(1, -1.6); // east rim only — the west edge is open water horizon

  // ── Tiled steps descending from the deck into the SE corner of the water. ──
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    2.5,
    0.0,
    2.62,
  );
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    2.5,
    -0.2,
    2.3,
  );
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    2.5,
    -0.4,
    1.98,
  );

  // ── Matching white steps on the NORTH edge — pool water up toward the hot
  // tub (mirror of the SE entry steps, same build).
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    -3.7,
    0.0,
    -2.62,
  );
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    -3.7,
    -0.2,
    -2.3,
  );
  place(
    new THREE.BoxGeometry(1.1, 0.16, 0.36),
    m(TILE, 0.8, 0.03),
    -3.7,
    -0.4,
    -1.98,
  );

  // Golden teak loungers on the beach, retaining the existing lie-down seats.
  const mkLounger = (bx: number, bz: number) => {
    const GRN = CHAIR_Y,
      GRN_D = 0xb97824,
      F = WOOD_DARK;
    // low frame feet
    place(
      new THREE.BoxGeometry(0.64, 0.18, 0.12),
      m(F, 0.7, 0.1),
      bx,
      0.09,
      bz - 0.78,
    );
    place(
      new THREE.BoxGeometry(0.64, 0.18, 0.12),
      m(F, 0.7, 0.1),
      bx,
      0.09,
      bz + 0.72,
    );
    // solid green bed with slat grooves (darker green seams)
    place(
      new THREE.BoxGeometry(0.72, 0.11, 1.7),
      m(GRN, 0.75, 0.04),
      bx,
      0.24,
      bz,
    );
    for (let i = 1; i < 5; i++) {
      place(
        new THREE.BoxGeometry(0.73, 0.02, 0.04),
        m(GRN_D, 0.8, 0.03),
        bx,
        0.3,
        bz - 0.85 + i * 0.34,
      );
    }
    // inclined backrest
    const back = place(
      new THREE.BoxGeometry(0.72, 0.08, 0.8),
      m(GRN, 0.75, 0.04),
      bx,
      0.46,
      bz + 0.62,
    );
    back.rotation.x = -0.55;
  };
  mkLounger(-3.8, 4.6);
  mkLounger(-2.1, 4.6);
  mkLounger(1.7, 4.6);
  mkLounger(3.4, 4.6);

  // Small parasol café sets on the east beach — original warm canopies,
  // smooth 12-segment cones with a white rim band. Spread evenly along the
  // east strip (thirds of its length), chairs north/south of each table so
  // the sets stay compact against the wall.
  const mkParasolSet = (px: number, pz: number, canopy: number) => {
    place(
      new THREE.CylinderGeometry(0.045, 0.045, 1.9, 8),
      m(0xe8edf0, 0.6, 0.2),
      px,
      0.95,
      pz,
    );
    place(
      new THREE.ConeGeometry(0.9, 0.48, 12),
      m(canopy, 0.8, 0.02),
      px,
      2.1,
      pz,
    );
    // Rim band under the canopy edge — the tidy white valance.
    place(
      new THREE.CylinderGeometry(0.88, 0.9, 0.06, 12),
      m(0xeef2f4, 0.82, 0.02),
      px,
      1.87,
      pz,
    );
    place(
      new THREE.SphereGeometry(0.06, 8, 6),
      m(0xf6fafc, 0.7, 0.1),
      px,
      2.4,
      pz,
    );
    place(
      new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12),
      m(0xf6fafc, 0.8, 0.04),
      px,
      0.5,
      pz,
    );
    place(
      new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8),
      m(0xb9c4cc, 0.6, 0.2),
      px,
      0.25,
      pz,
    );
    place(
      new THREE.BoxGeometry(0.34, 0.3, 0.34),
      m(CHAIR_Y, 0.75, 0.04),
      px - 0.15,
      0.15,
      pz - 0.6,
    );
    place(
      new THREE.BoxGeometry(0.34, 0.3, 0.34),
      m(CHAIR_Y, 0.75, 0.04),
      px + 0.15,
      0.15,
      pz + 0.6,
    );
  };
  mkParasolSet(4.6, -1.7, 0xe9d9b5);
  mkParasolSet(4.6, 2.0, 0xd8643b);

  // Reference-style stepping-stone trail and a low beach fire pit.
  for (const [ix, iz, ir] of [
    [3.9, 4.75, -0.12],
    [4.05, 4.15, 0.1],
    [3.88, 3.55, -0.08],
    [4.02, 2.95, 0.12],
  ] as Array<[number, number, number]>) {
    const step = place(
      new THREE.BoxGeometry(0.68, 0.07, 0.34),
      m(WOOD_DARK, 0.9, 0.02),
      ix,
      0.19,
      iz,
      ir,
    );
    step.rotation.y = ir;
  }
  place(
    new THREE.CylinderGeometry(0.5, 0.58, 0.18, 10),
    m(ROCK, 0.96, 0.02),
    0,
    0.22,
    4.35,
  );
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    mkRock(
      Math.cos(angle) * 0.46,
      4.35 + Math.sin(angle) * 0.46,
      0.38,
      0x7b7566,
    );
  }
  const flame = place(
    new THREE.ConeGeometry(0.18, 0.52, 7),
    m(0xf28a24, 0.55, 0.02, 0xf28a24, 0.8),
    0,
    0.58,
    4.35,
  );
  flame.rotation.y = Math.PI / 7;

  // Blue-and-white tiled dive tower, matching the hot tub shell and trim.
  // Centred in the gap between the two north doors (x ±2.7) with the board
  // reaching SOUTH over the water — keeps the camera-near east side open.
  const towerX = 0;
  const towerZ = -4.35;
  const DIVE_TRIM = 0xfafdfe;
  const DIVE_BLUE = 0x8ed5e8;
  const DIVE_BLUE_DARK = 0x318ca8;
  // Open tiled scaffold. Every member is a generous click target for the
  // dive seat while leaving the pool and beach visible through the tower.
  for (const xOffset of [-0.42, 0.42]) {
    for (const zOffset of [-0.42, 0.42]) {
      const post = place(
        new THREE.BoxGeometry(0.12, 5.0, 0.12),
        poolTileMat(5.0, 0.24, true),
        towerX + xOffset,
        2.5,
        towerZ + zOffset,
      );
      post.userData.isDiveTower = true;
    }
  }
  for (const railY of [1.2, 2.4, 3.6, 4.25]) {
    for (const zOffset of [-0.42, 0.42]) {
      const rail = place(
        new THREE.BoxGeometry(0.96, 0.1, 0.1),
        m(DIVE_TRIM, 0.7, 0.08),
        towerX,
        railY,
        towerZ + zOffset,
      );
      rail.userData.isDiveTower = true;
    }
    for (const xOffset of [-0.42, 0.42]) {
      const rail = place(
        new THREE.BoxGeometry(0.1, 0.1, 0.96),
        m(DIVE_TRIM, 0.7, 0.08),
        towerX + xOffset,
        railY,
        towerZ,
      );
      rail.userData.isDiveTower = true;
    }
  }
  const towerDeck = place(
    new THREE.BoxGeometry(1.08, 0.12, 1.08),
    poolTileMat(1.08, 1.08, true),
    towerX,
    4.42,
    towerZ,
  );
  towerDeck.userData.isDiveTower = true;
  // Existing pyramid roof, rotated 45° so its four faces read square.
  const spire = place(
    new THREE.ConeGeometry(0.85, 0.95, 4),
    m(DIVE_BLUE_DARK, 0.66, 0.08),
    towerX,
    5.5,
    towerZ,
  );
  spire.rotation.y = Math.PI / 4;
  spire.userData.isDiveTower = true;

  // Main board over pool ("El trampolín") — wide white plank, clickable:
  // isDiveTower routes a click on the board itself onto the board seat.
  const board = place(
    new THREE.BoxGeometry(0.6, 0.08, 2.9),
    m(DIVE_TRIM, 0.62, 0.12),
    towerX,
    4.55,
    towerZ + 1.45,
  );
  board.userData.isDiveTower = true;
  const boardUnder = place(
    new THREE.BoxGeometry(0.6, 0.03, 2.9),
    m(DIVE_BLUE, 0.72, 0.06),
    towerX,
    4.49,
    towerZ + 1.45,
  );
  boardUnder.userData.isDiveTower = true;
  const boardSupportA = place(
    new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6),
    m(0x6d8998, 0.56, 0.24),
    towerX,
    3.95,
    towerZ + 1.6,
  );
  boardSupportA.userData.isDiveTower = true;
  const boardSupportB = place(
    new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6),
    m(0x6d8998, 0.56, 0.24),
    towerX,
    3.95,
    towerZ + 2.3,
  );
  boardSupportB.userData.isDiveTower = true;

  // (The purely decorative secondary lookout that stood at the east edge was
  //  removed — the east side stays fully open now that the dive tower lives
  //  between the north doors.)

  // Gentle volume lights — underwater cyan glow + tree-line/tower fill.
  addLight(new THREE.PointLight(0x56ceff, 0, 11.0), 0.0, -0.85, 0, 13.0);
  addLight(new THREE.PointLight(0x2ba8e2, 0, 6.5), -2.6, -0.85, 0.2, 6.4);
  addLight(new THREE.PointLight(0x2ba8e2, 0, 6.5), 2.6, -0.85, 0.2, 6.4);
  addLight(new THREE.PointLight(0xb7e7ff, 0, 7.2), 0.0, 1.55, -3.98, 4.8);
  addLight(new THREE.PointLight(0xa8e5ff, 0, 4.2), towerX, 3.2, towerZ, 3.8);
}

function buildHotTub({ m, flat, place, addLight }: BuildCtx) {
  // ♨️ Calippo-Lido spa, SCULPTED for depth: stepped white-tile pedestal
  // tiers lift a taller drum off the deck, a dark shadow ring reads as the
  // basin dropping away under the rim, and the water is concentric unlit
  // discs stepping light rim → deep centre. Clean silhouette — no rocks,
  // no planting, nothing on the rim (foxes sit IN it).
  const TRIM = 0xfafdfe,
    GLOW = 0x69ceff;

  // Stepped pedestal + drum — clad in the SAME pale-blue tile as the dive
  // tower (poolTileMat blue variant; repeat ≈ circumference × height).
  place(
    new THREE.CylinderGeometry(1.7, 1.7, 0.14, 36),
    poolTileMat(10.7, 0.3, true),
    0,
    0.07,
    0,
  );
  place(
    new THREE.CylinderGeometry(1.55, 1.55, 0.46, 36, 1, true),
    poolTileMat(9.7, 0.46, true),
    0,
    0.35,
    0,
  );
  // White cap ring.
  const capRing = place(
    new THREE.TorusGeometry(1.36, 0.1, 8, 36),
    m(TRIM, 0.7, 0.08),
    0,
    0.62,
    0,
  );
  capRing.rotation.x = Math.PI / 2;

  // Dark shadow disc just under the waterline — the basin falling away.
  const shadow = place(
    new THREE.CylinderGeometry(1.3, 1.3, 0.012, 36),
    flat(0x0f4a60),
    0,
    0.552,
    0,
  );
  (shadow.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.92;

  // 🌊 Water: ONE smooth radial-gradient disc — deep centre melting to a
  // light rim, the same colour stops as the main pool's water. Continuous
  // like real water, no ring banding.
  const water = place(
    new THREE.CylinderGeometry(1.28, 1.28, 0.014, 36),
    radialWaterMat(["#082E44", "#0E5872", "#2D8EA5"]),
    0,
    0.565,
    0,
  );
  (water.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.98;
  // ♨️ CHURN — what makes it read "hot tub" and not "pond": a boiling mound
  // at the centre, scattered surface bubbles, and white jet swirls where the
  // nozzles churn the wall. All sit ON the layered water.
  const boil = place(
    new THREE.SphereGeometry(0.22, 12, 8),
    m(0xf2fbfd, 0.9, 0.0),
    0,
    0.585,
    0,
  );
  boil.scale.y = 0.32;
  (boil.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.42;
  const bubbles: Array<[number, number, number]> = [
    [0.44, 0.13, 0.055],
    [-0.38, 0.31, 0.045],
    [0.19, -0.5, 0.055],
    [-0.56, -0.25, 0.045],
    [0.69, -0.19, 0.04],
    [-0.19, 0.63, 0.05],
    [0.5, 0.5, 0.04],
    [-0.69, 0.44, 0.045],
    [0.1, 0.28, 0.035],
    [-0.31, -0.65, 0.04],
    [0.85, 0.25, 0.04],
    [-0.8, -0.5, 0.035],
  ];
  for (const [bx, bz, br] of bubbles) {
    const bub = place(
      new THREE.SphereGeometry(br, 8, 6),
      m(0xf6fdff, 0.85, 0.0),
      bx,
      0.59,
      bz,
    );
    bub.scale.y = 0.4;
    (bub.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.55;
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const swirl = place(
      new THREE.SphereGeometry(0.12, 8, 6),
      m(0xeffcff, 0.85, 0.0),
      Math.cos(a) * 1.02,
      0.585,
      Math.sin(a) * 1.02,
    );
    swirl.scale.set(1.2, 0.28, 0.6);
    swirl.rotation.y = -a;
    (swirl.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.4;
  }

  // Foam ring hugging the rim + cyan LED line beneath the cap.
  const foam = place(
    new THREE.TorusGeometry(1.16, 0.04, 6, 36),
    flat(0xeffcff),
    0,
    0.575,
    0,
  );
  foam.rotation.x = Math.PI / 2;
  (foam.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.85;
  const rim = place(
    new THREE.TorusGeometry(1.46, 0.04, 6, 36),
    flat(GLOW),
    0,
    0.5,
    0,
  );
  rim.rotation.x = Math.PI / 2;
  (rim.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.92;

  // Steam wisps drifting over the water.
  for (const [sx, sy, sz, sc] of [
    [-0.22, 0.87, -0.1, 0.11],
    [0.18, 0.93, 0.15, 0.1],
    [0.06, 0.83, -0.22, 0.09],
  ] as [number, number, number, number][]) {
    const puff = place(
      new THREE.SphereGeometry(sc, 10, 8),
      m(0xeaf5fb, 0.9, 0.0),
      sx,
      sy,
      sz,
    );
    (puff.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.32;
  }

  // Underwater LED glow + soft edge fill.
  addLight(new THREE.PointLight(0x69ceff, 0, 3.6), 0, 0.5, 0, 3.2);
  addLight(new THREE.PointLight(0xcfe8f4, 0, 1.8), 1.1, 0.65, -0.55, 0.7);
}

// ── 🎰 Casino fixtures (#69 G1/G2) — cashier ATM + roulette table ────────────
// Canvas-textured faces follow the game-table idiom: MeshBasicMaterial with
// transparent + opacity 0 so the morph fade-in machinery raises them with
// everything else. Focused UIs live in devices.ts (createCashierUI /
// createRouletteUI); these builders are the in-world halves.

/** Cashier sign face: 'CASHIER · CHIPS' gold on dark with a chip pip. */
function drawCashierSign(c2d: CanvasRenderingContext2D): void {
  const W = 256,
    H = 128;
  c2d.fillStyle = "#0A0E1A";
  c2d.fillRect(0, 0, W, H);
  c2d.strokeStyle = "#D4A84B";
  c2d.lineWidth = 4;
  c2d.strokeRect(6, 6, W - 12, H - 12);
  c2d.fillStyle = "#F0C060";
  c2d.font = "bold 34px monospace";
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  c2d.fillText("CASHIER", W / 2, 42);
  c2d.font = "bold 22px monospace";
  c2d.fillStyle = "#FF2D95";
  c2d.fillText("· CHIPS ·", W / 2, 88);
}

/** Cashier screen face: idle attract loop, drawn once (static in-world). */
function drawCashierScreen(c2d: CanvasRenderingContext2D): void {
  const W = 256,
    H = 192;
  c2d.fillStyle = "#06121C";
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = "#0E2A38";
  c2d.fillRect(8, 8, W - 16, H - 16);
  c2d.fillStyle = "#00E5FF";
  c2d.font = "bold 24px monospace";
  c2d.textAlign = "center";
  c2d.fillText("BUY-IN", W / 2, 56);
  c2d.fillText("CASH OUT", W / 2, 92);
  c2d.fillStyle = "#F0C060";
  c2d.font = "16px monospace";
  c2d.fillText("WALK UP TO BEGIN", W / 2, 146);
}

/** Roulette felt: green baize, gold trim, betting-grid motif on the +x half
 *  (the wheel occupies -x). Painted once — the LIVE board is the focused UI. */
function drawRouletteFelt(c2d: CanvasRenderingContext2D): void {
  const W = 512,
    H = 256;
  c2d.fillStyle = "#14532D";
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = "#1B6B3A";
  c2d.fillRect(8, 8, W - 16, H - 16);
  c2d.strokeStyle = "rgba(240, 224, 180, 0.8)";
  c2d.lineWidth = 3;
  // Grid motif: 12×3 cells on the right half + a zero wedge.
  const gx = 280,
    gy = 40,
    cw = 16,
    ch = 56;
  for (let col = 0; col <= 12; col++) {
    c2d.beginPath();
    c2d.moveTo(gx + col * cw, gy);
    c2d.lineTo(gx + col * cw, gy + 3 * ch);
    c2d.stroke();
  }
  for (let row = 0; row <= 3; row++) {
    c2d.beginPath();
    c2d.moveTo(gx, gy + row * ch);
    c2d.lineTo(gx + 12 * cw, gy + row * ch);
    c2d.stroke();
  }
  c2d.beginPath(); // zero wedge left of the grid
  c2d.moveTo(gx, gy);
  c2d.lineTo(gx - 28, gy + 1.5 * ch);
  c2d.lineTo(gx, gy + 3 * ch);
  c2d.closePath();
  c2d.stroke();
  // Outside-bet boxes under the grid.
  for (let b = 0; b < 6; b++) {
    c2d.strokeRect(gx + b * 32, gy + 3 * ch + 10, 32, 24);
  }
}

function buildCashierAtm({ m, flat, place }: BuildCtx) {
  // Plinth + kiosk body (station-steel family).
  place(
    new THREE.BoxGeometry(0.9, 0.12, 0.6),
    m(0x2a3444, 0.7, 0.35),
    0,
    0.06,
    0,
  );
  place(
    new THREE.BoxGeometry(0.8, 1.6, 0.5),
    m(0x1c262e, 0.6, 0.4),
    0,
    0.92,
    0,
  );
  // Screen (faces -z into the room at rot 0 — the device-front convention).
  const bezel = place(
    new THREE.BoxGeometry(0.66, 0.5, 0.07),
    m(0x0a0e1a, 0.5, 0.5),
    0,
    1.32,
    -0.24,
  );
  bezel.rotation.x = 0.24;
  const screenCv = document.createElement("canvas");
  screenCv.width = 256;
  screenCv.height = 192;
  drawCashierScreen(screenCv.getContext("2d")!);
  const screenTex = new THREE.CanvasTexture(screenCv);
  screenTex.minFilter = THREE.NearestFilter;
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.generateMipmaps = false;
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screen = place(
    new THREE.PlaneGeometry(0.58, 0.42),
    new THREE.MeshBasicMaterial({
      map: screenTex,
      transparent: true,
      opacity: 0,
    }),
    0,
    1.325,
    -0.285,
  );
  screen.rotation.x = 0.24;
  screen.rotation.y = Math.PI; // face -z
  // Keypad shelf + chip tray.
  const pad = place(
    new THREE.BoxGeometry(0.5, 0.26, 0.09),
    m(0x37474f, 0.55, 0.45),
    0,
    0.98,
    -0.27,
  );
  pad.rotation.x = -0.5;
  place(
    new THREE.BoxGeometry(0.5, 0.06, 0.18),
    m(0xd4a84b, 0.45, 0.5),
    0,
    0.7,
    -0.3,
  );
  // Side neon strips (casino magenta) + gold accent line.
  for (const sx of [-0.42, 0.42]) {
    place(
      new THREE.BoxGeometry(0.05, 1.5, 0.05),
      m(0xff2d95, 0.4, 0.2, 0xff2d95, 0.8),
      sx,
      0.95,
      -0.18,
    );
  }
  // Roof sign, double-faced.
  place(
    new THREE.BoxGeometry(0.92, 0.5, 0.12),
    m(0x0a0e1a, 0.55, 0.4),
    0,
    1.98,
    0,
  );
  const signCv = document.createElement("canvas");
  signCv.width = 256;
  signCv.height = 128;
  drawCashierSign(signCv.getContext("2d")!);
  const signTex = new THREE.CanvasTexture(signCv);
  signTex.minFilter = THREE.NearestFilter;
  signTex.magFilter = THREE.NearestFilter;
  signTex.generateMipmaps = false;
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = place(
    new THREE.PlaneGeometry(0.86, 0.44),
    new THREE.MeshBasicMaterial({
      map: signTex,
      transparent: true,
      opacity: 0,
    }),
    0,
    1.98,
    -0.07,
  );
  sign.rotation.y = Math.PI; // face -z
  // Status pip.
  place(new THREE.SphereGeometry(0.03, 8, 6), flat(0x00e676), 0.3, 0.72, -0.28);
}

function buildRouletteTable(ctx: BuildCtx) {
  const { m, place } = ctx;
  // Base: apron + legs (game-table family, darker casino wood).
  place(
    new THREE.BoxGeometry(1.86, 0.14, 0.86),
    m(0x4a2f1b, 0.55, 0.15),
    0,
    0.62,
    0,
  );
  (
    [
      [-0.85, -0.35],
      [-0.85, 0.35],
      [0.85, -0.35],
      [0.85, 0.35],
    ] as [number, number][]
  ).forEach(([lx, lz]) => {
    place(
      new THREE.BoxGeometry(0.12, 0.62, 0.12),
      m(0x3a2417, 0.55, 0.18),
      lx,
      0.31,
      lz,
    );
    place(
      new THREE.BoxGeometry(0.15, 0.04, 0.15),
      m(0x4a2f1b, 0.5, 0.2),
      lx,
      0.02,
      lz,
    );
  });
  // Top slab + padded rim.
  place(
    new THREE.BoxGeometry(1.96, 0.07, 0.96),
    m(0x4a2f1b, 0.5, 0.2),
    0,
    0.775,
    0,
  );
  for (const [w, d, lx, lz] of [
    [1.96, 0.08, 0, -0.44],
    [1.96, 0.08, 0, 0.44],
    [0.08, 0.96, -0.94, 0],
    [0.08, 0.96, 0.94, 0],
  ] as [number, number, number, number][]) {
    place(
      new THREE.BoxGeometry(w, 0.09, d),
      m(0x3a2417, 0.6, 0.1),
      lx,
      0.845,
      lz,
    );
  }
  // Felt (canvas) across the top.
  const feltCv = document.createElement("canvas");
  feltCv.width = 512;
  feltCv.height = 256;
  drawRouletteFelt(feltCv.getContext("2d")!);
  const feltTex = new THREE.CanvasTexture(feltCv);
  feltTex.minFilter = THREE.NearestFilter;
  feltTex.magFilter = THREE.NearestFilter;
  feltTex.generateMipmaps = false;
  feltTex.colorSpace = THREE.SRGBColorSpace;
  const feltGeo = new THREE.PlaneGeometry(1.84, 0.84);
  feltGeo.rotateX(-Math.PI / 2);
  place(
    feltGeo,
    new THREE.MeshBasicMaterial({
      map: feltTex,
      transparent: true,
      opacity: 0,
    }),
    0,
    0.812,
    0,
  );
  // Wheel at the -x end: bowl + pocket disc (canvas) + gold hub and rim.
  place(
    new THREE.CylinderGeometry(0.34, 0.36, 0.06, 28),
    m(0x2a1a10, 0.5, 0.3),
    -0.58,
    0.845,
    0,
  );
  const wheelCv = document.createElement("canvas");
  wheelCv.width = 256;
  wheelCv.height = 256;
  const wc = wheelCv.getContext("2d")!;
  const CX = 128,
    CY = 128;
  wc.fillStyle = "#2A1A10";
  wc.fillRect(0, 0, 256, 256);
  for (let i = 0; i < WHEEL_ORDER.length; i++) {
    const a0 = (i / WHEEL_ORDER.length) * Math.PI * 2;
    const a1 = ((i + 1) / WHEEL_ORDER.length) * Math.PI * 2;
    const col = pocketColor(WHEEL_ORDER[i]);
    wc.beginPath();
    wc.moveTo(CX, CY);
    wc.arc(CX, CY, 120, a0, a1);
    wc.closePath();
    wc.fillStyle =
      col === "green" ? "#1B6B3A" : col === "red" ? "#C43C3C" : "#23252E";
    wc.fill();
  }
  wc.beginPath();
  wc.arc(CX, CY, 52, 0, Math.PI * 2);
  wc.fillStyle = "#4A2F1B";
  wc.fill();
  wc.beginPath();
  wc.arc(CX, CY, 120, 0, Math.PI * 2);
  wc.lineWidth = 5;
  wc.strokeStyle = "#D4A84B";
  wc.stroke();
  const wheelTex = new THREE.CanvasTexture(wheelCv);
  wheelTex.minFilter = THREE.NearestFilter;
  wheelTex.magFilter = THREE.NearestFilter;
  wheelTex.generateMipmaps = false;
  wheelTex.colorSpace = THREE.SRGBColorSpace;
  const wheelGeo = new THREE.CircleGeometry(0.31, 48);
  wheelGeo.rotateX(-Math.PI / 2);
  place(
    wheelGeo,
    new THREE.MeshBasicMaterial({
      map: wheelTex,
      transparent: true,
      opacity: 0,
    }),
    -0.58,
    0.877,
    0,
  );
  const hub = place(
    new THREE.ConeGeometry(0.06, 0.09, 12),
    m(0xd4a84b, 0.4, 0.6),
    -0.58,
    0.92,
    0,
  );
  hub.rotation.y = 0.3;
  const rim = place(
    new THREE.TorusGeometry(0.335, 0.018, 8, 32),
    m(0xd4a84b, 0.45, 0.5),
    -0.58,
    0.877,
    0,
  );
  rim.rotation.x = Math.PI / 2;
  // Chip stacks near the +x end (deco).
  const chipColors = [0xc43c3c, 0x3e92b8, 0xf0c060];
  chipColors.forEach((col, i) => {
    place(
      new THREE.CylinderGeometry(0.045, 0.045, 0.06, 12),
      m(col, 0.5, 0.25),
      0.52 + (i % 2) * 0.12,
      0.845,
      -0.18 + i * 0.14,
    );
  });
}

// ── 🛏️ Bunk bed (owner request) — two stacked sleep berths ───────────────────
// Concept-art-faithful crew berth: light station-gray frame, gray-green
// mattress pads with orange + blue sleep-restraint straps (micro-gravity
// habit — pure décor down here), white pillows, a foot-end ladder up to the
// top bunk and safety rails along its open sides. Local frame (rot 0): the
// bed runs along X, HEAD end at +x, ladder/foot end at -x. Palette reuses the
// storage-trunk shell grays + the trunk-orange / sofa-blue accent pair.
// (BUNK_*_Y + the berth SeatTemplates live up with the other seat templates —
// FURNITURE_DEFS evaluates them at module load, so unlike this hoisted
// function declaration they must precede it.)
function buildBunkBed({ m, place }: BuildCtx) {
  const FRAME = 0xb8bec6; // light-gray shell (storage-trunk family)
  const FRAME_DK = 0x8a93a0; // darker gray hardware
  const PAD = 0x9aa48e; // gray-green mattress
  const PILLOW = 0xf5f2e8; // warm white
  const STRAP_O = 0xe8760a; // trunk orange
  const STRAP_B = 0x3870c8; // sofa-cushion blue
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);

  // Four corner posts + head-end panels
  for (const px of [-0.93, 0.93]) {
    for (const pz of [-0.42, 0.42]) {
      place(box(0.1, 2.05, 0.1), m(FRAME, 0.6, 0.35), px, 1.025, pz);
    }
  }
  for (const py of [0.42, 1.42]) {
    place(box(0.06, 0.42, 0.86), m(FRAME, 0.65, 0.3), 0.93, py, 0); // headboards
  }

  // Platforms + mattresses (tops at BUNK_BOTTOM_Y / BUNK_TOP_Y)
  for (const [slabY, padY] of [
    [0.14, 0.25],
    [1.14, 1.25],
  ] as [number, number][]) {
    place(box(1.94, 0.08, 0.92), m(FRAME_DK, 0.6, 0.35), 0, slabY, 0); // frame slab
    place(box(1.82, 0.14, 0.84), m(PAD, 0.85, 0.04), 0, padY, 0); // mattress
    place(box(0.36, 0.11, 0.58), m(PILLOW, 0.88, 0.02), 0.62, padY + 0.1, 0); // pillow
    // Blanket over the foot half with two restraint straps (reference art)
    place(box(1.1, 0.05, 0.86), m(0xb8bea8, 0.9, 0.02), -0.3, padY + 0.085, 0);
    place(box(0.09, 0.025, 0.87), m(STRAP_O, 0.7, 0.1), -0.62, padY + 0.115, 0);
    place(box(0.09, 0.025, 0.87), m(STRAP_B, 0.7, 0.1), -0.1, padY + 0.115, 0);
  }

  // Top-bunk safety rails along both long sides (head half stays open for entry)
  for (const rz of [-0.44, 0.44]) {
    place(box(1.0, 0.05, 0.05), m(FRAME_DK, 0.55, 0.4), 0.25, 1.58, rz);
    place(box(0.05, 0.22, 0.05), m(FRAME_DK, 0.55, 0.4), -0.2, 1.47, rz);
  }

  // Foot-end ladder: two stiles + rungs (clicking this end claims the TOP bunk)
  for (const lz of [-0.2, 0.2]) {
    place(box(0.05, 1.9, 0.05), m(FRAME, 0.6, 0.35), -0.97, 0.95, lz);
  }
  for (let ry = 0.3; ry <= 1.7; ry += 0.35) {
    place(box(0.04, 0.04, 0.44), m(FRAME_DK, 0.55, 0.4), -0.97, ry, 0);
  }

  // Berth number decal-plate on the head-end post face (art: 'CREW BERTH 04')
  place(box(0.015, 0.16, 0.3), m(0x2a3444, 0.6, 0.4), 0.965, 1.0, 0);
}

// ── 🧬 Clone vat (owner request) — the diegetic spawn point ──────────────────
// Concept-art-faithful cloning tank: gunmetal plinth + cap, a glass cylinder
// full of glowing green nutrient bath, orange feed pipes and a status plate.
// Local frame (rot 0): the DOOR faces +z. The spawn choreography (drain the
// liquid, then SPIN the front glass segment around the cylinder axis until it
// tucks behind the fixed back shell) is driven by a CloneVatHandle stowed in
// a base mesh's userData.cloneVat — World collects it and drives update(dt)
// every frame (trunk-lid idiom, never a detached rAF).
const VAT_GLASS_R = 0.4; // glass tube radius
const VAT_GLASS_H = 1.8; // glass tube height (y 0.30 → 2.10)
const VAT_DOOR_ARC = (Math.PI * 2) / 3; // 120° front door segment
const VAT_DOOR_OPEN = Math.PI * 0.72; // spun back behind the shell
const VAT_BEAT_TIME = 0.5; // full-tank hold before the drain starts
const VAT_DRAIN_TIME = 1.4;
const VAT_DOOR_TIME = 0.9;
const VAT_REFILL_TIME = 2.6;
const VAT_GREEN = 0x39ff6a;

/** One-shot status-plate decal (trunk stencil idiom, two-line variant). */
function makeVatPlateTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 64;
  const c2d = cv.getContext("2d")!;
  c2d.fillStyle = "#14181E";
  c2d.fillRect(0, 0, 128, 64);
  c2d.strokeStyle = "#3A424C";
  c2d.strokeRect(2.5, 2.5, 123, 59);
  c2d.fillStyle = "#E8ECF2";
  c2d.font = "bold 16px monospace";
  c2d.textAlign = "center";
  c2d.fillText("CLONE VAT", 64, 24);
  c2d.fillStyle = "#39FF6A";
  c2d.font = "bold 14px monospace";
  c2d.fillText("C-01", 64, 46);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function buildCloneVat(ctx: BuildCtx) {
  const { m, flat, place, attach, addLight } = ctx;
  const BODY = 0x2a3444; // gunmetal (wall-computer housing family)
  const TRIM = 0x3d4a5e; // bezel slate
  const PIPE_O = 0xe8760a; // trunk orange conduits
  const STEEL = 0x8a93a0;

  // ── Plinth + interior floor pad
  place(
    new THREE.CylinderGeometry(0.5, 0.52, 0.08, 20),
    m(TRIM, 0.6, 0.4),
    0,
    0.04,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.46, 0.48, 0.24, 20),
    m(BODY, 0.55, 0.45),
    0,
    0.2,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.38, 0.38, 0.03, 20),
    m(0x14181e, 0.9, 0.1),
    0,
    0.315,
    0,
  );
  // Drain grate + green-lit outflow at the door side (concept art's spout)
  place(
    new THREE.BoxGeometry(0.22, 0.07, 0.1),
    m(0x14181e, 0.8, 0.2),
    0,
    0.1,
    0.48,
  );
  place(new THREE.BoxGeometry(0.14, 0.02, 0.03), flat(VAT_GREEN), 0, 0.1, 0.53);

  // ── Cap + head-end greebles
  place(
    new THREE.CylinderGeometry(0.48, 0.46, 0.22, 20),
    m(BODY, 0.55, 0.45),
    0,
    2.21,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.14, 0.14, 0.34, 12),
    m(TRIM, 0.5, 0.5),
    0,
    2.49,
    0,
  );
  place(
    new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8),
    m(STEEL, 0.45, 0.6),
    0,
    2.72,
    0,
  );
  // Orange feed conduits arcing down the back
  for (const sx of [-1, 1]) {
    const pipe = place(
      new THREE.CylinderGeometry(0.035, 0.035, 1.9, 8),
      m(PIPE_O, 0.5, 0.4),
      sx * 0.3,
      1.2,
      -0.4,
    );
    pipe.rotation.x = 0.08;
    place(
      new THREE.CylinderGeometry(0.045, 0.045, 0.1, 8),
      m(STEEL, 0.45, 0.6),
      sx * 0.3,
      2.18,
      -0.42,
    );
  }
  // Status plate on the cap front (faces the door side)
  const plateMat = new THREE.MeshBasicMaterial({
    map: makeVatPlateTexture(),
    transparent: true,
    opacity: 0,
  });
  place(new THREE.PlaneGeometry(0.34, 0.17), plateMat, 0, 2.21, 0.475);
  // Green status pip strip on the plinth front
  place(
    new THREE.BoxGeometry(0.2, 0.035, 0.02),
    flat(VAT_GREEN),
    0,
    0.24,
    0.475,
  );

  // ── Glass: fixed back shell (240°) + spinning front door segment (120°).
  //    CylinderGeometry θ=0 sits on +z (vertex = (sinθ, y, cosθ)), so a door
  //    centred on the +z axis is thetaStart −60° for 120°.
  const glassMat = () => {
    const gm = m(0x9bd4e8, 0.05, 0.1);
    gm.side = THREE.DoubleSide;
    gm.userData.baseOpacity = 0.22; // translucent tube (morph fade contract)
    return gm;
  };
  place(
    new THREE.CylinderGeometry(
      VAT_GLASS_R,
      VAT_GLASS_R,
      VAT_GLASS_H,
      28,
      1,
      true,
      Math.PI / 3,
      (Math.PI * 4) / 3,
    ),
    glassMat(),
    0,
    0.3 + VAT_GLASS_H / 2,
    0,
  );
  const doorGroup = new THREE.Group();
  doorGroup.name = "cloneVatDoor";
  doorGroup.position.set(0, 0.3 + VAT_GLASS_H / 2, 0); // on the tube axis
  attach(doorGroup);
  const doorMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(
      VAT_GLASS_R + 0.012,
      VAT_GLASS_R + 0.012,
      VAT_GLASS_H,
      12,
      1,
      true,
      -VAT_DOOR_ARC / 2,
      VAT_DOOR_ARC,
    ),
    glassMat(),
  );
  doorGroup.add(doorMesh);
  // Thin steel edge rails on the door segment so the spin reads from afar
  for (const edge of [-VAT_DOOR_ARC / 2, VAT_DOOR_ARC / 2]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, VAT_GLASS_H, 0.03),
      m(STEEL, 0.5, 0.5),
    );
    rail.position.set(
      Math.sin(edge) * (VAT_GLASS_R + 0.02),
      0,
      Math.cos(edge) * (VAT_GLASS_R + 0.02),
    );
    doorGroup.add(rail);
  }

  // ── Nutrient bath: emissive green column, origin at its BOTTOM so scale.y
  //    is the fill level (drains downward like the art's outflow panels).
  const liquidGeo = new THREE.CylinderGeometry(
    0.355,
    0.355,
    VAT_GLASS_H - 0.1,
    24,
  );
  liquidGeo.translate(0, (VAT_GLASS_H - 0.1) / 2, 0);
  const liquidMat = flat(VAT_GREEN);
  liquidMat.userData.baseOpacity = 0.5;
  const liquid = place(liquidGeo, liquidMat, 0, 0.33, 0);
  // Inner glow core (brighter, thinner — reads as depth in the bath)
  const coreGeo = new THREE.CylinderGeometry(0.16, 0.16, VAT_GLASS_H - 0.3, 12);
  coreGeo.translate(0, (VAT_GLASS_H - 0.3) / 2, 0);
  const coreMat = flat(0x9fffb8);
  coreMat.userData.baseOpacity = 0.35;
  const core = place(coreGeo, coreMat, 0, 0.36, 0);
  // Bath glow light (dims as the tank drains — handle-owned post-morph)
  const bathLight = new THREE.PointLight(VAT_GREEN, 0, 4.5);
  addLight(bathLight, 0, 1.3, 0, 1.4);

  // ── Handle: BEAT → DRAIN → OPEN (onOpen) / CLOSE → REFILL state machine.
  type VatPhase =
    | "IDLE_FULL"
    | "BEAT"
    | "DRAIN"
    | "OPEN"
    | "IDLE_OPEN"
    | "CLOSE"
    | "REFILL";
  let phase: VatPhase = "IDLE_FULL";
  let t = 0;
  let level = 1; // liquid fill 0..1
  let doorAngle = 0; // 0 closed → VAT_DOOR_OPEN tucked behind
  let onOpenCb: (() => void) | null = null;
  const smooth = (v: number) => v * v * (3 - 2 * v);

  const applyPose = () => {
    const l = Math.max(0.0001, level); // scale 0 breaks matrix inversion
    liquid.scale.y = l;
    core.scale.y = l;
    liquid.visible = level > 0.005;
    core.visible = level > 0.005;
    doorGroup.rotation.y = doorAngle;
  };

  const handle: CloneVatHandle = {
    beginSpawnCycle(onOpen: () => void): void {
      phase = "BEAT";
      t = 0;
      level = 1;
      doorAngle = 0;
      onOpenCb = onOpen;
      applyPose();
    },
    closeAndRefill(): void {
      phase = "CLOSE";
      t = 0;
      onOpenCb = null; // a pending open is superseded — never fire it late
    },
    update(deltaTime: number): void {
      if (phase === "IDLE_FULL" || phase === "IDLE_OPEN") return;
      t += Math.max(0, deltaTime);
      switch (phase) {
        case "BEAT":
          if (t >= VAT_BEAT_TIME) {
            phase = "DRAIN";
            t = 0;
          }
          break;
        case "DRAIN":
          level = 1 - smooth(Math.min(1, t / VAT_DRAIN_TIME));
          if (t >= VAT_DRAIN_TIME) {
            level = 0;
            phase = "OPEN";
            t = 0;
          }
          break;
        case "OPEN":
          doorAngle = VAT_DOOR_OPEN * smooth(Math.min(1, t / VAT_DOOR_TIME));
          if (t >= VAT_DOOR_TIME) {
            doorAngle = VAT_DOOR_OPEN;
            phase = "IDLE_OPEN";
            if (onOpenCb) {
              const cb = onOpenCb;
              onOpenCb = null; // exactly once
              cb();
            }
          }
          break;
        case "CLOSE":
          doorAngle =
            VAT_DOOR_OPEN * (1 - smooth(Math.min(1, t / VAT_DOOR_TIME)));
          if (t >= VAT_DOOR_TIME) {
            doorAngle = 0;
            phase = "REFILL";
            t = 0;
          }
          break;
        case "REFILL":
          level = smooth(Math.min(1, t / VAT_REFILL_TIME));
          if (t >= VAT_REFILL_TIME) {
            level = 1;
            phase = "IDLE_FULL";
          }
          break;
      }
      // Bath glow follows the liquid (idle phases return early above, so the
      // morph fade-in owns the light until a spawn cycle actually runs).
      bathLight.intensity =
        ((bathLight.userData.targetIntensity as number) ?? 1.4) *
        (0.2 + 0.8 * level);
      applyPose();
    },
  };
  // Stow on a tiny carrier mesh inside the plinth — collected by World and
  // devMenu's registerSpawnedGroup exactly like userData.trunkLid.
  const carrier = place(
    new THREE.BoxGeometry(0.01, 0.01, 0.01),
    m(BODY, 0.5, 0.5),
    0,
    0.05,
    0,
  );
  carrier.userData.cloneVat = handle;
}

// ── Item list — today's EXACT lobby layout ────────────────────────────────────
// Obstacle-bearing items appear first, in the same order as the original
// hand-authored OBSTACLES list, so collision-resolution iteration order (and
// therefore sliding behaviour in multi-box corners) is unchanged.
export const FURNITURE: FurnitureItem[] = [
  // (The default fireplace/bookcase wall was retired — owner request: the
  //  north wall now carries the two paired doors and the glassy tile panel,
  //  and the hearth unit covered them. The kind stays spawnable from the DEV
  //  menu; world.updateNorthDoorForFireplace still gates north-wall doors if
  //  one is placed in front of them. main.ts purges the retired default id
  //  from already-seeded lobby docs on entry.)
  // 🕯️ Ceiling chandelier over the lounge — the lobby's practical light as a
  // placeable fixture (footprint null, hangs at the ceiling above the sofas).
  {
    id: "lobby-chandelier",
    kind: "chandelier",
    pos: { x: 0.0, z: 0.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "sofa-back",
    kind: "sofa-back",
    pos: { x: 0.0, z: -1.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "sofa-front",
    kind: "sofa-front",
    pos: { x: 0.0, z: 2.6 },
    rot: 0,
    movable: true,
  },
  {
    id: "armchair-left-0",
    kind: "armchair-left",
    pos: { x: -4.5, z: -0.75 },
    rot: 0,
    movable: true,
  },
  {
    id: "armchair-left-1",
    kind: "armchair-left",
    pos: { x: -4.5, z: 0.75 },
    rot: 0,
    movable: true,
  },
  {
    id: "armchair-left-2",
    kind: "armchair-left",
    pos: { x: -2.0, z: 5.15 },
    rot: 1,
    movable: true,
  },
  {
    id: "armchair-left-3",
    kind: "armchair-left",
    pos: { x: -0.7, z: 5.15 },
    rot: 1,
    movable: true,
  },
  {
    id: "armchair-right-0",
    kind: "armchair-right",
    pos: { x: 0.6, z: 5.15 },
    rot: 1,
    movable: true,
  },
  {
    id: "armchair-right-1",
    kind: "armchair-right",
    pos: { x: 4.5, z: -1.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "armchair-right-2",
    kind: "armchair-right",
    pos: { x: 4.5, z: 0.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "armchair-right-3",
    kind: "armchair-right",
    pos: { x: 4.5, z: 2.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "coffee-table-back",
    kind: "coffee-table-back",
    pos: { x: 0.0, z: -0.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "coffee-table-front",
    kind: "coffee-table-front",
    pos: { x: 0.0, z: 1.5 },
    rot: 0,
    movable: true,
  },
  // Bar obstacle covers the 1x2-tile stool strip (parity with original list).
  // movable:true completes the v0.32.11 "movable bar" migration — the
  // MOVABLE_KIND_OVERRIDE (furnitureDoc.ts) only reaches doc READS; edit
  // mode's raycast index consults THIS registry default (stools/bottles/
  // shelves ride along — they are sub-meshes of the one composite build).
  {
    id: "bar-corner",
    kind: "bar-corner",
    pos: { x: 5.24, z: 3.1 },
    rot: 0,
    movable: true,
    footprintOverride: { x0: 4.0, z0: 3.0, x1: 5.0, z1: 5.0 },
  },
  {
    id: "lamp-table-back-left",
    kind: "lamp-table",
    pos: { x: -1.6, z: -5.3 },
    rot: 0,
    movable: true,
  },
  {
    id: "lamp-table-back-right",
    kind: "lamp-table",
    pos: { x: 1.6, z: -5.3 },
    rot: 0,
    movable: true,
  },
  {
    id: "lamp-table-front-left",
    kind: "lamp-table",
    pos: { x: -5.05, z: 3.9 },
    rot: 0,
    movable: true,
  },
  // Original obstacle sits one tile south of the visual (documented mismatch).
  {
    id: "lamp-table-front-right",
    kind: "lamp-table",
    pos: { x: 4.5, z: 3.5 },
    rot: 0,
    movable: true,
    footprintOverride: { x0: 4.0, z0: 4.0, x1: 5.0, z1: 5.0 },
  },
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
  {
    id: "map-table",
    kind: "map-table",
    pos: { x: 0.0, z: -5.3 },
    rot: 0,
    movable: true,
  },
  // Decorative items — footprint null, never obstacles.
  {
    id: "rug-back",
    kind: "rug-back",
    pos: { x: 0.0, z: -2.0 },
    rot: 0,
    movable: true,
  },
  {
    id: "rug-front",
    kind: "rug-front",
    pos: { x: 0.0, z: 3.0 },
    rot: 0,
    movable: true,
  },
  {
    id: "cherry-tree-front-left",
    kind: "cherry-tree",
    pos: { x: -5.0, z: 4.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "cherry-tree-mid-left",
    kind: "cherry-tree",
    pos: { x: -5.2, z: 0.9 },
    rot: 0,
    movable: true,
  }, // moved — bar occupies right-front corner
  {
    id: "cherry-tree-back-left",
    kind: "cherry-tree",
    pos: { x: -5.3, z: -5.3 },
    rot: 0,
    movable: true,
  },
  {
    id: "cherry-tree-back-right",
    kind: "cherry-tree",
    pos: { x: 4.9, z: -5.0 },
    rot: 0,
    movable: true,
  },
  {
    id: "blossom-pot-back-left",
    kind: "blossom-pot",
    pos: { x: -1.15, z: -5.35 },
    rot: 0,
    movable: true,
  },
  {
    id: "blossom-pot-back-right",
    kind: "blossom-pot",
    pos: { x: 1.15, z: -5.35 },
    rot: 0,
    movable: true,
  },
  {
    id: "blossom-pot-front-left",
    kind: "blossom-pot",
    pos: { x: -3.8, z: 3.2 },
    rot: 0,
    movable: true,
  },
  {
    id: "blossom-pot-front-right",
    kind: "blossom-pot",
    pos: { x: 3.8, z: 3.2 },
    rot: 0,
    movable: true,
  },
  // Wall computer on the south interior wall, east of the south door (#33 M1).
  // rot 2 flips the +z-facing screen to face -z into the room. x=1.8 clears
  // the door frame (posts end at |x|=1.0, click box at |x|≤1.0) and the
  // keypad (at x=-1.1 after the door group's rotY=π flip); z=5.97 is the
  // bar back-panel flush-mount plane. Footprint null ⇒ never an obstacle.
  {
    id: "wall-computer",
    kind: "wall-computer",
    pos: { x: 1.8, z: 5.97 },
    rot: 2,
    movable: false,
  },
  // Storage trunk on the fireplace wall's west flank (TR2 of #35). The plan's
  // berth-corner suggestion (-2.5, -5.0) overlaps the fireplace obstacle
  // (z[-6,-5]) — verified against itemAabb — so the trunk sits one tile south
  // at (-2.5, -4.5): AABB x[-3,-2] z[-5,-4] touches the hearth at z=-5 without
  // overlap, clear of the back-left lamp table (x[-5,-4] z[-5,-4]) and the
  // back coffee table (x[-1,1] z[-4,-3]). rot 0 = latch face toward +z (into
  // the room); front point (-2.5, -3.5) is a walkable aisle cell.
  {
    id: "storage-trunk",
    kind: "storage-trunk",
    pos: { x: -4.0, z: 5.5 },
    rot: 0,
    movable: true,
  },
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
  {
    id: "game-table",
    kind: "game-table",
    pos: { x: -4.0, z: 5.5 },
    rot: 0,
    movable: true,
  },
  // 🛏️ Bunk bed in the NE nook: rot 1 AABB x[3,4] z[-5,-3] fills the
  // DEAD-END pocket documented on the map-table entry above (east corridor
  // x[3,4] z[-5,-3] — never a route) FLUSH on three sides: map-table x[1,3]
  // z[-5,-3] to the west, fireplace z[-6,-5] to the north, lamp-table-back-
  // right x[4,5] z[-5,-4] + armchair-right-0 x[4,5] z[-4,-3] to the east —
  // zero residual gaps, so the wedge-trap rule is satisfied by construction.
  // The only open face (south, z=-3) is the ladder/foot end after rot 1
  // (local -x → world +z), fronting the open z∈(-3,-2) artery: the derived
  // berth front lands at (3.5, -2.5). Parity: rot 1 ⇒ extentX=d=1 odd → x at
  // n+0.5 (3.5 ✓), extentZ=w=2 even → z integer (-4 ✓). Head against the
  // fireplace wall, exactly like the concept art's wall-tucked crew berth.
  {
    id: "bunk-bed",
    kind: "bunk-bed",
    pos: { x: 4.9, z: -2.9 },
    rot: 1,
    movable: true,
  },
  // 🧬 Clone vat in the NW pocket: AABB x[-4,-3] z[-5,-4] fills the 1×1
  // dead-end between the back-left lamp table (x[-5,-4] z[-5,-4]) and the
  // storage trunk (x[-3,-2] z[-5,-4]), flush against the fireplace line
  // (z=-5) — zero residual gaps, same wedge-trap-safe-by-construction
  // reasoning as the bunk bed's nook. rot 0 ⇒ the glass door faces +z into
  // the open x[-4,-3] z[-4,-3] cell; the spawn walk-out exits to (-3.5,-3.5).
  // Parity: w=1/d=1 both odd → centre at n+0.5 on both axes ✓.
  {
    id: "clone-vat",
    kind: "clone-vat",
    pos: { x: -4.7, z: -4.9 },
    rot: 0,
    movable: true,
  },
];

/**
 * Module-load snapshot of the hand-authored footprintOverrides above, keyed
 * by item id with the default pose they belong to. FurnitureRecords cannot
 * carry overrides, so a doc round-trip (cross-room travel: reconcile removes
 * then re-adds default items) would silently swap an authored obstacle for
 * the kind's derived footprint — clients' walkable grids would then differ
 * by visit history. reconcileFurniture consults this table to restore the
 * authored box whenever an item sits at its exact default pose. Captured
 * here, before anything mutates FURNITURE.
 */
export const DEFAULT_FOOTPRINT_OVERRIDES: Record<
  string,
  { box: Box; x: number; z: number; rot: Rot }
> = {};
for (const item of FURNITURE) {
  if (item.footprintOverride) {
    DEFAULT_FOOTPRINT_OVERRIDES[item.id] = {
      box: { ...item.footprintOverride },
      x: item.pos.x,
      z: item.pos.z,
      rot: item.rot,
    };
  }
}
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
if (import.meta.env.DEV) assertPlacementClear("storage-trunk");
if (import.meta.env.DEV) assertPlacementClear("map-table");
if (import.meta.env.DEV) assertPlacementClear("game-table");
if (import.meta.env.DEV) assertPlacementClear("bunk-bed");
if (import.meta.env.DEV) assertPlacementClear("clone-vat");

// ── Derivation helpers ────────────────────────────────────────────────────────

/** Rotate a local XZ offset by quarter-turns CCW about +y (exact — no FP
 *  drift). Exported for the clone-vat spawn choreography (world.ts derives
 *  the walk-out exit point from the vat item's rot). */
export function rotXZ(
  x: number,
  z: number,
  rot: Rot,
): { x: number; z: number } {
  switch (rot) {
    case 0:
      return { x, z };
    case 1:
      return { x: z, z: -x };
    case 2:
      return { x: -x, z: -z };
    case 3:
      return { x: -z, z: x };
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
    x0: pos.x - hw,
    z0: pos.z - hd,
    x1: pos.x + hw,
    z1: pos.z + hd,
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

// 🛰️ The exterior wall-mounting machinery (WALL_LINE, snapExteriorPos,
// validateExteriorPlacement, door lanes, stacking) moved to hull.ts — the
// one authority for hull space shared with doors and vestibule chains.

// ── 🏝️ Outdoor Casino Pool Room ───────────────────────────────────────────────
// A separate room connected to the lobby's south door. Identified by a
// deterministic room ID; the seed is a raw base64 bootstrap JSON written by
// main.ts at runtime (incorporates the current node's WT URL + cert hash so
// it's always routable). Furniture is seeded on first visit from OUTDOOR_FURNITURE.

/** Stable room ID for the outdoor pool-casino room. */
export const OUTDOOR_CASINO_ROOM_ID = "ssf-outdoor-casino-pool-v1";

/**
 * Default furniture layout for the outdoor pool-casino room.
 *
 * Positions are chosen to avoid the wedge-trap rule (every sub-1.5 m gap
 * between items or items-and-wall is a dead-end nook, never a through-route).
 * Obstacle AABBs at rot 0 (extents: x±w/2, z±d/2):
 *   lazy-pool  (0, 1.5) 4×3 → x[-2, 2] z[0, 3]
 *   hot-tub    (-3,-2)  2×2 → x[-4,-2] z[-3,-1]
 *   cashier    (3.5,-0.5) 1×1 → x[3, 4] z[-1, 0]
 *   roulette   (3,-3.5) 2×1 → x[2, 4] z[-4,-3]
 * Cherry trees and blossom pots have null footprints — never obstacles.
 */
export const OUTDOOR_FURNITURE: FurnitureItem[] = [
  // 🪟 Glass-ceiling skylights over the deck — real structural windows looking
  // up at the orbiting ocean-planet + stars (the outdoor-deck theme un-hides
  // the space backdrop). Footprint null; they hang overhead and never block a
  // walk route. Movable, so the owner can rearrange the ceiling.
  { id: "pool-skylight-n", kind: "skylight", pos: { x: 0, z: -2.8 }, rot: 0, movable: true },
  { id: "pool-skylight-s", kind: "skylight", pos: { x: 0, z: 2.8 }, rot: 0, movable: true },
  // Large lazy pool — the water spans the room's WEST HALF up to the west
  // infinity edge (no west corridor), so the obstacle override covers
  // x[-5.4,3.5] instead of the symmetric 7×6 footprint. Walk routes go
  // north/east/south; the west door drops arrivals straight into the water
  // (auto-swim catches them).
  // NOTE: these two stay movable: false in the island layout even though the
  // kinds are movable elsewhere (main's movable-pool pass): the hot tub sits
  // ON the lazy river's island, and the footbridge visuals + scripted seat
  // path + bridgeDeckY all anchor to its default pose — carrying either item
  // away would strand the bridge over open water.
  {
    id: "pool-main",
    kind: "lazy-pool",
    pos: { x: 0, z: 0 },
    rot: 0,
    movable: false,
    footprintOverride: { x0: -5.4, z0: -3, x1: 3.5, z1: 3 },
  },
  // Hot tub sits on the central island, surrounded by the lazy river.
  {
    id: "pool-hot-tub",
    kind: "hot-tub",
    pos: { x: 0, z: 0 },
    rot: 0,
    movable: false,
  },
  // (Casino fixtures moved back to the lobby — the pool room is pure leisure.
  //  main.ts deletes the old pool-cashier / pool-roulette doc entries on entry.)
  // Cherry trees at south corners (null footprint — walkable edge décor)
  {
    id: "otree-sw",
    kind: "cherry-tree",
    pos: { x: -4.5, z: 4.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "otree-se",
    kind: "cherry-tree",
    pos: { x: 4.5, z: 4.5 },
    rot: 0,
    movable: true,
  },
  // Blossom pots — kept clear of the hot tub corner (nothing pink near the spa)
  {
    id: "opot-1",
    kind: "blossom-pot",
    pos: { x: 2.55, z: 4.75 },
    rot: 0,
    movable: true,
  },
  // (moved off the south deck — the lounger row lives there now)
  {
    id: "opot-2",
    kind: "blossom-pot",
    pos: { x: 4.6, z: 2.6 },
    rot: 0,
    movable: true,
  },
];

// The pool's hand-authored asymmetric obstacle (its water reaches the west
// room edge) lives in OUTDOOR_FURNITURE, which the DEFAULT_FOOTPRINT_OVERRIDES
// capture loop above never iterated — so the override was silently dropped on
// every doc round-trip (the walkable grid used the symmetric derived 7×6).
// Register outdoor overrides too, so the authored obstacle applies at the
// default pose and is restored after a move-back / cross-room round-trip
// (same restore-at-default contract the bar relies on). Placed AFTER
// OUTDOOR_FURNITURE's declaration — a TDZ const, can't be read in the loop above.
for (const item of OUTDOOR_FURNITURE) {
  if (item.footprintOverride) {
    DEFAULT_FOOTPRINT_OVERRIDES[item.id] = {
      box: { ...item.footprintOverride },
      x: item.pos.x,
      z: item.pos.z,
      rot: item.rot,
    };
  }
}

// ── Casino Room ─────────────────────────────────────────────────────────────

/** Stable room ID for the casino connected to the lobby's east door. */
export const CASINO_ROOM_ID = "ssf-casino-v1";

// ── 🌌 Room visual theme ─────────────────────────────────────────────────────
/**
 * A room's VISUAL biome — what backdrop + lighting scheme applyRoomVisuals
 * paints. Independent of the room's furniture/mechanics: any module can be an
 * 'outdoor-deck' (real space seen through a glass ceiling + warm bright light),
 * not just the authored pool. Stored per-room in roomInfo['theme']; absent ⇒
 * fall back to the room's identity via legacyThemeFromRoomId.
 */
export type RoomTheme = "interior" | "casino" | "outdoor-deck";

/**
 * Theme for a room that hasn't stamped an explicit roomInfo['theme'] — derived
 * from the authored room-id constants so the flagship rooms paint correctly at
 * the synchronous first frame (no dependency on the roomInfo sync race).
 */
export function legacyThemeFromRoomId(roomId: string): RoomTheme {
  if (roomId === OUTDOOR_CASINO_ROOM_ID) return "outdoor-deck";
  if (roomId === CASINO_ROOM_ID) return "casino";
  return "interior";
}

/**
 * Default casino floor. The four door approach lanes stay open, and every
 * device front lands in a clear aisle so cashier and table focus navigation
 * remain reachable from any entrance.
 */
export const CASINO_FURNITURE: FurnitureItem[] = [
  // 🔌 Robot charging dock in a back corner — the waiter returns here to
  // recharge when the floor is quiet (#77). Footprint null; the bot stands on it.
  {
    id: "casino-charging-dock",
    kind: "charging-dock",
    pos: { x: 4.5, z: 4.5 },
    rot: 0,
    movable: true,
  },
  // 🎰 Neon halo over the gaming floor — the casino's light as a placeable
  // fixture (footprint null, hangs at the ceiling above the tables).
  {
    id: "casino-neon-ring",
    kind: "neon-ring",
    pos: { x: 0.0, z: 0.0 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-cashier",
    kind: "cashier-atm",
    pos: { x: -4.5, z: -4.5 },
    rot: 3,
    movable: true,
  },
  {
    id: "casino-cashier-south",
    kind: "cashier-atm",
    pos: { x: -4.5, z: 3.5 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-roulette-a",
    kind: "roulette-table",
    pos: { x: -1.5, z: -3 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-roulette-b",
    kind: "roulette-table",
    pos: { x: -1.5, z: -1 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-roulette-c",
    kind: "roulette-table",
    pos: { x: -1.5, z: 1 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-roulette-d",
    kind: "roulette-table",
    pos: { x: -1.5, z: 3 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-game-a",
    kind: "game-table",
    pos: { x: 1.5, z: -3 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-game-b",
    kind: "game-table",
    pos: { x: 1.5, z: -1 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-game-c",
    kind: "game-table",
    pos: { x: 1.5, z: 1 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-game-d",
    kind: "game-table",
    pos: { x: 1.5, z: 3 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-booth-w",
    kind: "casino-booth",
    pos: { x: -4.5, z: 0 },
    rot: 1,
    movable: true,
  },
  {
    id: "casino-booth-e0",
    kind: "casino-booth",
    pos: { x: 4.5, z: -0.5 },
    rot: 3,
    movable: true,
  },
  {
    id: "casino-booth-e1",
    kind: "casino-booth",
    pos: { x: 4.5, z: 2 },
    rot: 3,
    movable: true,
  },
  {
    id: "casino-booth-s0",
    kind: "casino-booth",
    pos: { x: -3, z: 5 },
    rot: 2,
    movable: true,
  },
  {
    id: "casino-booth-s1",
    kind: "casino-booth",
    pos: { x: 0, z: 5 },
    rot: 2,
    movable: true,
  },
  {
    id: "casino-wall-n0",
    kind: "casino-gold-wall",
    pos: { x: -4.8, z: -5.78 },
    rot: 0,
    movable: false,
  },
  {
    id: "casino-wall-n1",
    kind: "casino-gold-wall",
    pos: { x: 0, z: -5.78 },
    rot: 0,
    movable: false,
  },
  {
    id: "casino-wall-n2",
    kind: "casino-gold-wall",
    pos: { x: 4.8, z: -5.78 },
    rot: 0,
    movable: false,
  },
  {
    id: "casino-wall-w0",
    kind: "casino-gold-wall",
    pos: { x: -5.78, z: -4.8 },
    rot: 1,
    movable: false,
  },
  {
    id: "casino-wall-w1",
    kind: "casino-gold-wall",
    pos: { x: -5.78, z: 0 },
    rot: 1,
    movable: false,
  },
  {
    id: "casino-wall-w2",
    kind: "casino-gold-wall",
    pos: { x: -5.78, z: 4.8 },
    rot: 1,
    movable: false,
  },
  {
    id: "casino-orb-0",
    kind: "casino-orb-lamp",
    pos: { x: -2.2, z: -2.2 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-orb-1",
    kind: "casino-orb-lamp",
    pos: { x: 2.2, z: -2.2 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-orb-2",
    kind: "casino-orb-lamp",
    pos: { x: -2.2, z: 2.6 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-orb-3",
    kind: "casino-orb-lamp",
    pos: { x: 2.2, z: 2.6 },
    rot: 0,
    movable: true,
  },
  {
    id: "casino-terminal",
    kind: "wall-computer",
    pos: { x: 1.8, z: 5.97 },
    rot: 2,
    movable: false,
  },
];

export const CASINO_RETIRED_FURNITURE_IDS = [
  "casino-booth-n",
  "casino-rug",
  "casino-pot-nw",
  "casino-pot-se",
] as const;

/**
 * 🏊 World-space swim rects of the first lazy-pool item, or null when the
 * room has none. `basin` = the water the avatar may swim in (inset from the
 * tiled edge walls — see buildLazyPool HX/HZ); `exit` = the walkable corridor
 * line just OUTSIDE the 7×6 footprint, where a climb-out lands.
 */
// ═══════════════════════════════════════════════════════════════════════════
// 🏊 CLASSIC POOL — faithful replica of PR #70's original Habbo-Lido pool,
// rebuilt on the current furniture code (reuses makePoolTileTex / poolTileMat /
// gradientMat / radialWaterMat). Same water basin as the live pool, but the
// dive tower stands on the EAST rim, a second small tower sits at the far
// edge, and the hot tub is a standalone spa in the NW corner (no centre
// island / bridge). Registered as the "classic-pool" / "classic-hot-tub"
// kinds; the pool-2 room template places them.
// ═══════════════════════════════════════════════════════════════════════════
function buildClassicPool({ m, flat, place, addLight }: BuildCtx) {
  const TILE = 0xf3f9fb; // white pool tile (plain faces)
  const WATER_MID = 0x46aebd; // submerged basin walls (visible through water)
  const CHROME = 0xd8e2e8; // ladder metal
  const SEAT_RED = 0xd8342e; // red terrace bench rows
  const CHAIR_Y = 0xf2c010; // yellow café chairs / parasol

  const HX = 3.4,
    HZ = 2.9;
  const WATER_Y = -0.35; // keep == POOL_WATER_Y
  const EDGE_BOT = -0.95; // tiled deck-edge wall reaches below the water
  const WX = POOL_WATER_WEST; // west waterline (near the room bound)

  // ── Deck slabs: north + south full width, east only (no west deck).
  place(new THREE.BoxGeometry(10.4, 0.12, 5.2 - HZ), poolTileMat(10.4, 5.2 - HZ), 0, 0.06, -(HZ + (5.2 - HZ) / 2));
  place(new THREE.BoxGeometry(10.4, 0.12, 5.2 - HZ), poolTileMat(10.4, 5.2 - HZ), 0, 0.06, HZ + (5.2 - HZ) / 2);
  place(new THREE.BoxGeometry(5.2 - HX, 0.12, HZ * 2), poolTileMat(5.2 - HX, HZ * 2), HX + (5.2 - HX) / 2, 0.06, 0);

  // ── Deck-edge walls: tiled north/east; gradient infinity faces south + west.
  const edgeH = 0.12 - EDGE_BOT;
  const edgeY = (0.12 + EDGE_BOT) / 2;
  const spanW = WX + HX;
  const spanC = (HX - WX) / 2;
  place(new THREE.BoxGeometry(spanW, edgeH, 0.12), poolTileMat(spanW, edgeH), spanC, edgeY, -(HZ - 0.06));
  place(new THREE.BoxGeometry(spanW, edgeH, 0.12), gradientMat(["#2A6E86", "#153B54", "#060E1C"]), spanC, edgeY, HZ - 0.06);
  place(new THREE.BoxGeometry(0.12, edgeH, HZ * 2), gradientMat(["#2A6E86", "#153B54", "#060E1C"]), -(WX - 0.06), edgeY, 0);
  place(new THREE.BoxGeometry(0.12, edgeH, HZ * 2), poolTileMat(HZ * 2, edgeH), HX - 0.06, edgeY, 0);
  place(new THREE.BoxGeometry(spanW + 0.3, 0.07, 0.4), m(0xfafdfe, 0.8, 0.03), spanC, 0.155, -HZ);
  place(new THREE.BoxGeometry(0.4, 0.07, HZ * 2), m(0xfafdfe, 0.8, 0.03), HX, 0.155, 0);

  // ── Stepped deck peninsula cutting into the basin (Habbo pool outline).
  const mkCut = (x0: number, z0: number, x1: number, z1: number) => {
    const w = x1 - x0,
      d = z1 - z0;
    place(new THREE.BoxGeometry(w, 0.12 - EDGE_BOT, d), poolTileMat(Math.max(w, d), 1.1), (x0 + x1) / 2, (0.12 + EDGE_BOT) / 2, (z0 + z1) / 2);
    place(new THREE.BoxGeometry(w + 0.16, 0.07, d + 0.16), m(0xfafdfe, 0.8, 0.03), (x0 + x1) / 2, 0.155, (z0 + z1) / 2);
  };
  mkCut(2.55, -2.9, 3.4, -2.05); // NE corner peninsula

  // ── Submerged basin lining (teal read through the water). North + east only.
  place(new THREE.BoxGeometry(WX + HX - 0.2, 0.65, 0.06), flat(WATER_MID), (HX - WX) / 2, -0.625, -(HZ - 0.15));
  place(new THREE.BoxGeometry(0.06, 0.65, HZ * 2 - 0.1), flat(WATER_MID), HX - 0.15, -0.625, 0);

  // Horizon tree line (stops short of the NW corner where the hot tub lives).
  for (const x of [-1.4, 0.0, 1.4, 2.7, 4.0]) {
    const treeA = place(new THREE.SphereGeometry(0.66, 10, 8), m(0x2c6a3a, 0.92, 0.02), x, 0.34, -3.98);
    treeA.scale.set(1.0, 0.7, 0.55);
    const treeB = place(new THREE.SphereGeometry(0.46, 8, 6), m(0x3f8a4a, 0.9, 0.02), x + 0.17, 0.46, -3.9);
    treeB.scale.set(1.0, 0.68, 0.48);
  }

  // ── Basin floor + depth-graded water.
  const tintGeo = new THREE.PlaneGeometry(WX + HX, HZ * 2);
  tintGeo.rotateX(-Math.PI / 2);
  const tint = place(tintGeo, flat(0x1c5a74), (HX - WX) / 2, EDGE_BOT + 0.01, 0);
  (tint.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.95;
  const waterGeo = new THREE.PlaneGeometry(WX + HX + 0.02, HZ * 2 + 0.1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = place(waterGeo, gradientMat(["#7CD8DF", "#3FA9BC", "#1F6E88"]), (HX - WX) / 2 - 0.02, WATER_Y, 0.05);
  (water.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.85;

  // Sparkle flecks.
  const sparkles: Array<[number, number]> = [
    [-2.6, -1.9], [-1.3, -2.3], [0.4, -1.6], [1.9, -2.1], [2.8, -0.9],
    [-2.9, 0.4], [-1.6, 1.2], [-0.2, 0.6], [1.1, 1.7], [2.4, 0.9],
    [-2.1, 2.2], [-0.8, -0.6], [0.9, -0.2], [2.0, 2.3],
    [-4.5, -1.8], [-4.1, 0.6], [-4.7, 1.9], [-3.8, -0.4],
  ];
  for (const [sx, sz] of sparkles) {
    const fleckGeo = new THREE.PlaneGeometry(0.09, 0.09);
    fleckGeo.rotateX(-Math.PI / 2);
    const fleck = place(fleckGeo, flat(0xffffff), sx, WATER_Y + 0.01, sz);
    (fleck.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.8;
  }

  // Buoy lines with red flags.
  for (const z of [-0.95, 1.05]) {
    const rope = place(new THREE.BoxGeometry(WX + HX - 0.4, 0.03, 0.03), flat(0xf4fbff), (HX - WX) / 2, WATER_Y + 0.02, z);
    (rope.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.9;
    let idx = 0;
    for (let x = -4.8; x <= 3.0; x += 0.6) {
      const cc = idx % 2 === 0 ? 0xe04040 : 0xf6fafc;
      const buoy = place(new THREE.SphereGeometry(0.06, 8, 6), m(cc, 0.56, 0.04), x, WATER_Y + 0.03, z);
      buoy.scale.y = 0.6;
      if (idx % 5 === 0) {
        place(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 4), m(0xb9c4cc, 0.6, 0.2), x, WATER_Y + 0.12, z);
        place(new THREE.BoxGeometry(0.1, 0.06, 0.012), m(0xe03030, 0.8, 0.02), x + 0.06, WATER_Y + 0.17, z);
      }
      idx++;
    }
  }

  // ── Chrome ladder (east rim).
  const chrome = () => m(CHROME, 0.35, 0.65);
  const mkLadder = (side: 1 | -1, lz: number) => {
    for (const dz of [-0.18, 0.18]) {
      place(new THREE.CylinderGeometry(0.032, 0.032, 1.0, 8), chrome(), side * (HX - 0.14), -0.28, lz + dz);
      const hook = place(new THREE.CylinderGeometry(0.03, 0.03, 0.36, 8), chrome(), side * (HX + 0.02), 0.24, lz + dz);
      hook.rotation.z = Math.PI / 2;
      place(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 8), chrome(), side * (HX + 0.18), 0.14, lz + dz);
    }
    for (const ry of [0.0, -0.3, -0.6]) {
      const rung = place(new THREE.CylinderGeometry(0.022, 0.022, 0.4, 8), chrome(), side * (HX - 0.14), ry, lz);
      rung.rotation.x = Math.PI / 2;
    }
  };
  mkLadder(1, -1.6);

  // ── Tiled steps (SE corner + NORTH edge toward the hot tub).
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), 2.5, 0.0, 2.62);
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), 2.5, -0.2, 2.3);
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), 2.5, -0.4, 1.98);
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), -3.7, 0.0, -2.62);
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), -3.7, -0.2, -2.3);
  place(new THREE.BoxGeometry(1.1, 0.16, 0.36), m(TILE, 0.8, 0.03), -3.7, -0.4, -1.98);

  // ── Red terrace bench (north deck).
  const mkRedBenchX = (bx: number, bz: number) => {
    place(new THREE.BoxGeometry(1.5, 0.26, 0.42), m(SEAT_RED, 0.8, 0.03), bx, 0.25, bz);
    place(new THREE.BoxGeometry(1.5, 0.5, 0.1), m(0xa82420, 0.8, 0.03), bx, 0.5, bz - 0.24);
  };
  mkRedBenchX(-0.5, -4.8);

  // ── ⛱️ Green sun loungers flanking the south door.
  const mkLounger = (bx: number, bz: number) => {
    const GRN = 0x6fc72e,
      GRN_D = 0x53a81e,
      F = 0xb9cad6;
    place(new THREE.BoxGeometry(0.64, 0.18, 0.12), m(F, 0.7, 0.1), bx, 0.09, bz - 0.78);
    place(new THREE.BoxGeometry(0.64, 0.18, 0.12), m(F, 0.7, 0.1), bx, 0.09, bz + 0.72);
    place(new THREE.BoxGeometry(0.72, 0.11, 1.7), m(GRN, 0.75, 0.04), bx, 0.24, bz);
    for (let i = 1; i < 5; i++) {
      place(new THREE.BoxGeometry(0.73, 0.02, 0.04), m(GRN_D, 0.8, 0.03), bx, 0.3, bz - 0.85 + i * 0.34);
    }
    const back = place(new THREE.BoxGeometry(0.72, 0.08, 0.8), m(GRN, 0.75, 0.04), bx, 0.46, bz + 0.62);
    back.rotation.x = -0.55;
  };
  mkLounger(-3.8, 4.6);
  mkLounger(-2.1, 4.6);
  mkLounger(1.7, 4.6);
  mkLounger(3.4, 4.6);

  // ── Parasol café sets.
  const mkParasolSet = (px: number, pz: number, canopy: number) => {
    place(new THREE.CylinderGeometry(0.045, 0.045, 1.9, 8), m(0xe8edf0, 0.6, 0.2), px, 0.95, pz);
    place(new THREE.ConeGeometry(0.85, 0.5, 8), m(canopy, 0.8, 0.02), px, 2.1, pz);
    place(new THREE.SphereGeometry(0.06, 8, 6), m(0xf6fafc, 0.7, 0.1), px, 2.4, pz);
    place(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12), m(0xf6fafc, 0.8, 0.04), px, 0.5, pz);
    place(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), m(0xb9c4cc, 0.6, 0.2), px, 0.25, pz);
    place(new THREE.BoxGeometry(0.34, 0.3, 0.34), m(CHAIR_Y, 0.75, 0.04), px - 0.55, 0.15, pz + 0.2);
    place(new THREE.BoxGeometry(0.34, 0.3, 0.34), m(CHAIR_Y, 0.75, 0.04), px + 0.55, 0.15, pz - 0.2);
  };
  mkParasolSet(4.45, -3.6, 0xf2c010);
  mkParasolSet(4.45, 1.3, 0xe04a3f);
  mkParasolSet(4.45, 3.9, 0xe04a3f);

  // ── Pale-blue tile inlay (NW deck wet-path motif).
  for (const [ix, iz] of [[-3.2, -3.6], [-2.7, -3.35], [-2.2, -3.6], [-1.7, -3.85], [-1.2, -3.6], [-0.7, -3.35]] as Array<[number, number]>) {
    const patch = place(new THREE.BoxGeometry(0.5, 0.015, 0.5), flat(0xbfe4f0), ix, 0.127, iz);
    (patch.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.9;
  }

  // ── High dive tower (EAST rim) + board + secondary small tower.
  const towerX = 4.05;
  const towerZ = -1.75;
  const SPIRE = 0x7a4a26;
  const shaft = place(new THREE.BoxGeometry(1.0, 5.2, 1.0), poolTileMat(1, 5.2, true), towerX, 2.6, towerZ);
  shaft.userData.isDiveTower = true;
  const cabin = place(new THREE.BoxGeometry(1.2, 0.76, 1.06), poolTileMat(1.2, 0.76, true), towerX, 4.62, towerZ);
  cabin.userData.isDiveTower = true;
  const spire = place(new THREE.ConeGeometry(0.85, 0.95, 4), m(SPIRE, 0.7, 0.06), towerX, 5.5, towerZ);
  spire.rotation.y = Math.PI / 4;
  const board = place(new THREE.BoxGeometry(2.9, 0.08, 0.6), m(0xf6fafc, 0.7, 0.04), towerX - 1.45, 4.55, towerZ);
  board.userData.isDiveTower = true;
  const boardUnder = place(new THREE.BoxGeometry(2.9, 0.03, 0.6), m(0xc9d6dd, 0.76, 0.04), towerX - 1.45, 4.49, towerZ);
  boardUnder.userData.isDiveTower = true;
  place(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6), m(0x6d8998, 0.56, 0.24), 2.45, 3.95, towerZ);
  place(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6), m(0x6d8998, 0.56, 0.24), 1.75, 3.95, towerZ);
  place(new THREE.BoxGeometry(0.82, 2.9, 0.82), poolTileMat(0.82, 2.9, true), 4.8, 1.45, -1.18);
  const spire2 = place(new THREE.ConeGeometry(0.62, 0.7, 4), m(SPIRE, 0.7, 0.06), 4.8, 3.25, -1.18);
  spire2.rotation.y = Math.PI / 4;

  addLight(new THREE.PointLight(0x56ceff, 0, 11.0), 0.0, -0.85, 0, 13.0);
  addLight(new THREE.PointLight(0x2ba8e2, 0, 6.5), -2.6, -0.85, 0.2, 6.4);
  addLight(new THREE.PointLight(0x2ba8e2, 0, 6.5), 2.6, -0.85, 0.2, 6.4);
  addLight(new THREE.PointLight(0xb7e7ff, 0, 7.2), 0.0, 1.55, -3.98, 4.8);
  addLight(new THREE.PointLight(0xa8e5ff, 0, 4.2), towerX, 3.2, towerZ, 3.8);
}

function buildClassicHotTub({ m, flat, place, addLight }: BuildCtx) {
  const TRIM = 0xfafdfe,
    GLOW = 0x69ceff;
  place(new THREE.CylinderGeometry(1.7, 1.7, 0.14, 36), poolTileMat(10.7, 0.3, true), 0, 0.07, 0);
  place(new THREE.CylinderGeometry(1.55, 1.55, 0.46, 36), poolTileMat(9.7, 0.46, true), 0, 0.35, 0);
  const capRing = place(new THREE.TorusGeometry(1.36, 0.1, 8, 36), m(TRIM, 0.7, 0.08), 0, 0.62, 0);
  capRing.rotation.x = Math.PI / 2;
  const shadow = place(new THREE.CylinderGeometry(1.3, 1.3, 0.012, 36), flat(0x0f4a60), 0, 0.552, 0);
  (shadow.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.92;
  const water = place(new THREE.CylinderGeometry(1.28, 1.28, 0.014, 36), radialWaterMat(["#1F6E88", "#3FA9BC", "#7CD8DF"]), 0, 0.565, 0);
  (water.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.94;
  const boil = place(new THREE.SphereGeometry(0.22, 12, 8), m(0xf2fbfd, 0.9, 0.0), 0, 0.585, 0);
  boil.scale.y = 0.32;
  (boil.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.85;
  const bubbles: Array<[number, number, number]> = [
    [0.44, 0.13, 0.055], [-0.38, 0.31, 0.045], [0.19, -0.5, 0.055], [-0.56, -0.25, 0.045],
    [0.69, -0.19, 0.04], [-0.19, 0.63, 0.05], [0.5, 0.5, 0.04], [-0.69, 0.44, 0.045],
    [0.1, 0.28, 0.035], [-0.31, -0.65, 0.04], [0.85, 0.25, 0.04], [-0.8, -0.5, 0.035],
  ];
  for (const [bx, bz, br] of bubbles) {
    const bub = place(new THREE.SphereGeometry(br, 8, 6), m(0xf6fdff, 0.85, 0.0), bx, 0.59, bz);
    bub.scale.y = 0.4;
    (bub.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.8;
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const swirl = place(new THREE.SphereGeometry(0.12, 8, 6), m(0xeffcff, 0.85, 0.0), Math.cos(a) * 1.02, 0.585, Math.sin(a) * 1.02);
    swirl.scale.set(1.2, 0.28, 0.6);
    swirl.rotation.y = -a;
    (swirl.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.75;
  }
  const foam = place(new THREE.TorusGeometry(1.16, 0.04, 6, 36), flat(0xeffcff), 0, 0.575, 0);
  foam.rotation.x = Math.PI / 2;
  (foam.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.85;
  const rim = place(new THREE.TorusGeometry(1.46, 0.04, 6, 36), flat(GLOW), 0, 0.5, 0);
  rim.rotation.x = Math.PI / 2;
  (rim.material as THREE.MeshBasicMaterial).userData.baseOpacity = 0.92;
  for (const [sx, sy, sz, sc] of [[-0.22, 0.87, -0.1, 0.11], [0.18, 0.93, 0.15, 0.1], [0.06, 0.83, -0.22, 0.09]] as [number, number, number, number][]) {
    const puff = place(new THREE.SphereGeometry(sc, 10, 8), m(0xeaf5fb, 0.9, 0.0), sx, sy, sz);
    (puff.material as THREE.MeshStandardMaterial).userData.baseOpacity = 0.32;
  }
  addLight(new THREE.PointLight(0x69ceff, 0, 3.6), 0, 0.5, 0, 3.2);
  addLight(new THREE.PointLight(0xcfe8f4, 0, 1.8), 1.1, 0.65, -0.55, 0.7);
}

export function getPoolBasin(items: FurnitureItem[]): {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  exit: { x0: number; z0: number; x1: number; z1: number };
} | null {
  for (const item of items) {
    if (item.kind !== "lazy-pool" && item.kind !== "classic-pool") continue;
    // ASYMMETRIC water: local -x reaches the west infinity edge (the west
    // deck IS water — see buildLazyPool WX). Corners rotate with the item.
    // Margin keeps the avatar's bulk off walls/edges; a "west" climb-out
    // lands back inside the basin and the auto-swim converts it — by design
    // (there is no deck out there, only horizon).
    const a = rotXZ(-4.8, -2.55, item.rot); // west/deep corner (WX - margin)
    const b = rotXZ(3.05, 2.55, item.rot); // east corner (HX - margin)
    const e1 = rotXZ(-4.6, -3.25, item.rot); // exits: corridor cell centres
    const e2 = rotXZ(3.75, 3.25, item.rot);
    return {
      x0: item.pos.x + Math.min(a.x, b.x),
      z0: item.pos.z + Math.min(a.z, b.z),
      x1: item.pos.x + Math.max(a.x, b.x),
      z1: item.pos.z + Math.max(a.z, b.z),
      exit: {
        x0: item.pos.x + Math.min(e1.x, e2.x),
        z0: item.pos.z + Math.min(e1.z, e2.z),
        x1: item.pos.x + Math.max(e1.x, e2.x),
        z1: item.pos.z + Math.max(e1.z, e2.z),
      },
    };
  }
  return null;
}

/** 🌊 The lazy-river water outline (irregular bank + central island hole) in
 *  the pool item's LOCAL frame. Shared by buildLazyPool (the water mesh) and
 *  poolHoleCells (the floor hole), so the hole always matches the water. */
function lazyRiverShape(): THREE.Shape {
  const river = new THREE.Shape();
  river.moveTo(-4.85, -1.35);
  river.bezierCurveTo(-5.15, -2.35, -3.7, -2.9, -2.45, -2.58);
  river.bezierCurveTo(-1.25, -2.28, -0.45, -2.88, 0.82, -2.62);
  river.bezierCurveTo(2.15, -2.35, 3.4, -1.95, 3.2, -0.92);
  river.bezierCurveTo(3.02, -0.05, 2.65, 0.48, 3.18, 1.18);
  river.bezierCurveTo(3.62, 2.0, 2.05, 2.82, 0.72, 2.5);
  river.bezierCurveTo(-0.48, 2.22, -1.2, 2.82, -2.52, 2.55);
  river.bezierCurveTo(-3.82, 2.28, -5.0, 1.55, -4.68, 0.52);
  river.bezierCurveTo(-4.42, -0.25, -5.08, -0.62, -4.85, -1.35);
  river.closePath();
  const island = new THREE.Path();
  island.absellipse(0, 0, 1.55, 1.28, 0, Math.PI * 2, true);
  river.holes.push(island);
  return river;
}

/** Even-odd point-in-polygon (ray cast). `poly` is a closed ring of {x,y}. */
function pointInPoly(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/**
 * 🕳️ #80: the set of 1 m FLOOR CELLS (`"i,j"`, cell = world [i,i+1]×[j,j+1])
 * the pool water actually covers — sampled against the lazy-river outline so
 * the floor is punched to the water's TRUE shape (deck cells keep their floor),
 * not a bounding box. The water Shape's y maps to local −z (the mesh is
 * rotateX(−π/2)), so we test (localX, −localZ). Empty when there's no pool.
 */
export function poolHoleCells(items: FurnitureItem[]): Set<string> {
  const cells = new Set<string>();
  const pool = items.find((i) => i.kind === "lazy-pool" || i.kind === "classic-pool");
  if (!pool) return cells;
  const shape = lazyRiverShape();
  const outer = shape.getPoints(64).map((p) => ({ x: p.x, y: p.y }));
  const island = (shape.holes[0]?.getPoints(48) ?? []).map((p) => ({ x: p.x, y: p.y }));
  const rect = poolHoleRect(items)!; // world bbox of the water footprint
  const inv = ((4 - pool.rot) % 4) as Rot;
  for (let i = Math.floor(rect.x0); i < Math.ceil(rect.x1); i++) {
    for (let j = Math.floor(rect.z0); j < Math.ceil(rect.z1); j++) {
      // cell CENTRE in world → pool LOCAL (inverse pose) → water shape coords
      const l = rotXZ(i + 0.5 - pool.pos.x, j + 0.5 - pool.pos.z, inv);
      if (pointInPoly(l.x, -l.z, outer) && !pointInPoly(l.x, -l.z, island)) {
        cells.add(`${i},${j}`);
      }
    }
  }
  return cells;
}

/**
 * 🕳️ #80: the world XZ rectangle bounding a pool's water footprint (west
 * waterline → east tile wall × ±halfZ). Used for the water-cell scan bounds and
 * the rect basin bottom. Rotates/offsets with the item (cardinal rots only,
 * like getPoolBasin). Null when there's no pool.
 */
export function poolHoleRect(
  items: FurnitureItem[],
): { x0: number; z0: number; x1: number; z1: number } | null {
  for (const item of items) {
    if (item.kind !== "lazy-pool" && item.kind !== "classic-pool") continue;
    const a = rotXZ(-POOL_WATER_WEST, -POOL_WATER_HALFZ, item.rot);
    const b = rotXZ(POOL_WATER_EAST, POOL_WATER_HALFZ, item.rot);
    return {
      x0: item.pos.x + Math.min(a.x, b.x),
      z0: item.pos.z + Math.min(a.z, b.z),
      x1: item.pos.x + Math.max(a.x, b.x),
      z1: item.pos.z + Math.max(a.z, b.z),
    };
  }
  return null;
}

/** Central hot-tub island excluded from the lazy-river swim channel. */
export function getPoolIsland(items: FurnitureItem[]): {
  x: number;
  z: number;
  rx: number;
  rz: number;
} | null {
  const hotTub = items.find((item) => item.id === "pool-hot-tub");
  if (!hotTub) return null;
  return { x: hotTub.pos.x, z: hotTub.pos.z, rx: 1.72, rz: 1.48 };
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
      const fr = rotXZ(t.front.x, t.front.z, item.rot);
      const c0 = rotXZ(t.clickBox.x0, t.clickBox.z0, item.rot);
      const c1 = rotXZ(t.clickBox.x1, t.clickBox.z1, item.rot);
      // The central hot tub is reachable only over its south footbridge. All
      // four seats share the same dry-land approach; the scripted `path` then
      // WALKS the arched bridge (shore → crest, y following the deck) and the
      // SIT_DOWN hop covers the last stretch over the rim (player.ts).
      const preferred =
        item.id === "pool-hot-tub"
          ? { x: item.pos.x + BRIDGE_X, z: item.pos.z + 3.75 }
          : { x: item.pos.x + fr.x, z: item.pos.z + fr.z };
      const path =
        item.id === "pool-hot-tub"
          ? [3.26, 2.96, 2.66, 2.42, 2.22, 2.05].map((lz) => ({
              x: item.pos.x + BRIDGE_X,
              y: bridgeTopAt(lz),
              z: item.pos.z + lz,
            }))
          : undefined;
      seats.push({
        id: `${item.id}:${n}`,
        clickBox: {
          x0: item.pos.x + Math.min(c0.x, c1.x),
          z0: item.pos.z + Math.min(c0.z, c1.z),
          x1: item.pos.x + Math.max(c0.x, c1.x),
          z1: item.pos.z + Math.max(c0.z, c1.z),
        },
        front: computeFront(preferred, itemAabb(item), isWalkable),
        path,
        sit: { x: item.pos.x + sit.x, z: item.pos.z + sit.z },
        faceAngle: t.faceAngle + item.rot * (Math.PI / 2),
        sitY: t.sitY ?? 0,
        lie: t.lie ?? false,
        swim: t.swim ?? false,
        dive: t.dive ?? false,
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
      anchor: new THREE.Vector3(
        item.pos.x + anchor.x,
        t.anchor.y,
        item.pos.z + anchor.z,
      ),
    });
  }
  return devices;
}

/**
 * 🎰 Derive world-space standing positions from the furniture registry — one
 * StandSlot per StandTemplate on each item's def, rotated + translated into the
 * room like buildDeviceList. `front` is computeFront-snapped so it's walkable
 * and A*-reachable; faceAngle points toward the table. id `${item.id}:s${n}`.
 */
export function buildStandList(
  items: FurnitureItem[],
  isWalkable: (x: number, z: number) => boolean,
): StandSlot[] {
  const stands: StandSlot[] = [];
  for (const item of items) {
    const tmpls = FURNITURE_DEFS[item.kind].stands;
    if (!tmpls) continue;
    tmpls.forEach((t, n) => {
      const s = rotXZ(t.stand.x, t.stand.z, item.rot);
      const preferred = { x: item.pos.x + s.x, z: item.pos.z + s.z };
      stands.push({
        id: `${item.id}:s${n}`,
        front: computeFront(preferred, itemAabb(item), isWalkable),
        faceAngle: normalizeAngle(t.faceAngle + item.rot * (Math.PI / 2)),
        ...(t.role ? { role: t.role } : {}),
      });
    });
  }
  return stands;
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
    for (
      let wz = cellCentre(aabb.z0 - 1.25);
      wz <= aabb.z1 + 1.25;
      wz += CELL
    ) {
      // Skip cells whose centre is inside the footprint itself.
      if (wx > aabb.x0 && wx < aabb.x1 && wz > aabb.z0 && wz < aabb.z1)
        continue;
      if (!isWalkable(wx, wz)) continue;
      const d = (wx - preferred.x) ** 2 + (wz - preferred.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: wx, z: wz };
      }
    }
  }
  return best ?? preferred;
}

// ── Visual construction ───────────────────────────────────────────────────────

export function furnitureVisualYaw(item: FurnitureItem): number {
  const casinoCashierOffset = item.id.startsWith("casino-cashier")
    ? -Math.PI / 4
    : 0;
  return item.rot * (Math.PI / 2) + casinoCashierOffset;
}

/**
 * Build one furniture item as a THREE.Group positioned/rotated per the item.
 * Meshes start fully transparent (opacity 0) for the morph fade-in; point
 * lights carry their fade target in userData.targetIntensity.
 */
export function buildItemGroup(item: FurnitureItem): THREE.Group {
  const group = new THREE.Group();
  const ctx: BuildCtx = {
    m: (color, rough = 0.72, metal = 0.06, em = 0x000000, emI = 0) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: rough,
        metalness: metal,
        emissive: em,
        emissiveIntensity: emI,
        transparent: true,
        opacity: 0,
      }),
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
  if (item.id.startsWith("casino-game-")) {
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!(obj.material instanceof THREE.MeshStandardMaterial)) return;
      const color = obj.material.color.getHex();
      if (color !== WOOD && color !== DKWOOD && color !== 0xa06a32) return;
      obj.material.color.setHex(color === DKWOOD ? 0x5e1025 : 0x180c12);
      obj.material.metalness = 0.32;
      obj.material.roughness = 0.2;
    });
    const top = group.getObjectByName("gameTableTop");
    if (top) {
      const trim = new THREE.MeshStandardMaterial({
        color: 0xf0bd52,
        emissive: 0x6f3406,
        emissiveIntensity: 0.16,
        metalness: 0.82,
        roughness: 0.18,
        transparent: true,
        opacity: 0,
      });
      for (const [w, d, x, z] of [
        [1.84, 0.035, 0, -0.44],
        [1.84, 0.035, 0, 0.44],
        [0.035, 0.88, -0.9, 0],
        [0.035, 0.88, 0.9, 0],
      ] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, d), trim);
        rail.position.set(x, 0.055, z);
        top.add(rail);
      }
    }
  }
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
  group.rotation.y = furnitureVisualYaw(item);
  return group;
}
