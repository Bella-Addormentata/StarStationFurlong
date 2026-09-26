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
  SlotMachineVisualHandle,
  PropAnimHandle,
} from "./devices";
// 🎰 #69: the in-world roulette wheel disc is painted with the REAL pocket
// order/colors from the pure engine — one source of truth with the focused UI.
import { WHEEL_ORDER, pocketColor } from "./games/roulette";
import { DEFAULT_PAYTABLE, SLOT_SYMBOLS, computeRTP } from "./games/slots";
import type { SlotFailure, SlotPayEntry, SlotSymbol } from "./games/slots";
import { readSlotMachineState, readSlotOddsConfig, subscribeCasinoKey } from "./casinoDoc";
// 🎉 Party props read their own per-instance state (candles, lids, the music)
// straight from the room doc, the same way the slot machine reads the casino
// map — the doc is the phase, a local click is never the phase.
import {
  readCake, readGift, readSpeaker, subscribePartyKey, partyDocEpoch,
  cakeKey, giftKey, speakerKey,
} from "./partyDoc";
// 🖥️ Interior wall mounts need the live room size to find the wall planes.
// (floorPlanDoc imports neither this module nor anything that leads back to
// it, and DoorWall is type-only — no cycle either way.)
import { roomHalfExtents, roomWalkBounds } from "./floorPlanDoc";
import { isLocalPlayerInRoom, localPlayerXZ } from "./localPresence";
import { createSpeakerVoice } from "./partyAudio";
// 🌊 The beach sea keeps a dry lane in front of every REAL door. Acyclic:
// doorLayoutDoc → doors → doorLayout → floorPlanDoc, none of which import
// this module.
import { readAllDoorLayout, defaultDoorLayoutRecords, doorSetIsMarkedEmpty } from "./doorLayoutDoc";
import { poseFromWall } from "./doorLayout";
import type { DoorWall } from "./doorLayoutDoc";

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
  | "smiley-bouquet"
  | "rose-bouquet"
  | "purple-bouquet"
  | "lavender-bouquet"
  | "birthday-balloons"
  | "birthday-balloons-wall"
  | "wall-computer"
  | "map-table"
  | "storage-trunk"
  | "game-table"
  | "fuel-tank"
  | "engine-block"
  | "helm-console"
  | "cashier-atm"
  | "roulette-table"
  | "craps-table"
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
  | "clone-vat"
  | "slot-machine"
  // 🎉 Party fixtures — the cake is the anchor, the rest cluster around it.
  | "cake-table"
  | "gift-box"
  | "birthday-banner"
  | "party-speaker"
  | "dance-floor"
  | "party-standing-table"
  // 🏝️ Beach fixtures — the party skill's set, ported to voxel.
  | "palm-tree"
  | "parasol"
  | "sun-lounger"
  | "surfboard"
  | "beach-towel"
  | "beach-ball"
  | "beach-crate"
  | "cooler"
  | "tiki-torch"
  | "tiki-bar-counter"
  | "tiki-back-bar"
  | "tiki-bar-stool"
  | "pergola-post"
  | "pergola-roof"
  | "beach-river"
  | "plank-bridge"
  // 🏖️ The Habbo beach: a flat sea in the front corner, thatched parasols, a raft.
  | "beach-sea"
  // 🏊 The reference's terraced water as a pool on the front edge (not a swim kind).
  | "infinity-pool"
  | "tiki-parasol"
  | "beach-raft"
  | "jungle-plant"
  // 🌹 Tall yellow climbing rose on a trellis — hangs on an interior wall.
  | "climbing-rose";

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
  /** Enter regular first-person once the sit-down slide completes. */
  firstPerson?: boolean;
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
  /** 🎰 The reserved OPERATOR position, held for the room owner or the owner's
   *  robot (see #76 / #77): 'wheelHead' spins the roulette wheel, 'stickman'
   *  throws the craps dice. Regular stands are open to anyone; any operator role
   *  is auto-skipped by the walk-up picker and is where the robot croupier posts. */
  role?: "wheelHead" | "stickman";
}

/** A StandTemplate derived into world space (see buildStandList). */
export interface StandSlot {
  id: string;
  front: { x: number; z: number };
  faceAngle: number;
  role?: "wheelHead" | "stickman";
}

/** Build-time helpers bound to the item's group (all coordinates local). */
export interface BuildCtx {
  itemId: string;
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
  /**
   * 🖥️ INTERIOR wall mount (the room terminal). The mirror image of `mount:
   * 'exterior-wall'`: the item hangs on the INSIDE face of a wall instead of
   * standing on the floor, so a carry snaps it to the nearest wall's mount
   * plane and takes its rotation from that wall (screen always faces into the
   * room) rather than honouring R — see snapInteriorWall.
   *
   * `halfW` is the panel's half-width along the wall. It is only used for the
   * clearance checks (doorways, windows, other furniture): a wall-mounted kind
   * keeps `footprint: null` and never becomes an obstacle.
   *
   * NOT because it is out of reach vertically — the terminal's housing spans
   * y 1.25–1.95 (WC_Y 1.6 ± WC_H/2), squarely at head height, and deliberately
   * at its own device eye level (y 1.45): it is a screen you stand and look at.
   * What keeps it clear is plan-view geometry. It flush-mounts WALL_MOUNT_INSET
   * (0.03 m) inside the wall plane and reaches only ~0.1 m into the room, while
   * WALL_CLEARANCE (0.5 m) holds every walker's centre off that plane — so
   * there is ~0.4 m of air in front of the panel and nothing can path or clamp
   * into it. Shrinking WALL_CLEARANCE, or adding a wall kind that protrudes
   * further, is what would break this; mounting height has nothing to do with it.
   */
  wallMount?: { halfW: number };
  /**
   * 🌊 Obstacle override for kinds whose blocked area is NOT one rectangle.
   * A winding river is the case that forced it: a single AABB around the band
   * would also block the dry sand at every bend AND the far bank, and a bridge
   * could never be walkable because its cells would sit inside the same box.
   * Returning per-column strips (minus anything that bridges the water) keeps
   * the banks walkable and the crossing real. Takes the whole layout because
   * what cuts a hole in the river is another ITEM.
   */
  obstacleBoxes?: (item: FurnitureItem, all: FurnitureItem[]) => Box[];
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

// 📸 Photo décor (owner request 2026-07-22): a real photo as furniture — the
// owner's JPEG on crossed planes (the Minecraft-flower idiom) or a single
// wall-hung plane. A voxel remodel of the first one read as ugly; the photo
// IS the wanted look. Product photos ship on a white studio backdrop, so each
// is keyed at load: a flood fill FROM THE BORDERS marks the background-
// connected near-white pixels transparent (interior whites — white daisies,
// glass highlights, foil balloons — are unreachable from the border and
// survive), then the canvas becomes the texture, smooth-filtered so fine
// print stays legible (see the filter note at the texture).

/** One photo-décor piece — consumed by buildPhotoStandee. */
interface PhotoDecorSpec {
  url: string;
  /** Plane width in metres (height = width × aspect). */
  width: number;
  /** Photo height / width. */
  aspect: number;
  /** >1 lifts the photo's RGB at key time (clamped at 255). */
  brightness?: number;
  /** Bottom edge's height above the floor — wall/hanging décor. */
  lift?: number;
  /** false ⇒ a SINGLE plane (flat wall décor); default: crossed pair. */
  crossed?: boolean;
  /**
   * Local +z reach of the plane from the item origin. Wall décor needs it:
   * decorative placement clamps the ORIGIN to ≥1 m inside the walls
   * (validatePlacement's halfX-1 bounds), so a 0.95 reach parks the plane
   * on the wall face when the item sits on the closest lattice line and is
   * R-rotated to face it (5 cm proud — no z-fighting with the wall).
   */
  zOff?: number;
}

/** 📸 Processed cutout textures keyed by `url|brightness`. The flood-fill key
 *  + brightness pass is hundreds of thousands of pixel ops per image, and the
 *  two balloon kinds share one photo — instances must reuse ONE CanvasTexture.
 *  Caching the PROMISE also dedupes in-flight loads; a failed load evicts so a
 *  later spawn can retry. */
const keyedPhotoTexCache = new Map<string, Promise<THREE.CanvasTexture>>();

const loadKeyedPhotoTexture = (
  url: string,
  brightness: number,
): Promise<THREE.CanvasTexture> => {
  const key = `${url}|${brightness}`;
  const hit = keyedPhotoTexCache.get(key);
  if (hit) return hit;
  const p = new Promise<THREE.CanvasTexture>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d');
      if (!g) {
        reject(new Error('no 2D context')); // the white standee stays
        return;
      }
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, canvas.width, canvas.height);
      const d = px.data;
      const wpx = canvas.width;
      const hpx = canvas.height;
      // Backdrop test: bright and unsaturated (white wall + the soft grey
      // product shadow both pass; yellows/greens never do).
      const isBackdrop = (i: number): boolean => {
        const r = d[i * 4];
        const gr = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        return (
          Math.min(r, gr, b) > 190 &&
          Math.max(r, gr, b) - Math.min(r, gr, b) < 26
        );
      };
      // Border flood fill (4-neighbour): only background-CONNECTED pixels key.
      const visited = new Uint8Array(wpx * hpx);
      const stack: number[] = [];
      for (let x = 0; x < wpx; x++) stack.push(x, (hpx - 1) * wpx + x);
      for (let y = 0; y < hpx; y++) stack.push(y * wpx, y * wpx + wpx - 1);
      while (stack.length > 0) {
        const p2 = stack.pop()!;
        if (visited[p2] || !isBackdrop(p2)) continue;
        visited[p2] = 1;
        d[p2 * 4 + 3] = 0;
        const x = p2 % wpx;
        if (x > 0) stack.push(p2 - 1);
        if (x < wpx - 1) stack.push(p2 + 1);
        if (p2 >= wpx) stack.push(p2 - wpx);
        if (p2 < wpx * (hpx - 1)) stack.push(p2 + wpx);
      }
      // Brightness lift (after the key, surviving pixels only).
      if (brightness !== 1) {
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          d[i] = Math.min(255, d[i] * brightness);
          d[i + 1] = Math.min(255, d[i + 1] * brightness);
          d[i + 2] = Math.min(255, d[i + 2] * brightness);
        }
      }
      g.putImageData(px, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      // Smooth filtering, NOT mars.png's NearestFilter: photos carry fine
      // detail (balloon lettering) that nearest-neighbour shreds into noise —
      // owner feedback "not clear". Mipmaps + max anisotropy keep the print
      // legible at the isometric viewing angle and distance.
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy =
        window.gameRenderer?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
      tex.colorSpace = THREE.SRGBColorSpace;
      // Instances SHARE this texture — flag it so removeFurnitureVisuals'
      // per-item cleanup skips disposing it out from under the survivors.
      tex.userData.sharedCache = true;
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
  p.catch(() => keyedPhotoTexCache.delete(key));
  keyedPhotoTexCache.set(key, p);
  return p;
};

const buildPhotoStandee = (ctx: BuildCtx, spec: PhotoDecorSpec) => {
  const { m, place } = ctx;
  const {
    url,
    width: W,
    aspect,
    brightness = 1,
    lift = 0,
    crossed = true,
    zOff = 0,
  } = spec;
  const H = W * aspect;
  const cy = lift + H / 2; // plane centre height

  // Crossed planes read from every isometric angle (floor standees); flat
  // wall décor uses a single plane the player turns against a wall with R.
  // One shared material: unmapped (white) until the async key finishes, then
  // the CanvasTexture lands via needsUpdate — the mars.png loading pattern.
  // alphaTest hard-clips the keyed edge so the planes never alpha-sort
  // against each other. The map doubles as a soft emissiveMap so the photo
  // stays vivid under dim room light (owner request: brighter).
  // transparent stays true only for the morph fade-in (ctx.m contract) —
  // world.ts flips alphaTest>0 materials opaque at reveal/morph-complete, so
  // the cutout never lingers in the depth-sorted transparent pass.
  const mat = m(0xffffff, 0.85, 0.0, 0xffffff, 0.32);
  mat.transparent = true;
  mat.alphaTest = 0.4;
  mat.side = THREE.DoubleSide;
  // One geometry for both crossed meshes — place() only sets mesh-level
  // transform, and removeFurnitureVisuals dedupes disposal, so sharing is safe.
  const plane = new THREE.PlaneGeometry(W, H);
  place(plane, mat, 0, cy, zOff);
  if (crossed) place(plane, mat, 0, cy, zOff, Math.PI / 2);

  loadKeyedPhotoTexture(url, brightness)
    .then((tex) => {
      mat.map = tex;
      mat.emissiveMap = tex; // self-lit photo — vivid even in a dim room
      mat.needsUpdate = true;
    })
    .catch(() =>
      console.warn(
        `📸 photo décor: could not load ${url} — white placeholder stays`,
      ),
    );
};

// The photo-décor set — the owner's 590×689 product photos, statement-sized
// and brightness-lifted (owner requests: bigger than life, brighter colours).
// Four bouquets, a floor balloon bunch, and a wall-hung balloon variant.
const PHOTO_DECOR = { aspect: 689 / 590, brightness: 1.15 } as const;

const buildSmileyBouquet = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, { ...PHOTO_DECOR, url: '/assets/smiley-bouquet.jpg', width: 1.45 });
const buildRoseBouquet = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, { ...PHOTO_DECOR, url: '/assets/rose-bouquet.jpg', width: 1.45 });
const buildPurpleBouquet = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, { ...PHOTO_DECOR, url: '/assets/purple-bouquet.jpg', width: 1.35 });
const buildLavenderBouquet = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, { ...PHOTO_DECOR, url: '/assets/lavender-bouquet.jpg', width: 1.45 });
// 🎈 Balloons float, so the bunch gets the tallest cut.
const buildBirthdayBalloons = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, { ...PHOTO_DECOR, url: '/assets/birthday-balloons.jpg', width: 1.5 });
// 🎈 Wall-hung variant: a single flat plane at wall height, reaching 0.95 m
// out of the origin — MOVE it to the lattice line nearest a wall and R-rotate
// until the picture lands ON the wall face (see PhotoDecorSpec.zOff).
const buildBirthdayBalloonsWall = (ctx: BuildCtx) =>
  buildPhotoStandee(ctx, {
    ...PHOTO_DECOR,
    url: '/assets/birthday-balloons.jpg',
    width: 1.2,
    lift: 0.9,
    crossed: false,
    zOff: 0.95,
  });

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
  screen.userData.wallScreen = handle; // collected by registerFurnitureHandles (furnitureHandles.ts)
};

// ── Map table / holograph table (M4 of #33) ──────────────────────────────────
// Sturdy dark 2×2 table (4 chunky legs + top) with a holographic disc floating
// above it: emissive cyan plane + a slow-spinning broken emissive ring (the
// gap is what makes the spin readable). flat() = MeshBasicMaterial, the same
// unlit-reads-as-emissive idiom as the fireplace fire layers and wall strips.
// The ring mesh carries userData.holoSpin (rad/s); registerFurnitureHandles
// (furnitureHandles.ts) collects it on every registration path and
// World.update() drives the rotation — same collect-and-drive seam as the
// wall computer's userData.wallScreen handle.
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
  ring.userData.holoSpin = 0.6; // rad/s — collected by registerFurnitureHandles (furnitureHandles.ts)

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
  lidSlab.userData.trunkLid = handle; // collected by registerFurnitureHandles (furnitureHandles.ts)
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
  slab.userData.gameTableTop = handle; // collected by registerFurnitureHandles (furnitureHandles.ts)
};

// ── Definitions ───────────────────────────────────────────────────────────────
/**
 * 🪑 Seat-height helper: the sitY that puts an occupant's BACKSIDE on a seat
 * surface `topY` metres above the floor.
 *
 * sitY is the avatar's MESH-ROOT height, not its contact height, and in the
 * `sit_chair` pose the two differ by a fixed 0.125 m. The chain, all in
 * voxelCharacter.ts: torso.y = rootY − 0.15, so sit_chair (rootY 0.5) puts the
 * torso at root + 0.35; the leg groups hang at torso − 0.30, i.e. the hip
 * pivots sit at root + 0.05; and legRotX = −π/2 swings each leg to horizontal,
 * which maps the leg's LOCAL Z extent to vertical — so the thigh cylinder's
 * hip-end radius (0.175) becomes the drop from pivot to thigh underside.
 *   0.05 − 0.175 = −0.125.
 * Measured on the running rig to confirm: hip pivots at world y 0.050 with a
 * mesh y of 0, exactly as above.
 *
 * The pose is authored as a FLOOR sit (contact 0.125 m BELOW the mesh root),
 * which is why every chair that omitted sitY sank its occupant to the floor —
 * the reported bug. Do NOT fix that by raising STATES.sit_chair.rootY: the hot
 * tub (0.28) and both dive boards (4.55) share this pose and are already tuned
 * against the current value, so the correction belongs per-seat, here.
 */
const SIT_CONTACT_DROP = 0.125;
const seatOn = (topY: number): number => +(topY + SIT_CONTACT_DROP).toFixed(3);

/** Armchair + sofa cushion tops: a 0.13-tall pad centred at y 0.39 over the
 *  0.24-tall base slab (buildArmchair / buildSofa3). Verified against the
 *  built meshes in the running room, not just the source. */
const SOFT_SEAT_TOP = 0.455;

/** 🏊 River entry: two wading-in points, one per bank, at the places the
 *  centre line runs closest to that bank. Water seats put the occupant in the
 *  swim pose at the water plane — the pool idiom, reused. */
const beachRiverSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -4.0, z0: -3.0, x1: -1.0, z1: 0.0 },
    front: { x: -2.5, z: -4.4 },
    sit: { x: -2.5, z: -1.6 },
    faceAngle: 0,
    sitY: -0.35, // keep == POOL_WATER_Y (declared below this block)
    swim: true,
  },
  {
    clickBox: { x0: 1.0, z0: 0.0, x1: 4.0, z1: 3.0 },
    front: { x: 2.5, z: 4.4 },
    sit: { x: 2.5, z: 1.6 },
    faceAngle: Math.PI,
    sitY: -0.35, // keep == POOL_WATER_Y (declared below this block)
    swim: true,
  },
];

/** 🛋️ Sun lounger: you LIE on it. faceAngle points at the FEET end (+z), so
 *  the recline tips the head toward -z — the head end the backrest is at. */
const sunLoungerSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -1.0, x1: 0.5, z1: 1.0 },
    front: { x: 1.2, z: 0 },
    sit: { x: 0, z: 0.1 },
    faceAngle: 0,
    sitY: 0.47,
    lie: true,
  },
];

/** 🪑 Bar stool: seat top 0.865 to match the 1.28 m counter, and the occupant
 *  faces -z — the counter side, so guests sit looking INTO the room's bar. */
const tikiBarStoolSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: 0, z: 1.0 },
    sit: { x: 0, z: 0 },
    faceAngle: Math.PI,
    sitY: seatOn(0.865),
  },
];

const armchairLeftSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: 1.0, z: 0 },
    sit: { x: 0, z: 0 },
    faceAngle: Math.PI / 2,
    sitY: seatOn(SOFT_SEAT_TOP),
  },
];
const armchairRightSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: -1.0, z: 0 },
    sit: { x: 0, z: 0 },
    faceAngle: -Math.PI / 2,
    sitY: seatOn(SOFT_SEAT_TOP),
  },
];
// Back sofa: 3 cushions, faces +z (toward the entrance).
const sofaBackSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1.5, z0: -0.5, x1: -0.5, z1: 0.5 },
    front: { x: -1.0, z: 1.0 },
    sit: { x: -1.0, z: 0 },
    faceAngle: 0,
    sitY: seatOn(SOFT_SEAT_TOP),
  },
  {
    clickBox: { x0: -0.5, z0: -0.5, x1: 0.5, z1: 0.5 },
    front: { x: 0.0, z: 1.0 },
    sit: { x: 0.0, z: 0 },
    faceAngle: 0,
    sitY: seatOn(SOFT_SEAT_TOP),
  },
  {
    clickBox: { x0: 0.5, z0: -0.5, x1: 1.5, z1: 0.5 },
    front: { x: 1.0, z: 1.0 },
    sit: { x: 1.0, z: 0 },
    faceAngle: 0,
    sitY: seatOn(SOFT_SEAT_TOP),
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
    sitY: seatOn(SOFT_SEAT_TOP),
  },
  {
    clickBox: { x0: 0.0, z0: -0.5, x1: 1.5, z1: 0.5 },
    front: { x: 2.0, z: 0 },
    sit: { x: 1.0, z: 0 },
    faceAngle: Math.PI,
    sitY: seatOn(SOFT_SEAT_TOP),
  },
];

/** Casino booth cushion top: a 0.16-tall pad centred at y 0.45 over the
 *  0.28-tall velvet bench slab (buildCasinoBooth) — a taller seat than the
 *  lounge furniture, so it gets its own number. */
const BOOTH_SEAT_TOP = 0.53;

const casinoBoothSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -1, z0: -0.5, x1: 0, z1: 0.5 },
    front: { x: -0.48, z: 1.0 },
    sit: { x: -0.48, z: 0.03 },
    faceAngle: 0,
    sitY: seatOn(BOOTH_SEAT_TOP),
  },
  {
    clickBox: { x0: 0, z0: -0.5, x1: 1, z1: 0.5 },
    front: { x: 0.48, z: 1.0 },
    sit: { x: 0.48, z: 0.03 },
    faceAngle: 0,
    sitY: seatOn(BOOTH_SEAT_TOP),
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
// and the water lies BELOW its edge. Under `?octagon=1` (#80) the room floor
// STAYS solid and only the water cells are punched out (world.refreshOutdoorFloor
// → poolHoleCells), so the water sinks into the basement through a real hole with
// a drawn-in basin bottom. The legacy (flag-off) path instead HIDES the whole
// floor plane in the outdoor room and lets the pool's deck slabs be the flooring.
export const POOL_WATER_Y = -0.35; // water surface (splash spawn height)
export const POOL_SWIM_Y = -0.52; // avatar-root y while swimming (head above water)
export const DIVE_TIME = 0.9; // seconds board-tip → water
export const DIVE_ARC_LIFT = 0.55; // parabola apex above the straight chord

/** 🛑📐 #80: same octagon flag world.ts reads (now the DEFAULT — disable with
 *  `?octagon=0`). When on, the pool sinks into the BASEMENT through a real floor
 *  hole (a solid rect basin bottom is drawn in) instead of the legacy
 *  hidden-whole-floor trick. */
const OCTAGON_HULL =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("octagon") !== "0";

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
  // 🛏️ The bed splits down the middle of its LONG axis: the FOOT half — the end
  // the ladder is on — claims the TOP berth, the HEAD half (pillow at local
  // +0.62) claims the bottom one. Climb the ladder end to get up top.
  //
  // The foot zone used to be a 0.38 m strip against the very end of a 2 m bed
  // (x[-1.0,-0.62]) — the right idea, but under a fifth of the bed, so in
  // practice almost every click landed on the bottom berth and the top one was
  // close to unreachable. An even half is a target you can actually hit.
  //
  // Order still matters: findSeatAt returns the FIRST clickBox containing the
  // point, and the two boxes share the x=0 edge, so listing TOP first makes
  // that seam resolve deterministically upward.
  {
    clickBox: { x0: -1.0, z0: -0.5, x1: 0.0, z1: 0.5 },
    front: { x: -1.5, z: 0 },
    sit: { x: 0.05, z: 0 },
    faceAngle: -Math.PI / 2,
    sitY: BUNK_TOP_Y,
    lie: true,
  },
  {
    clickBox: { x0: 0.0, z0: -0.5, x1: 1.0, z1: 0.5 },
    front: { x: -1.5, z: 0 },
    sit: { x: 0.05, z: 0 },
    faceAngle: -Math.PI / 2,
    sitY: BUNK_BOTTOM_Y,
    lie: true,
  },
];

// ── 🎰 Slot machine seat + builder (issue #109) ──────────────────────────────
// The slot machine is a 1×2 footprint with ONE built-in chair seat. The player
// sits in the chair (facing the machine at faceAngle = 0) and can then focus
// the device to pull the lever. The front approach is from the -z side (the
// cabinet face points toward -z, while the seated player faces +z toward it).
// The extra metre separates the chair from the cabinet and leaves room for the
// stand/turn/slide choreography inside one honest collision footprint.
const slotMachineSeats: SeatTemplate[] = [
  {
    clickBox: { x0: -0.4, z0: -0.9, x1: 0.4, z1: -0.3 },
    front: { x: 0, z: -1.5 },
    sit: { x: 0, z: -0.62 },
    faceAngle: 0,
    sitY: seatOn(0.475),
    firstPerson: true,
  },
];


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

// 🎲 Craps table (3×1 footprint — 50% longer than roulette): 8 standing
// positions ringing it. Players line the two LONG (±z) faces, three per side,
// with one at each SHORT (±x) end. The MIDDLE of the +z long face is the
// STICKMAN — the reserved operator spot (owner / croupier robot) who works the
// dice stick. faceAngle points toward the table centre (atan2(nx,nz)): the +z
// side faces -z (π), the -z side faces +z (0), the +x end faces -x (-π/2), the
// -x end faces +x (π/2). Long faces sit 1.0 m beyond the ±0.5 z-edge; the ends
// 0.5 m beyond the ±1.5 x-edge — clear of the collision inflation so the avatar
// lands exactly on each front (same clearance rule as the roulette stands).
const crapsStands: StandTemplate[] = [
  { stand: { x: 0.0, z: 1.5 }, faceAngle: Math.PI, role: "stickman" },
  { stand: { x: -0.9, z: 1.5 }, faceAngle: Math.PI },
  { stand: { x: 0.9, z: 1.5 }, faceAngle: Math.PI },
  { stand: { x: -0.9, z: -1.5 }, faceAngle: 0 },
  { stand: { x: 0.0, z: -1.5 }, faceAngle: 0 },
  { stand: { x: 0.9, z: -1.5 }, faceAngle: 0 },
  { stand: { x: -2.0, z: 0.0 }, faceAngle: Math.PI / 2 },
  { stand: { x: 2.0, z: 0.0 }, faceAngle: -Math.PI / 2 },
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
  "smiley-bouquet": {
    kind: "smiley-bouquet",
    build: buildSmileyBouquet,
    footprint: null,
  },
  "rose-bouquet": {
    kind: "rose-bouquet",
    build: buildRoseBouquet,
    footprint: null,
  },
  "purple-bouquet": {
    kind: "purple-bouquet",
    build: buildPurpleBouquet,
    footprint: null,
  },
  "lavender-bouquet": {
    kind: "lavender-bouquet",
    build: buildLavenderBouquet,
    footprint: null,
  },
  "birthday-balloons": {
    kind: "birthday-balloons",
    build: buildBirthdayBalloons,
    footprint: null,
  },
  "birthday-balloons-wall": {
    kind: "birthday-balloons-wall",
    build: buildBirthdayBalloonsWall,
    footprint: null,
  },
  // ── 🎉 Party fixtures ──────────────────────────────────────────────────────
  // The three with a `device` are the room's VERBS; the three without are the
  // dressing. Device fronts follow the map-table convention: the stand point
  // sits just beyond the +z footprint edge and faceAngle π turns the avatar
  // back TOWARD the prop.
  //
  // 🎂 Cake table: 2×1 and solid, with open floor wanted on at least two sides
  // — it is the thing the whole room turns to face.
  "cake-table": {
    kind: "cake-table",
    build: buildCakeTable,
    footprint: { w: 2, d: 1 },
    functions: ["partyCake"],
    device: {
      kind: "cakeTable",
      front: { x: 0, z: 1.0 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.9, z: 1.1 },
      anchor: { x: 0, y: 1.55, z: 0 },
    },
  },
  // 🎁 Gift box: 1×1, solid, and deliberately CHEAP to place — guests pile
  // them by the cake in edit mode, which is half the point of shipping the
  // party cluster sparse.
  "gift-box": {
    kind: "gift-box",
    build: buildGiftBox,
    footprint: { w: 1, d: 1 },
    functions: ["partyGift"],
    device: {
      kind: "giftBox",
      front: { x: 0, z: 0.9 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.05, z: 0.8 },
      anchor: { x: 0, y: 0.35, z: 0 },
    },
  },
  // 🎊 Banner: footprint NULL — guests walk under it. See buildBirthdayBanner.
  "birthday-banner": {
    kind: "birthday-banner",
    build: buildBirthdayBanner,
    footprint: null,
  },
  // 🔊 Speaker: drives every dance floor in the room via `speaker:<itemId>`.
  "party-speaker": {
    kind: "party-speaker",
    build: buildPartySpeaker,
    footprint: { w: 1, d: 1 },
    functions: ["partySpeaker"],
    device: {
      kind: "partySpeaker",
      front: { x: 0, z: 0.9 },
      faceAngle: Math.PI,
      eye: { x: 0, y: 1.35, z: 0.85 },
      anchor: { x: 0, y: 0.7, z: 0 },
    },
  },
  // 💃 Dance floor: footprint NULL because it IS floor — an obstacle here
  // would make the one tile people are supposed to stand on unwalkable.
  "dance-floor": {
    kind: "dance-floor",
    build: buildDanceFloor,
    footprint: null,
  },
  "party-standing-table": {
    kind: "party-standing-table",
    build: buildPartyStandingTable,
    footprint: { w: 1, d: 1 },
  },
  // ── 🏝️ Beach fixtures — footprints and heights are the reference set's ────
  "palm-tree": { kind: "palm-tree", build: buildPalmTree, footprint: { w: 1, d: 1 } },
  "parasol": { kind: "parasol", build: buildParasol, footprint: { w: 1, d: 1 } },
  "sun-lounger": {
    kind: "sun-lounger",
    build: buildSunLounger,
    footprint: { w: 1, d: 2 },
    seats: sunLoungerSeats,
  },
  "surfboard": { kind: "surfboard", build: buildSurfboard, footprint: { w: 1, d: 1 } },
  "beach-towel": { kind: "beach-towel", build: buildBeachTowel, footprint: null },
  // A ball you walk past — solid:false in the reference, and an obstacle here
  // would strand anyone who kicked it into a doorway.
  "beach-ball": { kind: "beach-ball", build: buildBeachBall, footprint: null },
  "beach-crate": { kind: "beach-crate", build: buildBeachCrate, footprint: { w: 1, d: 1 } },
  "cooler": { kind: "cooler", build: buildCooler, footprint: { w: 1, d: 1 } },
  "tiki-torch": { kind: "tiki-torch", build: buildTikiTorch, footprint: { w: 1, d: 1 } },
  "tiki-bar-counter": {
    kind: "tiki-bar-counter",
    build: buildTikiBarCounter,
    footprint: { w: 4, d: 1 },
  },
  "tiki-back-bar": { kind: "tiki-back-bar", build: buildTikiBackBar, footprint: { w: 3, d: 1 } },
  "tiki-bar-stool": {
    kind: "tiki-bar-stool",
    build: buildTikiBarStool,
    footprint: { w: 1, d: 1 },
    seats: tikiBarStoolSeats,
  },
  "pergola-post": { kind: "pergola-post", build: buildPergolaPost, footprint: { w: 1, d: 1 } },
  // Overhead and non-solid: it shades the bar, it does not wall it off.
  "pergola-roof": { kind: "pergola-roof", build: buildPergolaRoof, footprint: null },
  // 🌊 The river. footprint null because a single AABB is exactly the wrong
  // shape for it — obstacleBoxes returns per-column strips instead, so the dry
  // sand at the bends and the far bank stay walkable.
  "beach-river": {
    kind: "beach-river",
    build: buildBeachRiver,
    footprint: null,
    obstacleBoxes: riverObstacleBoxes,
    seats: beachRiverSeats,
  },
  // 🌉 The crossing. footprint null and NOT an obstacle: it exists precisely to
  // make cells walkable that the river took away.
  "plank-bridge": { kind: "plank-bridge", build: buildPlankBridge, footprint: null },
  // 🌊 Flat sea at floor level. footprint null; blocked per tile run.
  "beach-sea": {
    kind: "beach-sea",
    build: buildBeachSea,
    footprint: null,
    obstacleBoxes: () => seaObstacleBoxes(),
  },
  // 🏊 Terraced infinity pool. footprint null; blocked per column, minus bridges.
  "infinity-pool": {
    kind: "infinity-pool",
    build: buildInfinityPool,
    footprint: null,
    obstacleBoxes: (_item, all) => infinityPoolObstacleBoxes(all),
  },
  "tiki-parasol": { kind: "tiki-parasol", build: buildTikiParasol, footprint: { w: 1, d: 1 } },
  // Floats on the sea — a thing you look at, not a tile you stand on.
  "beach-raft": { kind: "beach-raft", build: buildBeachRaft, footprint: null },
  "jungle-plant": { kind: "jungle-plant", build: buildJunglePlant, footprint: { w: 1, d: 1 } },
  // 🌹 Climbing rose: wall-mounted like the terminal (footprint null, never
  // an obstacle, pose derived from the wall — see snapInteriorWall), 1 m of
  // wall, 3.6 m tall.
  "climbing-rose": {
    kind: "climbing-rose",
    build: buildClimbingRose,
    footprint: null,
    wallMount: { halfW: 0.5 },
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
    wallMount: { halfW: WC_W / 2 },
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
  // 🖼️ #80 S6: the old freestanding brick-wall / window-wall SEGMENTS retired —
  // the octagon hull is the wall now, re-skinnable via the wallpaper editor
  // (their brick look lives on as the `brick` wallpaper preset). See wallpaper.ts.
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
  // 🎲 #69 G3: the craps table — a 3×1 footprint (50% longer than roulette),
  // eight standing positions with a reserved STICKMAN operator spot. Device
  // front is the -z player rail; the walk-up picker gathers players at the open
  // stands and posts the robot at the stickman slot.
  "craps-table": {
    kind: "craps-table",
    build: buildCrapsTable,
    footprint: { w: 3, d: 1 },
    functions: ["crapsTable"],
    stands: crapsStands,
    device: {
      kind: "craps",
      front: { x: 0, z: -1.4 },
      faceAngle: 0,
      eye: { x: 0, y: 1.7, z: -1.3 },
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
  // 🎰 Slot machine (issue #109) — 1×2 footprint with a built-in chair.
  // The seat faces +z toward the cabinet; approach is beyond the -z edge. The
  // device focus zooms the camera to the machine face; the player can also
  // look around in first-person from the chair. The builder + seat template
  // are function-declared below (FURNITURE_DEFS evaluates them at load time,
  // but function declarations hoist — same pattern as bunk-bed / clone-vat).
  "slot-machine": {
    kind: "slot-machine",
    build: buildSlotMachine,
    footprint: { w: 1, d: 2 },
    functions: ["slotMachine"],
    seats: slotMachineSeats,
    device: {
      kind: "slotMachine",
      front: { x: 0, z: -1.5 },
      faceAngle: 0,
      eye: { x: 0, y: 1.50, z: -1.45 },
      anchor: { x: 0, y: 1.35, z: 0.45 },
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
// 🖼️ #80 S6: buildBrickWall / buildWindowWall retired — see the wallpaper editor
// (their brick + glazed looks are the `brick` wallpaper preset + the window
// editor now). The octagon hull is the standard wall.

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

  // 🏖️ #80: sand BEACH filling the strip between the organic water and the deck
  // rectangle. Once the floor hole is cut to the water's EXACT outline (#80), the
  // bare room floor shows through that strip; legacy hid the whole floor so it
  // never did. The pool rect MINUS the water outline, in sand, just above the
  // floor — so the beach reads continuous from the water edge out to the deck.
  {
    const beach = new THREE.Shape();
    beach.moveTo(-WX, -HZ);
    beach.lineTo(HX, -HZ);
    beach.lineTo(HX, HZ);
    beach.lineTo(-WX, HZ);
    beach.closePath();
    const waterHole = new THREE.Path();
    const bp = makeLazyRiver().getPoints(48); // outer water contour (island excluded)
    waterHole.moveTo(bp[0].x, bp[0].y);
    for (let i = 1; i < bp.length; i++) waterHole.lineTo(bp[i].x, bp[i].y);
    waterHole.closePath();
    beach.holes.push(waterHole);
    const beachGeo = new THREE.ShapeGeometry(beach, 48);
    beachGeo.rotateX(-Math.PI / 2);
    const beachMat = m(SAND, 0.98, 0);
    beachMat.side = THREE.DoubleSide; // face up regardless of winding
    place(beachGeo, beachMat, 0, 0.02, 0);
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

/** Craps felt (canvas 768×256, a 3:1 table): green baize with the classic
 *  layout schematic — PASS LINE / DON'T PASS along the rails, the number boxes
 *  and FIELD across the centre. Painted once; the LIVE board is the focused UI. */
function drawCrapsFelt(c2d: CanvasRenderingContext2D): void {
  const W = 768, H = 256;
  c2d.fillStyle = "#14532D";
  c2d.fillRect(0, 0, W, H);
  c2d.fillStyle = "#1B6B3A";
  c2d.fillRect(10, 10, W - 20, H - 20);
  c2d.strokeStyle = "rgba(240, 224, 180, 0.85)";
  c2d.lineWidth = 3;
  c2d.strokeRect(10, 10, W - 20, H - 20);
  c2d.fillStyle = "#F0E6C8";
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  // The point-number boxes across the top (4 5 6 8 9 10 — the felt's spine).
  const nums = [4, 5, 6, 8, 9, 10];
  const bw = 108, bx0 = 44, by = 34, bh = 74;
  nums.forEach((n, i) => {
    const bx = bx0 + i * bw;
    c2d.strokeRect(bx, by, bw - 8, bh);
    c2d.font = "bold 40px monospace";
    c2d.fillText(String(n), bx + (bw - 8) / 2, by + bh / 2);
  });
  // FIELD strip.
  c2d.strokeRect(44, 128, W - 88, 44);
  c2d.font = "bold 24px monospace";
  c2d.fillText("FIELD  ·  2  3  4  9  10  11  12", W / 2, 150);
  // PASS / DON'T PASS rails along the bottom.
  c2d.strokeRect(44, 186, (W - 96) / 2, 44);
  c2d.strokeRect(52 + (W - 96) / 2, 186, (W - 96) / 2, 44);
  c2d.font = "bold 26px monospace";
  c2d.fillText("PASS  LINE", 44 + (W - 96) / 4, 208);
  c2d.fillText("DON'T  PASS", 52 + (W - 96) * 0.75, 208);
}

/** 🎲 Craps table (#69 G3): a long green baize table — 50% longer than the
 *  roulette table (3×1 vs 2×1) — with a padded rail, the layout felt, chip rails
 *  along both long sides, and the STICKMAN's dice stick resting on the +z rail. */
function buildCrapsTable(ctx: BuildCtx) {
  const { m, place } = ctx;
  const HALF_X = 1.43; // top slab half-width along x (~2.86 → inside the 3×1 footprint)
  const HALF_Z = 0.48;
  // Base apron.
  place(
    new THREE.BoxGeometry(HALF_X * 2 - 0.1, 0.14, 0.86),
    m(0x4a2f1b, 0.55, 0.15),
    0, 0.62, 0,
  );
  // Six legs (a long table needs a middle pair).
  (
    [
      [-1.28, -0.35], [-1.28, 0.35],
      [0.0, -0.35], [0.0, 0.35],
      [1.28, -0.35], [1.28, 0.35],
    ] as [number, number][]
  ).forEach(([lx, lz]) => {
    place(new THREE.BoxGeometry(0.12, 0.62, 0.12), m(0x3a2417, 0.55, 0.18), lx, 0.31, lz);
    place(new THREE.BoxGeometry(0.15, 0.04, 0.15), m(0x4a2f1b, 0.5, 0.2), lx, 0.02, lz);
  });
  // Top slab + padded rim.
  place(
    new THREE.BoxGeometry(HALF_X * 2, 0.07, HALF_Z * 2),
    m(0x4a2f1b, 0.5, 0.2),
    0, 0.775, 0,
  );
  for (const [w, d, lx, lz] of [
    [HALF_X * 2, 0.08, 0, -HALF_Z],
    [HALF_X * 2, 0.08, 0, HALF_Z],
    [0.08, HALF_Z * 2, -HALF_X, 0],
    [0.08, HALF_Z * 2, HALF_X, 0],
  ] as [number, number, number, number][]) {
    place(new THREE.BoxGeometry(w, 0.09, d), m(0x3a2417, 0.6, 0.1), lx, 0.845, lz);
  }
  // Felt (canvas) across the top.
  const feltCv = document.createElement("canvas");
  feltCv.width = 768;
  feltCv.height = 256;
  drawCrapsFelt(feltCv.getContext("2d")!);
  const feltTex = new THREE.CanvasTexture(feltCv);
  feltTex.minFilter = THREE.NearestFilter;
  feltTex.magFilter = THREE.NearestFilter;
  feltTex.generateMipmaps = false;
  feltTex.colorSpace = THREE.SRGBColorSpace;
  const feltGeo = new THREE.PlaneGeometry(HALF_X * 2 - 0.12, HALF_Z * 2 - 0.12);
  feltGeo.rotateX(-Math.PI / 2);
  place(
    feltGeo,
    new THREE.MeshBasicMaterial({ map: feltTex, transparent: true, opacity: 0 }),
    0, 0.812, 0,
  );
  // Chip rails along both long sides (raised troughs).
  for (const rz of [-HALF_Z + 0.06, HALF_Z - 0.06]) {
    place(new THREE.BoxGeometry(HALF_X * 2 - 0.3, 0.03, 0.07), m(0x3a2417, 0.6, 0.1), 0, 0.86, rz);
  }
  // Deco chip stacks in the rails.
  const chipColors = [0xc43c3c, 0x3e92b8, 0xf0c060, 0x2e7d46];
  chipColors.forEach((col, i) => {
    place(
      new THREE.CylinderGeometry(0.045, 0.045, 0.06, 12),
      m(col, 0.5, 0.25),
      -1.0 + i * 0.12,
      0.9,
      HALF_Z - 0.06,
    );
  });
  // 🎲 The STICKMAN's dice stick — a slim curved stick resting on the +z rail at
  // the middle (the reserved operator's tool). A shaft + a small hook at the end.
  const stick = place(
    new THREE.CylinderGeometry(0.014, 0.014, 0.9, 8),
    m(0x8a5a2a, 0.5, 0.2),
    0.0, 0.905, HALF_Z - 0.02,
  );
  stick.rotation.z = Math.PI / 2; // lie flat along x
  const hook = place(
    new THREE.TorusGeometry(0.05, 0.012, 6, 12, Math.PI),
    m(0x8a5a2a, 0.5, 0.2),
    0.45, 0.905, HALF_Z - 0.02,
  );
  hook.rotation.x = Math.PI / 2;
  // Two dice resting at the stickman's spot (deco).
  for (const dx of [-0.05, 0.05]) {
    place(
      new THREE.BoxGeometry(0.05, 0.05, 0.05),
      m(0xf4efe2, 0.4, 0.1),
      dx, 0.87, HALF_Z - 0.14,
    );
  }
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
  // Stow on a tiny carrier mesh inside the plinth — collected by
  // registerFurnitureHandles (furnitureHandles.ts, the one list both World
  // and devMenu's registerSpawnedGroup file through) exactly like
  // userData.trunkLid.
  const carrier = place(
    new THREE.BoxGeometry(0.01, 0.01, 0.01),
    m(BODY, 0.5, 0.5),
    0,
    0.05,
    0,
  );
  carrier.userData.cloneVat = handle;
}

// ── 🎰 Slot machine (issue #109) — upright cabinet + built-in chair ──────────
// Classic electro-mechanical styling: a tall gunmetal cabinet on four stubby
// legs, padded seat bolted to the front, a large glazed pay window showing the
// three reel symbols, denomination display at the top, and a side-mounted pull
// lever. A coin tray at the bottom catches winning chips. The canvas face
// texture paints the current paytable so odds are always visible to the player.
//
// Local frame (rot 0): the cabinet FACE (player side) is at z ≈ +0.4, the
// seat is centred at z ≈ −0.62, and the machine back is at z ≈ +0.95.
// The pull lever is on the right side (+x).
function buildSlotMachine({
  itemId,
  m,
  place: addPlace,
  addLight: addPointLight,
  attach,
}: BuildCtx) {
  const BODY    = 0x2a3444; // gunmetal (wall-computer family)
  const CHROME  = 0x8a93a0; // steel trim
  const GOLD    = 0xd4a84b; // accent gold
  const GLASS   = 0xb8d4f8; // pay-window glass tint
  const FELT    = 0x2e7d46; // seat pad green
  const LIGHT   = 0xfff0c8; // warm top light

  // The cabinet occupies the rear 1×1 square of the 1×2 footprint. Its back
  // lands at z ≈ +0.94 (the footprint edge is +1.0), while the chair remains
  // in the front square with enough clear knee space between them.
  const cabinet = new THREE.Group();
  cabinet.position.z = 0.5;
  attach(cabinet);
  const place: BuildCtx["place"] = (...args) => {
    const mesh = addPlace(...args);
    cabinet.add(mesh);
    return mesh;
  };
  const addLight: BuildCtx["addLight"] = (light, ...args) => {
    addPointLight(light, ...args);
    cabinet.add(light);
  };

  // ── Cabinet body ──────────────────────────────────────────────────────────
  // Main box (z: −0.10 → +0.44, y: 0.38 → 1.90, x: −0.30 → +0.30)
  place(new THREE.BoxGeometry(0.60, 1.52, 0.54), m(BODY,   0.55, 0.45), 0, 1.14, 0.17);
  // Chrome side-trim strips
  for (const sx of [-0.30, 0.30]) {
    place(new THREE.BoxGeometry(0.025, 1.50, 0.56), m(CHROME, 0.4, 0.6), sx, 1.14, 0.17);
  }
  // Base plinth + four legs
  place(new THREE.BoxGeometry(0.64, 0.08, 0.58), m(BODY, 0.55, 0.4), 0, 0.39, 0.17);
  for (const [lx, lz] of [[-0.24, -0.06], [0.24, -0.06], [-0.24, 0.40], [0.24, 0.40]] as const) {
    place(new THREE.BoxGeometry(0.08, 0.38, 0.08), m(CHROME, 0.4, 0.6), lx, 0.19, lz);
    // Rubber foot
    place(new THREE.BoxGeometry(0.10, 0.03, 0.10), m(0x14181e, 0.9, 0.1), lx, 0.015, lz);
  }

  // ── Top dome / marquee ────────────────────────────────────────────────────
  place(new THREE.BoxGeometry(0.62, 0.14, 0.56), m(BODY,   0.55, 0.45), 0, 1.92, 0.17);
  place(new THREE.BoxGeometry(0.58, 0.04, 0.52), m(GOLD,   0.4,  0.5 ), 0, 1.86, 0.17);
  // Neon-strip indicator at the very top doubles as the owner's service key.
  const serviceLight = place(
    new THREE.BoxGeometry(0.48, 0.065, 0.04),
    m(GOLD, 0.25, 0.5, GOLD, 1.2),
    0,
    1.965,
    -0.14,
  );
  serviceLight.userData.slotControl = "service";
  serviceLight.userData.slotMachineId = itemId;
  // Top-mount warm point light (dims ambient lighting on the player)
  addLight(new THREE.PointLight(LIGHT, 0, 2.2), 0, 2.1, -0.12, 0.35);

  // ── Pay window (glazed opening showing three reel drums) ──────────────────
  // Four trim rails leave the reel window genuinely open (a solid box here
  // depth-occludes the glass and drums).
  const windowTrim = m(CHROME, 0.4, 0.6);
  place(new THREE.BoxGeometry(0.50, 0.035, 0.025), windowTrim, 0, 1.465, -0.19);
  place(new THREE.BoxGeometry(0.50, 0.035, 0.025), windowTrim, 0, 1.135, -0.19);
  place(new THREE.BoxGeometry(0.035, 0.30, 0.025), windowTrim, -0.2325, 1.30, -0.19);
  place(new THREE.BoxGeometry(0.035, 0.30, 0.025), windowTrim, 0.2325, 1.30, -0.19);
  // Glass panel (semi-transparent tint — baseOpacity so morph keeps it translucent)
  {
    const glassMat = m(GLASS, 0.05, 0.0);
    glassMat.transparent = true;
    glassMat.userData.baseOpacity = 0.22;
    place(new THREE.BoxGeometry(0.46, 0.30, 0.008), glassMat, 0, 1.30, -0.188);
  }
  // Three physical reel drums with the complete seven-symbol strip wrapped
  // around each circumference. The drum rotation itself moves the symbols.
  const reelDrums: THREE.Mesh[] = [];
  const symbolFaces: Record<SlotSymbol, { face: string; color: string }> = {
    cherry: { face: "🍒", color: "#B91C1C" },
    lemon: { face: "🍋", color: "#CA8A04" },
    orange: { face: "🍊", color: "#EA580C" },
    plum: { face: "PLUM", color: "#7E22CE" },
    bell: { face: "🔔", color: "#B7791F" },
    bar: { face: "BAR", color: "#111827" },
    seven: { face: "7", color: "#DC2626" },
  };
  const stripCell = 256;
  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = stripCell * SLOT_SYMBOLS.length;
  stripCanvas.height = stripCell;
  const stripContext = stripCanvas.getContext("2d")!;
  stripContext.fillStyle = "#F5F0E4";
  stripContext.fillRect(0, 0, stripCanvas.width, stripCanvas.height);
  for (let cell = 0; cell < SLOT_SYMBOLS.length; cell++) {
    // CylinderGeometry's front is UV u=.5. The baked Z rotation makes larger
    // reel positions sample decreasing u, so cell 3 is stop zero and the
    // remaining symbols proceed in reverse UV order around the drum.
    const symbol = SLOT_SYMBOLS[(3 - cell + SLOT_SYMBOLS.length) % SLOT_SYMBOLS.length];
    const presentation = symbolFaces[symbol];
    const centerX = cell * stripCell + stripCell / 2;
    stripContext.save();
    stripContext.translate(centerX, stripCell / 2);
    stripContext.rotate(-Math.PI / 2);
    stripContext.fillStyle = presentation.color;
    stripContext.font = symbol === "plum" || symbol === "bar"
      ? "bold 76px sans-serif"
      : "116px 'Segoe UI Emoji', sans-serif";
    stripContext.textAlign = "center";
    stripContext.textBaseline = "middle";
    stripContext.fillText(presentation.face, 0, 2);
    stripContext.restore();
    stripContext.strokeStyle = "rgba(80,70,55,.18)";
    stripContext.lineWidth = 4;
    stripContext.strokeRect(cell * stripCell + 2, 2, stripCell - 4, stripCell - 4);
  }
  const stripTexture = new THREE.CanvasTexture(stripCanvas);
  stripTexture.minFilter = THREE.LinearMipmapLinearFilter;
  stripTexture.magFilter = THREE.LinearFilter;
  stripTexture.generateMipmaps = true;
  stripTexture.anisotropy =
    window.gameRenderer?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  stripTexture.colorSpace = THREE.SRGBColorSpace;
  const stripMaterial = m(0xffffff, 0.52, 0.08);
  stripMaterial.map = stripTexture;
  stripMaterial.userData.baseOpacity = 1;
  for (let i = 0; i < 3; i++) {
    const rx = (i - 1) * 0.14;
    const drumGeometry = new THREE.CylinderGeometry(0.095, 0.095, 0.10, 56);
    drumGeometry.rotateZ(Math.PI / 2);
    reelDrums.push(place(
      drumGeometry,
      stripMaterial,
      rx,
      1.30,
      -0.09,
    ));
  }

  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = 512;
  displayCanvas.height = 128;
  const displayContext = displayCanvas.getContext("2d")!;
  const displayTexture = new THREE.CanvasTexture(displayCanvas);
  displayTexture.minFilter = THREE.LinearMipmapLinearFilter;
  displayTexture.magFilter = THREE.LinearFilter;
  displayTexture.generateMipmaps = true;
  displayTexture.anisotropy =
    window.gameRenderer?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  displayTexture.colorSpace = THREE.SRGBColorSpace;
  const displayMaterial = new THREE.MeshBasicMaterial({
    map: displayTexture,
    transparent: true,
    opacity: 0,
  });
  displayMaterial.userData.baseOpacity = 0.96;
  place(
    new THREE.PlaneGeometry(0.38, 0.055),
    displayMaterial,
    0,
    1.60,
    -0.118,
    Math.PI,
  );

  const reelSpeeds = [14, 17, 20] as const;
  const reelLandingSeconds = [0.62, 0.84, 1.06] as const;
  let spinningRequest: string | null = null;
  let spinElapsed = 0;
  let landingRequest: string | null = null;
  let landingElapsed = 0;
  let reelPositions: [number, number, number] = [0, 2, 4];
  let landingStarts: [number, number, number] = [0, 0, 0];
  let landingTargets: [number, number, number] = [0, 0, 0];
  let denomination = 5;
  let displayText = "";
  let displayedRequest: string | null = null;
  const leverRestAngle = -0.35;
  const leverPulledAngle = -1.35;
  let leverPivot: THREE.Group | null = null;
  let leverPullElapsed = -1;
  const positiveModulo = (value: number, divisor: number): number =>
    ((value % divisor) + divisor) % divisor;
  const paintPhysicalReels = (): void => {
    for (let reelIndex = 0; reelIndex < 3; reelIndex++) {
      const position = reelPositions[reelIndex];
      reelDrums[reelIndex].rotation.x =
        -(position / SLOT_SYMBOLS.length) * Math.PI * 2;
    }
  };
  const paintDisplay = (text: string): void => {
    if (text === displayText) return;
    displayText = text;
    displayContext.fillStyle = "#04140B";
    displayContext.fillRect(0, 0, 512, 128);
    displayContext.strokeStyle = "#00C060";
    displayContext.lineWidth = 6;
    displayContext.strokeRect(4, 4, 504, 120);
    displayContext.fillStyle = "#73FFAA";
    displayContext.font = "bold 58px monospace";
    displayContext.textAlign = "center";
    displayContext.textBaseline = "middle";
    displayContext.fillText(text.slice(0, 14), 256, 66);
    displayTexture.needsUpdate = true;
  };
  const failureDisplay = (failure: SlotFailure): string => {
    const labels: Record<SlotFailure, string> = {
      "insufficient-player-funds": "NO CHIPS",
      "insufficient-bankroll": "HOUSE SHORT",
      "shared-funding-unavailable": "SHARED OFF",
      "odds-changed": "ODDS CHANGED",
      "request-expired": "REQUEST OLD",
      "reveal-timeout": "REFUNDED",
      "invalid-house-commit": "REFUNDED",
    };
    return labels[failure];
  };
  const handle: SlotMachineVisualHandle = {
    setDenomination(amount: number): void {
      denomination = amount;
      paintDisplay(`BET ${amount}`);
    },
    showMessage(message: string): void {
      paintDisplay(message.toUpperCase());
    },
    pullLever(): void {
      leverPullElapsed = 0;
    },
    update(deltaTime: number): void {
      const state = readSlotMachineState(itemId);
      const elapsed = Math.max(0, deltaTime);
      if (leverPivot) {
        if (leverPullElapsed >= 0) {
          leverPullElapsed += elapsed;
          const progress = Math.min(1, leverPullElapsed / 0.7);
          const down = progress < 0.45
            ? progress / 0.45
            : 1 - (progress - 0.45) / 0.55;
          const eased = Math.max(0, Math.min(1, down));
          const smooth = eased * eased * (3 - 2 * eased);
          leverPivot.rotation.x =
            leverRestAngle + (leverPulledAngle - leverRestAngle) * smooth;
          if (progress >= 1) {
            leverPullElapsed = -1;
            leverPivot.rotation.x = leverRestAngle;
          }
        } else {
          leverPivot.rotation.x = leverRestAngle;
        }
      }
      if (state?.phase === "spinning") {
        if (spinningRequest !== state.requestId) {
          spinningRequest = state.requestId;
          spinElapsed = Math.max(0, (Date.now() - state.acceptedAt) / 1000);
          landingRequest = null;
          landingElapsed = 0;
          const roundOffset = state.round * 3;
          reelPositions = [roundOffset, roundOffset + 2, roundOffset + 4];
          paintDisplay("SPIN");
        }
        spinElapsed += elapsed;
        const speedScale = 0.25 + 0.75 * Math.min(1, spinElapsed / 0.28);
        reelPositions = reelPositions.map((position, reelIndex) =>
          position + reelSpeeds[reelIndex] * speedScale * elapsed,
        ) as [number, number, number];
      } else {
        if (state?.phase === "settled"
          && state.requestId === spinningRequest
          && state.result
          && state.requestId !== landingRequest) {
          landingRequest = state.requestId;
          landingElapsed = 0;
          landingStarts = [...reelPositions];
          landingTargets = reelPositions.map((position, reelIndex) => {
            const finalIndex = SLOT_SYMBOLS.indexOf(state.result![reelIndex]);
            const minimumTravel =
              reelSpeeds[reelIndex] * reelLandingSeconds[reelIndex] * 0.72;
            let target = Math.ceil(position + minimumTravel);
            target += positiveModulo(finalIndex - target, SLOT_SYMBOLS.length);
            return target;
          }) as [number, number, number];
        }
        if (state?.phase === "settled"
          && state.requestId
          && state.requestId !== displayedRequest) {
          displayedRequest = state.requestId;
          paintDisplay(state.failure
            ? failureDisplay(state.failure)
            : state.credited
              ? `WIN ${state.credited}`
              : "NO WIN");
        }
        spinningRequest = null;
        const landing = state?.phase === "settled"
          && state.requestId === landingRequest
          && state.result !== null
          && landingElapsed < reelLandingSeconds[2];
        if (landing) {
          landingElapsed += elapsed;
          reelPositions = reelPositions.map((_position, reelIndex) => {
            const progress = Math.min(1, landingElapsed / reelLandingSeconds[reelIndex]);
            const eased = 1 - Math.pow(1 - progress, 3);
            return landingStarts[reelIndex]
              + (landingTargets[reelIndex] - landingStarts[reelIndex]) * eased;
          }) as [number, number, number];
        } else if (state?.result) {
          reelPositions = state.result.map((symbol) => SLOT_SYMBOLS.indexOf(symbol)) as
            [number, number, number];
        }
      }
      paintPhysicalReels();
    },
  };
  const visualCarrier = reelDrums[0];
  visualCarrier.userData.slotMachineVisual = handle; // collected by registerFurnitureHandles (furnitureHandles.ts)
  paintPhysicalReels();
  paintDisplay(`BET ${denomination}`);

  // ── Paytable panel below the window ──────────────────────────────────────
  {
    const pcv = document.createElement('canvas');
    pcv.width = 512; pcv.height = 320;
    const pc2 = pcv.getContext('2d')!;
    const ptex = new THREE.CanvasTexture(pcv);
    ptex.minFilter = THREE.LinearMipmapLinearFilter;
    ptex.magFilter = THREE.LinearFilter;
    ptex.generateMipmaps = true;
    ptex.anisotropy =
      window.gameRenderer?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    ptex.colorSpace = THREE.SRGBColorSpace;
    const pmat = new THREE.MeshBasicMaterial({
      map: ptex, transparent: true, opacity: 0,
    });
    pmat.userData.baseOpacity = 0.96;
    const pgeo = new THREE.PlaneGeometry(0.44, 0.20);
    // PlaneGeometry faces +z; rotate it toward the player on the -z side and
    // keep it just proud of the opaque cabinet face.
    const panel = place(pgeo, pmat, 0, 1.05, -0.112, Math.PI);
    const drawPaytable = (paytable: readonly SlotPayEntry[]): void => {
      pc2.fillStyle = '#14181E';
      pc2.fillRect(0, 0, 512, 320);
      pc2.strokeStyle = '#3A424C';
      pc2.lineWidth = 4;
      pc2.strokeRect(4, 4, 504, 312);
      pc2.fillStyle = '#D4A84B';
      pc2.font = 'bold 32px monospace';
      pc2.textAlign = 'center';
      pc2.fillText(`PAYTABLE · RTP ${computeRTP(paytable).toFixed(2)}%`, 256, 48);
      pc2.fillStyle = '#E8ECF2';
      pc2.font = '28px monospace';
      paytable.slice(0, 5).forEach((entry, ri) => {
        pc2.fillText(
          `${entry.label.slice(0, 14)} → ${entry.multiplier}×`,
          256,
          100 + ri * 44,
        );
      });
      ptex.needsUpdate = true;
    };
    let lastPaytable = "";
    const repaint = (): void => {
      const paytable = readSlotOddsConfig(itemId)?.paytable ?? DEFAULT_PAYTABLE;
      const fingerprint = JSON.stringify(paytable);
      if (fingerprint === lastPaytable) return;
      lastPaytable = fingerprint;
      drawPaytable(paytable);
    };
    const unsubscribe = subscribeCasinoKey(`slot-odds:${itemId}`, repaint);
    panel.userData.disposeSlotPaytable = unsubscribe;
    repaint();
  }

  // ── Denomination / credit display above window ─────────────────────────────
  place(new THREE.BoxGeometry(0.46, 0.09, 0.03), m(0x14181e, 0.85, 0.1), 0, 1.60, -0.10);

  // ── Denomination push buttons (4 × chip colors) ──────────────────────────
  const denomCols = [0xe8e2d2, 0xc43c3c, 0x2e7d46, 0x23252e] as const; // 1/5/25/100
  const denominations = [1, 5, 25, 100] as const;
  for (let bi = 0; bi < 4; bi++) {
    const bx = -0.18 + bi * 0.12;
    // Button housing
    const housing = place(
      new THREE.BoxGeometry(0.09, 0.06, 0.04),
      m(0x3d4a5e, 0.55, 0.4),
      bx,
      0.85,
      -0.105,
    );
    // Button face (chip colour)
    const face = place(new THREE.CylinderGeometry(0.025, 0.025, 0.015, 10),
      m(denomCols[bi], 0.5, 0.25), bx, 0.885, -0.112);
    for (const button of [housing, face]) {
      button.userData.slotControl = "denomination";
      button.userData.slotValue = denominations[bi];
      button.userData.slotMachineId = itemId;
    }
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 128;
    labelCanvas.height = 64;
    const labelContext = labelCanvas.getContext("2d")!;
    labelContext.fillStyle = "#101820";
    labelContext.fillRect(0, 0, 128, 64);
    labelContext.fillStyle = "#F5F0E4";
    labelContext.font = "bold 38px monospace";
    labelContext.textAlign = "center";
    labelContext.textBaseline = "middle";
    labelContext.fillText(String(denominations[bi]), 64, 34);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.minFilter = THREE.LinearMipmapLinearFilter;
    labelTexture.magFilter = THREE.LinearFilter;
    labelTexture.generateMipmaps = true;
    labelTexture.anisotropy =
      window.gameRenderer?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true,
      opacity: 0,
    });
    labelMaterial.userData.baseOpacity = 1;
    const label = place(
      new THREE.PlaneGeometry(0.07, 0.035),
      labelMaterial,
      bx,
      0.85,
      -0.132,
      Math.PI,
    );
    label.userData.slotControl = "denomination";
    label.userData.slotValue = denominations[bi];
    label.userData.slotMachineId = itemId;
  }

  // ── Coin tray (winning chips come out here) ───────────────────────────────
  place(new THREE.BoxGeometry(0.44, 0.06, 0.12), m(CHROME, 0.4, 0.5), 0, 0.64, -0.13);
  // Tray interior (slightly recessed dark)
  place(new THREE.BoxGeometry(0.40, 0.03, 0.10), m(0x14181e, 0.85, 0.1), 0, 0.64, -0.135);

  // ── Pull lever (right side, +x) ───────────────────────────────────────────
  // A horizontal axle projects perpendicular to the cabinet's right side.
  // Shaft and grip share one centerline at its outer end; the whole axle group
  // rotates around X for the pull animation.
  const leverMeshes: THREE.Mesh[] = [];
  leverPivot = new THREE.Group();
  leverPivot.position.set(0.37, 1.06, 0.07);
  leverPivot.rotation.x = leverRestAngle;
  cabinet.add(leverPivot);
  const axleGeometry = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 16);
  axleGeometry.rotateZ(Math.PI / 2);
  const axle = place(axleGeometry, m(CHROME, 0.35, 0.72), 0, 0, 0);
  leverPivot.add(axle);
  leverMeshes.push(axle);
  const axleCapGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.018, 16);
  axleCapGeometry.rotateZ(Math.PI / 2);
  const axleCap = place(axleCapGeometry, m(GOLD, 0.3, 0.58), 0.089, 0, 0);
  leverPivot.add(axleCap);
  leverMeshes.push(axleCap);
  const armX = 0.08;
  const grip = place(
    new THREE.SphereGeometry(0.045, 10, 8),
    m(GOLD, 0.35, 0.5),
    armX,
    0.60,
    0,
  );
  leverPivot.add(grip);
  leverMeshes.push(grip);
  // Shaft top and ball center share x/z exactly; a slight overlap makes the
  // connection continuous instead of leaving a visible gap.
  {
    const shaft = place(new THREE.CylinderGeometry(0.018, 0.020, 0.58, 10),
      m(CHROME, 0.4, 0.6), armX, 0.29, 0);
    leverPivot.add(shaft);
    leverMeshes.push(shaft);
  }
  for (const lever of leverMeshes) {
    lever.userData.slotControl = "pull";
    lever.userData.slotMachineId = itemId;
  }

  // ── Built-in chair ────────────────────────────────────────────────────────
  // These meshes opt out of the group's generic device hit tagging: chair
  // clicks must fall through to the seat click box, not open the machine UI.
  const chairMeshes: THREE.Mesh[] = [];
  // Seat pad (at y ≈ 0.44, with clear knee room before the cabinet)
  chairMeshes.push(addPlace(
    new THREE.BoxGeometry(0.46, 0.07, 0.38),
    m(FELT, 0.85, 0.04),
    0,
    0.44,
    -0.62,
  ));
  // Seat base / pedestal
  chairMeshes.push(addPlace(
    new THREE.BoxGeometry(0.16, 0.44, 0.16),
    m(CHROME, 0.4, 0.6),
    0,
    0.22,
    -0.62,
  ));
  // Pedestal foot
  chairMeshes.push(addPlace(
    new THREE.BoxGeometry(0.34, 0.04, 0.34),
    m(CHROME, 0.4, 0.5),
    0,
    0.02,
    -0.62,
  ));
  // Low back rest
  chairMeshes.push(addPlace(
    new THREE.BoxGeometry(0.44, 0.22, 0.06),
    m(FELT, 0.85, 0.04),
    0,
    0.65,
    -0.84,
  ));
  for (const mesh of chairMeshes) mesh.userData.skipDeviceHit = true;
}


// ── 🌊 The beach river ──────────────────────────────────────────────────────
/**
 * The party skill's river, built the way it says to build one: a WIDE, WINDING
 * channel across the FRONT of the room, generated from a sine centre line
 * rather than drawn by hand, terraced so every bend shows a side face, with a
 * darker deep channel down the middle and foam where the water meets the bank.
 *
 * WHY NOT lazy-pool: that is a ring around an island — a lazy river in the
 * water-park sense. This is a river in the landscape sense: it crosses the
 * scene, it has two banks, and you need a bridge.
 *
 * ONE DEVIATION FROM THE REFERENCE, and it is forced: the reference terraces
 * sand 0 → wet −0.35 → water −0.75 → deep −1.1. Here the WATER SURFACE must
 * stay at POOL_WATER_Y (−0.35) because the swim rig, the splash spawn and the
 * head-bob are all calibrated to that plane. So the same four-terrace read is
 * built AROUND that fixed surface instead: the bank steps down to a wet-sand
 * shelf at −0.12, the water sits at −0.35, and the bed below it drops twice —
 * −0.75 under the shallows, −1.25 down the channel — which is where the depth
 * actually comes from, since you see the bed THROUGH the water.
 */
const RIVER_K = 0.38; // how tightly the centre line wanders — re-tunable
/** How far short of each wall the river stops (see riverMetrics). */
const RIVER_END_LIP = 0.35;
const RIVER_PHASE = 0.6;

/**
 * 📐 The river is a ROOM-SPANNING feature, so its length and width come from
 * the room, not from a constant. A 30 m channel authored for a 5×5 module
 * hangs out through the walls of a 2×2 one; the reference's own widths (water
 * 2.6, wet shelf 3.4) would leave a 12 m room with almost no bank.
 *
 * So: it reaches wall to wall, and the bands are a FRACTION of the room's
 * depth, clamped so it never stops looking like a river — five or six tiles
 * across in a big room, a stream in a small one, a bank on both sides either
 * way. All four consumers (the builder, the floor-hole cutter, the obstacle
 * strips and the swim test) read this one function, so what you see, what is
 * missing from the floor and what you cannot walk on stay one shape.
 */
function riverMetrics(): {
  halfLen: number;
  amp: number;
  wWet: number;
  wWater: number;
  wDeep: number;
} {
  const { halfX, halfZ } = roomHalfExtents();
  // Narrow: a stream you step over on a bridge, not a bay. ~1.6 m of water in
  // a 12 m room, 4 m in a 30 m one.
  const wWater = Math.min(2.0, Math.max(0.8, halfZ * 0.135));
  return {
    // Stops RIVER_END_LIP short of each wall — for EVERYTHING, not just the
    // floor cut. The platform has no skirt below floor level, so any terrace
    // that ran on to ±halfX poked out past the floor's edge, visible from
    // outside as a stack of teal steps; and a cut reaching the boundary is not
    // a hole to the triangulator (see poolHoleOutline). Both fixed by one
    // number; the lip reads as the bank meeting the wall, inside WALL_CLEARANCE.
    halfLen: halfX - RIVER_END_LIP,
    // A narrow band needs a visible wander or it reads as a straight ditch.
    amp: Math.min(1.8, Math.max(0.6, halfZ * 0.17)),
    wWet: wWater * 1.35,
    wWater,
    wDeep: wWater * 0.4,
  };
}
// SHALLOW on purpose (owner ruling 2026-09-21): the reference river is flat
// bands of colour with the thinnest of side faces — a beach, not a canyon.
// The water surface is pinned at POOL_WATER_Y (−0.35) for the swim rig, so
// the bank is a 0.35 m drop whatever we do; everything else stays close under
// it. Depth is read through the water as colour, not as walls.
const RIVER_Y_WET = -0.12; // a lip, not a step
const RIVER_Y_BED = -0.62; // bed under the shallows
const RIVER_Y_DEEP = -0.85; // bed down the channel
const RIVER_SEGS = 120;

/** The centre line, in the river item's LOCAL frame. Shared by the builder,
 *  the floor-hole cutter and the obstacle strips, so the water you see, the
 *  floor that is missing and the tiles you cannot walk on are one shape. */
function riverCentreZ(lx: number): number {
  return riverMetrics().amp * Math.sin(RIVER_K * lx + RIVER_PHASE);
}

/** Is a LOCAL point inside the river's water? Analytic — no polygon sampling,
 *  because the band has a constant half-width about a known centre line. */
function riverHasWaterAt(lx: number, lz: number): boolean {
  const { halfLen, wWater } = riverMetrics();
  return Math.abs(lx) <= halfLen && Math.abs(lz - riverCentreZ(lx)) <= wWater;
}

/**
 * Is a LOCAL point inside the EXCAVATION — the whole cut, wet shelf included?
 *
 * Wider than the water, and the distinction matters twice over: the floor hole
 * and the obstacle strips follow THIS (you cannot stand on a shelf 30 cm below
 * a floor the engine draws flat, and if the hole stopped at the waterline the
 * shelf would be buried under solid floor and never seen), while SWIMMING
 * follows the water — wading onto the bank is climbing out, not drowning.
 */
function riverHasCutAt(lx: number, lz: number): boolean {
  const { halfLen, wWet } = riverMetrics();
  return Math.abs(lx) <= halfLen && Math.abs(lz - riverCentreZ(lx)) <= wWet;
}

/**
 * A flat ribbon BAND following the centre line, from hwInner out to hwOuter on
 * BOTH sides — an annulus, not a plate.
 *
 * This distinction is the whole terracing. A full-width ribbon at the shelf
 * height is a lid: it spans the channel it is supposed to border, and every
 * deeper layer — the water, the bed, the channel — renders underneath it and
 * is never seen. Ask for the strip you mean.
 */
function riverRibbonBand(hwInner: number, hwOuter: number, y: number): THREE.BufferGeometry {
  const { halfLen } = riverMetrics();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RIVER_SEGS; i++) {
    const lx = -halfLen + (i / RIVER_SEGS) * halfLen * 2;
    const zc = riverCentreZ(lx);
    // Four vertices per station: outer-near, inner-near, inner-far, outer-far.
    pos.push(lx, y, zc - hwOuter, lx, y, zc - hwInner, lx, y, zc + hwInner, lx, y, zc + hwOuter);
  }
  for (let i = 0; i < RIVER_SEGS; i++) {
    const a = i * 4;
    const b = a + 4;
    idx.push(a, b, a + 1, a + 1, b, b + 1); // near strip
    idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3); // far strip
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat ribbon following the centre line — one mesh per terrace instead of
 *  a hundred little slabs. */
function riverRibbon(hw: number, y: number): THREE.BufferGeometry {
  const { halfLen } = riverMetrics();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RIVER_SEGS; i++) {
    const lx = -halfLen + (i / RIVER_SEGS) * halfLen * 2;
    const zc = riverCentreZ(lx);
    pos.push(lx, y, zc - hw, lx, y, zc + hw);
  }
  for (let i = 0; i < RIVER_SEGS; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The vertical face at one bank edge — THE depth cue. Without these the whole
 *  thing reads as a painted floor, which the checklist calls the single most
 *  common reason a beach room looks flat. */
function riverBankFace(hw: number, side: 1 | -1, yTop: number, yBot: number): THREE.BufferGeometry {
  const { halfLen } = riverMetrics();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RIVER_SEGS; i++) {
    const lx = -halfLen + (i / RIVER_SEGS) * halfLen * 2;
    const z = riverCentreZ(lx) + side * hw;
    pos.push(lx, yTop, z, lx, yBot, z);
  }
  for (let i = 0; i < RIVER_SEGS; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildBeachRiver(ctx: BuildCtx) {
  const { m, place } = ctx;
  const { halfLen, amp, wWet, wWater, wDeep } = riverMetrics();
  const SAND = 0xfbf7ee; // the reference's white beach sand
  const WET = 0xe4dac4; // …a shade darker where it is damp
  const BED = 0x7fd3df; // pale — the shallows read light through the water
  const BED_DEEP = 0x2f97ab; // the channel, one band darker
  const WATER = 0x5fc4d4;
  const FOAM = 0xeafaf9;
  const both = (mat: THREE.MeshStandardMaterial) => {
    mat.side = THREE.DoubleSide;
    return mat;
  };

  // ── 🏖️ The beach itself: a flat sand apron on the floor either side of the
  //    cut, so the room's tiles give way to sand before the water starts. It
  //    is what makes this a beach in a room rather than a trench in a floor.
  place(riverRibbonBand(wWet, wWet + 1.1, 0.006), both(m(SAND, 0.98, 0.0)), 0, 0, 0);

  // ── Terraces. Each is the STRIP between its own edge and the next one in,
  //    so nothing is a lid over the layer below it. Every step down also draws
  //    a vertical face, which is where the depth actually comes from.
  //
  //    0      ──┐ dry sand (the room's own floor)
  //    -0.30    └──┐ wet shelf .............. band  2.6 → 3.4
  //    -0.35       ~~ water surface ......... plate      ±2.6
  //    -1.05       └──┐ shallow bed ......... band  1.0 → 2.6
  //    -1.85          └── deep channel bed .. plate      ±1.0
  place(riverRibbonBand(wWater, wWet, RIVER_Y_WET), both(m(WET, 0.95, 0.0)), 0, 0, 0);
  place(riverBankFace(wWet, 1, 0, RIVER_Y_WET), both(m(WET, 0.95, 0.0)), 0, 0, 0);
  place(riverBankFace(wWet, -1, 0, RIVER_Y_WET), both(m(WET, 0.95, 0.0)), 0, 0, 0);

  place(riverRibbonBand(wDeep, wWater, RIVER_Y_BED), both(m(BED, 0.9, 0.02)), 0, 0, 0);
  // The face under the waterline is SAND-coloured: it is the bank continuing
  // down, and a teal wall there is what made the old cut read as a canyon.
  place(riverBankFace(wWater, 1, RIVER_Y_WET, RIVER_Y_BED), both(m(WET, 0.9, 0.02)), 0, 0, 0);
  place(riverBankFace(wWater, -1, RIVER_Y_WET, RIVER_Y_BED), both(m(WET, 0.9, 0.02)), 0, 0, 0);

  // The deep channel: one more terrace, and the biggest depth cue a river has.
  place(riverRibbon(wDeep, RIVER_Y_DEEP), both(m(BED_DEEP, 0.9, 0.02)), 0, 0, 0);
  place(riverBankFace(wDeep, 1, RIVER_Y_BED, RIVER_Y_DEEP), both(m(BED_DEEP, 0.9, 0.02)), 0, 0, 0);
  place(riverBankFace(wDeep, -1, RIVER_Y_BED, RIVER_Y_DEEP), both(m(BED_DEEP, 0.9, 0.02)), 0, 0, 0);

  // ── End caps. The cut stops short of the wall, so each end of the trench is
  //    an open cross-section — and the platform has no skirt below floor
  //    level, so from outside the room you looked straight into it: a stack
  //    of teal steps under the floor's edge. A wall closes each end — in the
  //    platform's own dark, so it reads as the underside of the room rather
  //    than as a pale block hung off its edge (a sand-coloured cap did).
  for (const side of [1, -1] as const) {
    const lx = side * halfLen;
    const zc = riverCentreZ(lx);
    const depth = -RIVER_Y_DEEP;
    place(
      new THREE.BoxGeometry(0.06, depth, wWet * 2),
      m(0x141a26, 0.95, 0.0),
      lx - side * 0.03,
      -depth / 2,
      zc,
    );
  }

  // ── The water surface itself, translucent over the bed ──
  const waterMat = both(m(WATER, 0.25, 0.1));
  translucent(waterMat, 0.62); // the bed's two bands must read through it
  place(riverRibbon(wWater, POOL_WATER_Y), waterMat, 0, 0, 0);

  // ── Foam where the water laps the bank, on BOTH banks ──
  for (const side of [1, -1] as const) {
    const foam = both(m(FOAM, 0.6, 0.0, FOAM, 0.35));
    translucent(foam, 0.8);
    const g = riverRibbon(wWater, POOL_WATER_Y + 0.008);
    // Squeeze the ribbon to a thin strip hugging one edge by moving every
    // inner vertex out to meet the outer one.
    const arr = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i <= RIVER_SEGS; i++) {
      const inner = side === 1 ? i * 2 : i * 2 + 1;
      const outer = side === 1 ? i * 2 + 1 : i * 2;
      const zOuter = arr.getZ(outer);
      arr.setZ(inner, zOuter - side * 0.22);
    }
    arr.needsUpdate = true;
    g.computeVertexNormals();
    place(g, foam, 0, 0, 0);
  }

  // ── 🌊 The current. The checklist is specific: animate it as a CURRENT —
  //    phase travelling downstream — not as a shimmer. Streaks drift along the
  //    channel, following the centre line, and recycle at the far bank.
  const STREAKS = 26;
  const streaks: THREE.Mesh[] = [];
  const streakX: number[] = [];
  const streakOff: number[] = [];
  const streakMat = both(m(FOAM, 0.4, 0.0, FOAM, 0.5));
  translucent(streakMat, 0.34);
  // A streak is 1.1 m long and is positioned by its CENTRE, so it must turn
  // round half a length before the river ends — recycled at halfLen, the last
  // streak ran 0.55 m past the cut and out through the platform's edge.
  const STREAK_LEN = 1.1;
  const streakEnd = halfLen - STREAK_LEN / 2;
  for (let i = 0; i < STREAKS; i++) {
    const mesh = place(new THREE.BoxGeometry(STREAK_LEN, 0.01, 0.075), streakMat, 0, POOL_WATER_Y + 0.014, 0);
    streaks.push(mesh);
    streakX.push(-streakEnd + (i / STREAKS) * streakEnd * 2);
    // Spread across the channel, denser toward the middle where a real current
    // runs fastest.
    streakOff.push((Math.random() * 2 - 1) ** 3 * wWater * 0.8);
  }
  const anim: PropAnimHandle = {
    update(dt: number) {
      for (let i = 0; i < STREAKS; i++) {
        // Mid-channel water moves faster than the edges.
        const speed = 1.15 - 0.5 * Math.abs(streakOff[i]) / wWater;
        streakX[i] += speed * dt;
        if (streakX[i] > streakEnd) streakX[i] -= streakEnd * 2;
        const lx = streakX[i];
        streaks[i].position.set(lx, POOL_WATER_Y + 0.014, riverCentreZ(lx) + streakOff[i]);
        // Bank the streak along the flow so it follows the bend.
        const slope = amp * RIVER_K * Math.cos(RIVER_K * lx + RIVER_PHASE);
        streaks[i].rotation.y = -Math.atan(slope);
      }
    },
  };
  streaks[0].userData.propAnim = anim;
}

/**
 * 🌉 Plank bridge — the way across, and the reason the far bank is worth
 * having. AXIS-ALIGNED on purpose: the pathfinder forbids corner-cutting, so a
 * diagonal bridge is a bridge nobody can walk. Its cells are cut OUT of the
 * river's floor hole and out of its obstacle strips, which is what makes it
 * walkable over water.
 */
const BRIDGE_W = 1.8;
/** Bridge length follows the RIVER (which follows the room): the excavation's
 *  full width at its widest bend, plus a 0.7 m landing on each bank. A fixed
 *  9 m span authored for a 5×5 module ran through the wall of a 2×2 one. */
function bridgeLen(): number {
  return bridgeLenFor(FURNITURE);
}
/** 🏊 Over the infinity pool the span is the pool's widest possible width —
 *  water plus its wet step plus one row of drift — with the same 0.7 m
 *  landings: a pier out to the edge. (Per item list so the tests' explicit
 *  lists work too.) */
function bridgeLenFor(all: FurnitureItem[]): number {
  if (all.some((i) => i.kind === "infinity-pool")) return infinityPoolMetrics().waterW + 2 + 1.4;
  const rm = riverMetrics();
  return 2 * (rm.wWet + rm.amp) + 1.4;
}

function buildPlankBridge({ m, place }: BuildCtx) {
  const BRIDGE_LEN = bridgeLen();
  const PLANKS = Math.max(8, Math.round(BRIDGE_LEN * 2));
  for (let i = 0; i < PLANKS; i++) {
    const z = -BRIDGE_LEN / 2 + (i + 0.5) * (BRIDGE_LEN / PLANKS);
    place(
      new THREE.BoxGeometry(BRIDGE_W, 0.09, BRIDGE_LEN / PLANKS - 0.04),
      m(i % 3 === 1 ? 0xa86f43 : 0xd9a46c, 0.92, 0.02),
      0,
      0.045,
      z,
    );
  }
  // Stringers under the planks, and pilings dropping to the bed — the bridge
  // has to LOOK like it is standing in water, not floating over a hole.
  for (const sx of [-BRIDGE_W / 2 + 0.12, BRIDGE_W / 2 - 0.12]) {
    place(new THREE.BoxGeometry(0.14, 0.14, BRIDGE_LEN), m(0x7f5230, 0.92, 0.02), sx, -0.04, 0);
    for (let i = 0; i < 5; i++) {
      const z = -BRIDGE_LEN / 2 + 0.6 + i * ((BRIDGE_LEN - 1.2) / 4);
      place(new THREE.CylinderGeometry(0.09, 0.09, 1.3, 7), m(0x7f5230, 0.95, 0.02), sx, -0.7, z);
    }
    // Rope handrail on posts.
    for (let i = 0; i < 5; i++) {
      const z = -BRIDGE_LEN / 2 + 0.6 + i * ((BRIDGE_LEN - 1.2) / 4);
      place(new THREE.BoxGeometry(0.09, 0.62, 0.09), m(0x8a5731, 0.92, 0.02), sx, 0.4, z);
    }
    place(new THREE.BoxGeometry(0.05, 0.05, BRIDGE_LEN - 1.0), m(0xd9a46c, 0.9, 0.02), sx, 0.68, 0);
  }
}

// ── 🌊 The beach SEA ────────────────────────────────────────────────────────
/**
 * The Habbo beach (owner reference: "How To Make a Habbo Beach", Aaron66734):
 * the room's floor IS sand, and the front corner of it is simply WATER — flat,
 * at floor level, blue, with a jagged staircase shoreline made of whole tiles.
 * No trench, no depth, no swimming: it is a floor pattern you cannot walk on,
 * and that is exactly why it looks right in a room where the river did not.
 *
 * Sized from the room like the river was. The water fills the WEST-SOUTH
 * corner: deepest along the west wall, running out to nothing about 40% of
 * the way along the south wall. Both wall CENTRES stay dry so the default
 * doors there keep a lane (the shoreline never comes within DOOR_KEEP of them).
 * Tiles are decided once per room by one pure function, so the geometry you
 * see and the tiles you cannot walk on are one shape.
 */
const SEA_DOOR_KEEP = 1.6; // metres round a door kept dry

/** World positions of the room's doors — the stored layout; the four
 *  defaults an UNSEEDED room renders (the doorDisplayName rule); and NONE
 *  for a room whose owner deliberately removed every door (the
 *  authoritative-empty marker — Copilot review, PR #169: those defaults
 *  were reserving phantom doorways). */
export function roomDoorPoints(): Array<{ x: number; z: number }> {
  const stored = readAllDoorLayout();
  const recs = stored.size > 0 ? stored : doorSetIsMarkedEmpty() ? new Map() : defaultDoorLayoutRecords();
  const out: Array<{ x: number; z: number }> = [];
  for (const r of recs.values()) {
    const pose = poseFromWall(r.wall, r.lateral);
    out.push({ x: pose.x, z: pose.z });
  }
  return out;
}

/**
 * Which FRONT corner the sea fills: the one farther from the room's doors. A
 * sea deepest against a wall that has a door in it would cut that door off
 * (its dry lane ends up an island), so with the usual single door on the west
 * wall the water goes south-EAST — the reference build mirrored, which reads
 * exactly the same. Ties go west, like the reference.
 */
export function seaCorner(): "SW" | "SE" {
  const { halfX, halfZ } = roomHalfExtents();
  const doors = roomDoorPoints();
  const clearance = (cx: number) =>
    Math.min(...doors.map((d) => Math.hypot(d.x - cx, d.z - halfZ)), Infinity);
  return clearance(halfX) > clearance(-halfX) + 0.01 ? "SE" : "SW";
}

/**
 * World tile indices [i, j] (tile = [i, i+1) × [j, j+1)) that are water.
 *
 * The reference build's sea: a TRIANGLE in a front corner — deepest against
 * the side wall, its straight diagonal shoreline running out along the front
 * about 75% of the way across. One tile deeper per column: in isometric that
 * pure diagonal IS the Habbo staircase (a random stagger was tried and only
 * made islands and spikes). Any tile within SEA_DOOR_KEEP of a real door
 * stays sand.
 */
export function seaWaterTiles(): Array<[number, number]> {
  const { halfX, halfZ } = roomHalfExtents();
  const cols = Math.round(halfX * 2);
  const rows = Math.round(halfZ * 2);
  const T = Math.min(rows - 1, Math.round(cols * 0.75)); // the diagonal's reach, in tiles
  const east = seaCorner() === "SE";
  const doors = roomDoorPoints();
  const nearDoor = (cx: number, cz: number) =>
    doors.some((d) => Math.hypot(d.x - cx, d.z - cz) < SEA_DOOR_KEEP);
  const out: Array<[number, number]> = [];
  for (let c = 0; c <= T; c++) {
    // c counts columns in from the sea's own wall.
    const i = east ? Math.round(halfX) - 1 - c : -Math.round(halfX) + c;
    const depth = Math.max(0, Math.min(rows - 1, T - c));
    for (let d = 0; d < depth; d++) {
      const j = Math.round(halfZ) - 1 - d;
      // A door's dry lane ends the COLUMN, not just the tile: skipping one
      // tile and continuing left the tiles behind it stranded as islands of
      // water with sand on every side.
      if (nearDoor(i + 0.5, j + 0.5)) break;
      out.push([i, j]);
    }
  }
  // ONE body of water: keep only the tiles connected (edge to edge) to the
  // corner tile. A door lane can cut the diagonal in two, and the tail beyond
  // it was a puddle on the far side of a dry strip — not a sea.
  const key = (i: number, j: number) => `${i},${j}`;
  const all = new Map(out.map(([i, j]) => [key(i, j), [i, j] as [number, number]]));
  const corner = key(east ? Math.round(halfX) - 1 : -Math.round(halfX), Math.round(halfZ) - 1);
  if (!all.has(corner)) return [];
  const seen = new Set<string>([corner]);
  const queue = [corner];
  while (queue.length) {
    const [ci, cj] = all.get(queue.pop()!)!;
    for (const [ni, nj] of [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]]) {
      const k = key(ni, nj);
      if (all.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return [...seen].map((k) => all.get(k)!);
}

/** The sea's blocked area: one box per horizontal RUN of water tiles. */
function seaObstacleBoxes(): Box[] {
  const rows = new Map<number, number[]>();
  for (const [i, j] of seaWaterTiles()) rows.set(j, [...(rows.get(j) ?? []), i]);
  const boxes: Box[] = [];
  for (const [j, is] of rows) {
    is.sort((a, b) => a - b);
    let start = is[0];
    let prev = is[0];
    for (let k = 1; k <= is.length; k++) {
      if (k < is.length && is[k] === prev + 1) { prev = is[k]; continue; }
      boxes.push({ x0: start - 0.01, z0: j - 0.01, x1: prev + 1.01, z1: j + 1.01 });
      if (k < is.length) { start = is[k]; prev = is[k]; }
    }
  }
  return boxes;
}

function buildBeachSea(ctx: BuildCtx) {
  const { m, place, itemId } = ctx;
  const tiles = seaWaterTiles();
  const set = new Set(tiles.map(([i, j]) => `${i},${j}`));
  // The item sits wherever the layout put it; the sea is a ROOM feature, so
  // subtract the item's own position to keep the tiles on the world grid.
  const item = FURNITURE.find((f) => f.id === itemId);
  const ox = item?.pos.x ?? 0;
  const oz = item?.pos.z ?? 0;

  // One flat mesh of tile quads, each its own shade — the pixel-noise the
  // Habbo water tiles have, without a texture.
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const SHADES = [[0.20, 0.55, 0.80], [0.24, 0.60, 0.85], [0.18, 0.52, 0.78], [0.27, 0.63, 0.88]];
  let v = 0;
  const quad = (x0: number, z0: number, x1: number, z1: number, y: number, c: number[]) => {
    pos.push(x0 - ox, y, z0 - oz, x1 - ox, y, z0 - oz, x1 - ox, y, z1 - oz, x0 - ox, y, z1 - oz);
    for (let k = 0; k < 4; k++) col.push(c[0], c[1], c[2]);
    idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    v += 4;
  };
  for (const [i, j] of tiles) {
    const shade = SHADES[(((i * 7 + j * 13) % 4) + 4) % 4];
    quad(i, j, i + 1, j + 1, 0.012, shade);
    // Foam: a pale rim on every edge that meets sand.
    const F = 0.16;
    const foam = [0.87, 0.95, 0.98];
    if (!set.has(`${i - 1},${j}`)) quad(i, j, i + F, j + 1, 0.016, foam);
    if (!set.has(`${i + 1},${j}`)) quad(i + 1 - F, j, i + 1, j + 1, 0.016, foam);
    if (!set.has(`${i},${j - 1}`)) quad(i, j, i + 1, j + F, 0.016, foam);
    if (!set.has(`${i},${j + 1}`)) quad(i, j + 1 - F, i + 1, j + 1, 0.016, foam);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = m(0xffffff, 0.35, 0.05);
  mat.vertexColors = true;
  mat.side = THREE.DoubleSide;
  place(g, mat, 0, 0, 0);
}

// ── 🏊 The infinity pool ─────────────────────────────────────────────────────
/**
 * A narrow pool along the FRONT EDGE of the room, built the way the party
 * skill's reference builds its water: out of whole tiles, every tile a flat
 * top at its own level with a vertical face wherever the neighbour is lower.
 * That staircase of faces is where the solidity comes from — a smooth ribbon
 * reads as a painted curve however it is terraced, a stepped one reads as a
 * place cut into a block.
 *
 * INFINITY: the pool has no far bank. Its far edge IS the platform's front
 * edge — the water runs past the floor's rim onto a spill shelf and a sheet
 * of it drops away into space below. The near edge is a wet-sand step down
 * (−0.16 m, the reference's wet level) to the water (−0.34 m), and that near
 * shoreline wanders by a tile across the room so it is a shore, not a rule.
 *
 * Narrow and WINDING on purpose (owner rulings 2026-09-25): one tile of
 * water widening to two at the bends in a 2×2 module, two-to-three in a 5×5,
 * the near shore zigzagging every two or three tiles (2¼ waves). The steps
 * are deeper than the reference's (wet −0.22, water −0.50) because with the
 * pool this narrow the step faces ARE the solidity. No deep channel — the
 * drop over the edge is the depth cue.
 *
 * Not a pool kind: you cannot swim in it (the reference's water is simply
 * unwalkable), so nothing pins its surface to the swim plane. It does cut the
 * floor — isFloorCutKind / floorCutOutlines — because the tiles are BELOW
 * floor level.
 *
 * A ROOM feature like beach-sea: the tiles are decided by one pure function
 * of the room (infinityPoolColumns), on the world grid, and the item's own
 * position is subtracted out, so the geometry, the floor hole and the blocked
 * tiles are one shape wherever the item is dropped. Doors keep a dry lane —
 * a door on the front wall gets a landing tile cut out of the pool.
 */
const IP_LIP = 0.35; // the cut stops this short of a WALL (a hole touching the floor's edge is no hole — see poolHoleOutline)
const IP_EDGE = 0.05; // …and this short of the open front edge: the same triangulator rule, but the water carries on over it
const IP_SPILL = 0.45; // how far the water shelf reaches past the platform edge
const IP_DROP = 1.0; // how far the spill sheet falls below it before it fades into the hull
const IP_DOOR_KEEP = 1.5; // metres round a door kept dry (a hair under the sea's 1.6: a wet step one tile off a door lane is not in it)
/** Tile top levels, metres below the floor — deeper than the reference's
 *  0.16 / 0.34 so a one-tile pool still shows tall faces. */
const IP_Y = { wet: -0.22, water: -0.5 } as const;
export type InfinityPoolLevel = keyof typeof IP_Y;

export interface InfinityPoolColumn {
  i: number;
  /** First and last row of the column that are pool (inclusive). */
  top: number;
  bot: number;
  /** First water row; rows above it (down to `top`) are the wet step. */
  w0: number;
}

/** Sizes, from the room. */
export function infinityPoolMetrics(): {
  cx: number;
  cz: number;
  cols: number;
  rows: number;
  waterW: number;
  amp: number;
  zBase: number;
} {
  const { halfX, halfZ } = roomHalfExtents();
  const cx = Math.round(halfX);
  const cz = Math.round(halfZ);
  const cols = 2 * cx;
  const rows = 2 * cz;
  const waterW = rows >= 24 ? 2 : 1; // rows of water at the narrowest
  const amp = 0.5; // the near shore steps in and out by one tile
  // The near edge, continuous: at +amp the water is exactly waterW rows.
  const zBase = cz - waterW - amp;
  return { cx, cz, cols, rows, waterW, amp, zBase };
}

/** The continuous NEAR-EDGE line, world z for a world x. Nearest the edge
 *  (narrowest) at the west wall, then in and out across the room — 2¼ waves,
 *  so the rounded shore changes row every two or three tiles. */
export function infinityPoolEdgeZ(x: number): number {
  const mt = infinityPoolMetrics();
  const t = (x + mt.cx) / mt.cols;
  return mt.zBase + mt.amp * Math.cos(4.5 * Math.PI * t);
}

/**
 * The pool, one column per tile of the room's width, every column running
 * from its wet step to the front edge. Rows are the near-edge line rounded to
 * the grid, so neighbouring columns step by whole tiles — the Habbo
 * staircase. A door's dry lane trims a column from the end nearer the door
 * (never out of its middle), and a column trimmed to nothing is simply
 * absent, so a run of columns is always one connected body of water.
 */
export function infinityPoolColumns(): InfinityPoolColumn[] {
  const mt = infinityPoolMetrics();
  const doors = roomDoorPoints();
  const out: InfinityPoolColumn[] = [];
  for (let i = -mt.cx; i < mt.cx; i++) {
    const w0 = Math.round(infinityPoolEdgeZ(i + 0.5));
    let top = Math.max(-mt.cz, w0 - 1);
    let bot = mt.cz - 1;
    const nearDoor = (j: number) =>
      doors.some((d) => Math.hypot(d.x - (i + 0.5), d.z - (j + 0.5)) < IP_DOOR_KEEP);
    // Keep cutting from whichever end is nearer the offending tile until the
    // column is clean — a door disc can only ever bite one contiguous chunk.
    for (;;) {
      let hit = -1;
      for (let j = top; j <= bot; j++) if (nearDoor(j)) { hit = j; break; }
      if (hit < 0) break;
      if (hit - top <= bot - hit) top = hit + 1;
      else bot = hit - 1;
    }
    // A door landing can eat a one-row column's only water; a wet step with
    // nothing below it is not pool, so the column goes (the pool continues
    // either side of the door).
    if (top > bot || bot < w0) continue;
    out.push({ i, top, bot, w0 });
  }
  return out;
}

export function infinityPoolLevel(c: InfinityPoolColumn, j: number): InfinityPoolLevel {
  return j < c.w0 ? "wet" : "water";
}

/** A tile's world rectangle — a whole tile, except that tiles against a wall
 *  stop IP_LIP short of it and tiles on the front edge stop IP_EDGE short. */
function infinityPoolRect(i: number, j: number): Box {
  const { cx, cz } = infinityPoolMetrics();
  return {
    x0: i === -cx ? i + IP_LIP : i,
    x1: i === cx - 1 ? i + 1 - IP_LIP : i + 1,
    z0: j === -cz ? j + IP_LIP : j,
    z1: j === cz - 1 ? j + 1 - IP_EDGE : j + 1,
  };
}

/** Every pool tile, keyed "i,j". */
export function infinityPoolTiles(): Map<string, { i: number; j: number; level: InfinityPoolLevel }> {
  const tiles = new Map<string, { i: number; j: number; level: InfinityPoolLevel }>();
  for (const c of infinityPoolColumns()) {
    for (let j = c.top; j <= c.bot; j++) tiles.set(`${c.i},${j}`, { i: c.i, j, level: infinityPoolLevel(c, j) });
  }
  return tiles;
}

/**
 * The floor hole(s): one rectilinear polygon per run of consecutive columns,
 * down the near bank and back along the far one. Strictly inside the floor's
 * outer ring (infinityPoolRect's lip), which the triangulator requires.
 */
export function infinityPoolOutlines(): Array<Array<{ x: number; z: number }>> {
  const polys: Array<Array<{ x: number; z: number }>> = [];
  let run: InfinityPoolColumn[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const near: Array<{ x: number; z: number }> = [];
    const far: Array<{ x: number; z: number }> = [];
    for (const c of run) {
      const rt = infinityPoolRect(c.i, c.top);
      const rb = infinityPoolRect(c.i, c.bot);
      near.push({ x: rt.x0, z: rt.z0 }, { x: rt.x1, z: rt.z0 });
      far.push({ x: rb.x0, z: rb.z1 }, { x: rb.x1, z: rb.z1 });
    }
    const ring = [...near, ...far.reverse()];
    // Drop consecutive duplicates (adjacent columns at the same row share a point).
    const poly = ring.filter((p, k) => k === 0 || p.x !== ring[k - 1].x || p.z !== ring[k - 1].z);
    polys.push(poly);
    run = [];
  };
  for (const c of infinityPoolColumns()) {
    if (run.length > 0 && c.i !== run[run.length - 1].i + 1) flush();
    run.push(c);
  }
  flush();
  return polys;
}

/** A plank bridge's world AABB (bridges are cardinal, so it is one). */
function bridgeWorldBox(bridge: FurnitureItem, len: number): Box {
  const c = rotXZ(BRIDGE_W / 2, len / 2, bridge.rot);
  return {
    x0: bridge.pos.x - Math.abs(c.x),
    z0: bridge.pos.z - Math.abs(c.z),
    x1: bridge.pos.x + Math.abs(c.x),
    z1: bridge.pos.z + Math.abs(c.z),
  };
}

/**
 * The tile river's blocked area: one box per column (water AND wet shelf —
 * the shelf is 16 cm below a floor the engine walks flat), cut by any plank
 * bridge crossing it. Same split-then-subtract as riverObstacleBoxes, on
 * world tiles instead of local strips.
 */
function infinityPoolObstacleBoxes(all: FurnitureItem[]): Box[] {
  const boxes: Box[] = [];
  const len = bridgeLenFor(all);
  const bridges = all.filter((b) => b.kind === "plank-bridge").map((b) => bridgeWorldBox(b, len));
  const SEAM = 0.01;
  for (const c of infinityPoolColumns()) {
    const rt = infinityPoolRect(c.i, c.top);
    const rb = infinityPoolRect(c.i, c.bot);
    const cx0 = rt.x0;
    const cx1 = rt.x1;
    const xEdges = new Set<number>([cx0, cx1]);
    for (const b of bridges) {
      if (b.x0 > cx0 && b.x0 < cx1) xEdges.add(b.x0);
      if (b.x1 > cx0 && b.x1 < cx1) xEdges.add(b.x1);
    }
    const xs = [...xEdges].sort((a, b) => a - b);
    for (let k = 0; k < xs.length - 1; k++) {
      const sx0 = xs[k];
      const sx1 = xs[k + 1];
      if (sx1 - sx0 < 1e-6) continue;
      const mid = (sx0 + sx1) / 2;
      const spans = [{ z0: rt.z0, z1: rb.z1 }];
      for (const b of bridges) {
        if (mid <= b.x0 || mid >= b.x1) continue;
        for (let s = spans.length - 1; s >= 0; s--) {
          const sp = spans[s];
          if (b.z1 <= sp.z0 || b.z0 >= sp.z1) continue;
          spans.splice(s, 1);
          if (b.z0 > sp.z0) spans.push({ z0: sp.z0, z1: b.z0 });
          if (b.z1 < sp.z1) spans.push({ z0: b.z1, z1: sp.z1 });
        }
      }
      for (const sp of spans) {
        if (sp.z1 - sp.z0 < 0.05) continue;
        boxes.push({ x0: sx0 - SEAM, z0: sp.z0 - SEAM, x1: sx1 + SEAM, z1: sp.z1 + SEAM });
      }
    }
  }
  return boxes;
}

function buildInfinityPool(ctx: BuildCtx) {
  const { m, place, itemId } = ctx;
  const item = FURNITURE.find((f) => f.id === itemId);
  const ox = item?.pos.x ?? 0;
  const oz = item?.pos.z ?? 0;
  const mt = infinityPoolMetrics();
  const tiles = infinityPoolTiles();

  // The reference palette: its WATER, and its white-sand tones for the bank
  // faces and the wet step (the room's beach floor is that same #fbf7ee —
  // world.ts makeSandFloorTex). Wet sand is darker than dry, and a bank face
  // is the floor in shadow. [top, ±x, ±z].
  const SAND_FACE = [0xebe3d2, 0xd4c9b2];
  const WET = [0xe4dac4, 0xd6cbb3, 0xbcae94];
  const WATER_FACE = [0x2b8fa2, 0x21707f];
  const SPILL = [0x2b8fa2, 0x141a26]; // the falling sheet: water at the lip, fading into the platform's own dark
  const CAP = 0x141a26; // the platform's own dark, where the cut meets a wall

  type Buf = { pos: number[]; col: number[]; idx: number[]; v: number };
  const terrain: Buf = { pos: [], col: [], idx: [], v: 0 };
  const water: Buf = { pos: [], col: [], idx: [], v: 0 };
  const tmp = new THREE.Color();
  const quad = (
    b: Buf,
    p: [number, number, number, number, number, number, number, number, number, number, number, number],
    color: number,
  ): number => {
    const start = b.v;
    for (let k = 0; k < 12; k += 3) b.pos.push(p[k] - ox, p[k + 1], p[k + 2] - oz);
    tmp.setHex(color);
    for (let k = 0; k < 4; k++) b.col.push(tmp.r, tmp.g, tmp.b);
    b.idx.push(start, start + 2, start + 1, start, start + 3, start + 2);
    b.v += 4;
    return start;
  };
  const top = (b: Buf, r: Box, y: number, color: number) =>
    quad(b, [r.x0, y, r.z0, r.x1, y, r.z0, r.x1, y, r.z1, r.x0, y, r.z1], color);
  // A vertical face along one edge of a tile, from yTop down to yBot.
  const face = (b: Buf, r: Box, side: "x0" | "x1" | "z0" | "z1", yTop: number, yBot: number, color: number) => {
    if (side === "x0" || side === "x1") {
      const x = r[side];
      quad(b, [x, yTop, r.z0, x, yTop, r.z1, x, yBot, r.z1, x, yBot, r.z0], color);
    } else {
      const z = r[side];
      quad(b, [r.x0, yTop, z, r.x1, yTop, z, r.x1, yBot, z, r.x0, yBot, z], color);
    }
  };

  // Water tops are repainted every frame (the travelling light bands and the
  // foam wash), so remember where each one's four vertices start.
  const live: Array<{ start: number; i: number; j: number; foam: boolean }> = [];
  const DIRS: Array<[number, number, "x0" | "x1" | "z0" | "z1"]> = [
    [1, 0, "x1"],
    [-1, 0, "x0"],
    [0, 1, "z1"],
    [0, -1, "z0"],
  ];
  for (const t of tiles.values()) {
    const r = infinityPoolRect(t.i, t.j);
    const y = IP_Y[t.level];
    const isWater = t.level === "water";
    const buf = isWater ? water : terrain;
    // 🌊 On the front edge the water does not stop at the cut: its top runs
    // on over the floor's rim and past the platform edge — the infinity lip.
    const onEdge = isWater && t.j === mt.cz - 1;
    const rTop = onEdge ? { ...r, z1: mt.cz + IP_SPILL } : r;
    const start = top(buf, rTop, y, isWater ? 0x3fb3c6 : WET[0]);
    let foam = false;
    for (const [di, dj, side] of DIRS) {
      const n = tiles.get(`${t.i + di},${t.j + dj}`);
      const alongX = side === "x0" || side === "x1";
      if (!n) {
        const pastFront = t.j + dj >= mt.cz;
        if (pastFront && isWater) {
          // The sheet falling off the shelf's outer edge, into space.
          const zs = mt.cz + IP_SPILL;
          const mid = y - IP_DROP * 0.35;
          quad(water, [r.x0, y, zs, r.x1, y, zs, r.x1, mid, zs, r.x0, mid, zs], SPILL[0]);
          quad(water, [r.x0, mid, zs, r.x1, mid, zs, r.x1, y - IP_DROP, zs, r.x0, y - IP_DROP, zs], SPILL[1]);
          foam = true;
          continue;
        }
        const outside =
          t.i + di < -mt.cx || t.i + di >= mt.cx || t.j + dj < -mt.cz || pastFront;
        // Sand at floor level next door: the bank's own face, down to this
        // tile. At a wall it is the cut's end, closed in the platform's dark.
        face(terrain, r, side, 0, y, outside ? CAP : SAND_FACE[alongX ? 0 : 1]);
        if (isWater) foam = true;
        continue;
      }
      const ny = IP_Y[n.level];
      if (ny < y) {
        // The neighbour is a step down: this tile's face, in its own colour.
        const cols = t.level === "wet" ? [WET[1], WET[2]] : WATER_FACE;
        face(buf, r, side, y, ny, cols[alongX ? 0 : 1]);
      } else if (n.level === "wet" && isWater) {
        foam = true;
      }
    }
    // The shelf's own end faces where the edge row stops (a door landing, a wall).
    if (onEdge) {
      for (const [di, side] of [[1, "x1"], [-1, "x0"]] as const) {
        const n = tiles.get(`${t.i + di},${t.j}`);
        if (!n || n.level !== "water") {
          const x = r[side];
          quad(water, [x, y, mt.cz - IP_EDGE, x, y, mt.cz + IP_SPILL, x, y - 0.12, mt.cz + IP_SPILL, x, y - 0.12, mt.cz - IP_EDGE], WATER_FACE[0]);
        }
      }
    }
    if (isWater) live.push({ start, i: t.i, j: t.j, foam });
  }

  const mesh = (b: Buf, mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial): THREE.Mesh => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
    g.setIndex(b.idx);
    g.computeVertexNormals();
    mat.vertexColors = true;
    mat.side = THREE.DoubleSide;
    return place(g, mat, 0, 0, 0);
  };
  // The sand is lit like the floor it belongs to. The WATER is unlit: the
  // reference's tiles are flat fills whose faces are pre-shaded (a darker
  // colour per face, not a light), and under the room's sun a lit teal
  // washed out to sky-white.
  mesh(terrain, m(0xffffff, 0.95, 0.0));
  const waterFlat = ctx.flat(0xffffff);
  waterFlat.toneMapped = false; // the reference's exact fills, not the scene's curve
  const waterMesh = mesh(water, waterFlat);
  const waterCol = waterMesh.geometry.getAttribute("color") as THREE.BufferAttribute;

  // ── 🌊 The current: short pale streaks drifting downstream (east → west)
  //    along the centre line, each riding the surface of the tile under it.
  const STREAK_LEN = 0.7;
  const streakMat = m(0xffffff, 0.4, 0.0, 0xffffff, 0.4);
  streakMat.transparent = true;
  streakMat.opacity = 0.34;
  streakMat.userData.baseOpacity = 0.34;
  const xMin = -mt.cx + IP_LIP + STREAK_LEN / 2;
  const xMax = mt.cx - IP_LIP - STREAK_LEN / 2;
  const count = mt.cols * 2;
  const streaks: THREE.Mesh[] = [];
  const sx: number[] = [];
  const sOff: number[] = [];
  const offMax = Math.max(0.1, mt.waterW / 2 - 0.55);
  for (let k = 0; k < count; k++) {
    streaks.push(place(new THREE.BoxGeometry(STREAK_LEN, 0.008, 0.06), streakMat, 0, IP_Y.water, 0));
    sx.push(xMin + (k / count) * (xMax - xMin));
    sOff.push((Math.random() * 2 - 1) * offMax);
  }

  let time = 0;
  const anim: PropAnimHandle = {
    update(dt: number) {
      time += dt;
      // Light bands travelling downstream: phase advances along x, the
      // stream's axis (the reference's x−y), and every tile keeps its own
      // pixel-noise offset. Bank tiles get the foam wash pulsing over them.
      for (const w of live) {
        const k = Math.sin(w.i * 0.8 + w.j * 0.3 + time / 0.52) * 0.5 + 0.5;
        const noise = ((w.i * 7 + w.j * 13) % 4) * 0.008;
        const l = 0.34 + (10 + k * 16) * 0.005;
        // Foam: the reference lays a 34 % ± 20 % white wash over bank tiles.
        // Done as sRGB LIGHTNESS, not a lerp of the stored linear colour —
        // that lerp is perceptually huge and turned the whole river sky-white.
        const foam = w.foam ? 0.07 + Math.sin(time / 0.62 + w.i * 0.5) * 0.04 : 0;
        // The reference's hsl() is an sRGB colour; say so, or setHSL writes
        // it as linear and the output conversion lifts the whole river to sky.
        tmp.setHSL(188 / 360, 0.52, l + noise + foam, THREE.SRGBColorSpace);
        for (let v = 0; v < 4; v++) waterCol.setXYZ(w.start + v, tmp.r, tmp.g, tmp.b);
      }
      waterCol.needsUpdate = true;

      for (let k = 0; k < count; k++) {
        // Mid-stream runs faster than the edges.
        const speed = 0.75 - 0.3 * (Math.abs(sOff[k]) / Math.max(offMax, 0.1));
        sx[k] -= speed * dt;
        if (sx[k] < xMin) sx[k] += xMax - xMin;
        const x = sx[k];
        // Down the middle of the water: between the near edge and the front.
        const z = (infinityPoolEdgeZ(x) + mt.cz) / 2 + sOff[k];
        const under = tiles.get(`${Math.floor(x)},${Math.floor(z)}`);
        const s = streaks[k];
        if (!under || under.level === "wet") {
          s.visible = false;
          continue;
        }
        s.visible = true;
        s.position.set(x - ox, IP_Y.water + 0.012, z - oz);
        const slope = -mt.amp * ((2.5 * Math.PI) / mt.cols) * Math.sin((2.5 * Math.PI * (x + mt.cx)) / mt.cols);
        s.rotation.y = -Math.atan(slope);
      }
    },
  };
  waterMesh.userData.propAnim = anim;
}

/**
 * 🌹 Tall yellow climbing rose — a wall decoration (owner request 2026-09-25,
 * reference: yellow jessamine cascading off a pergola).
 *
 * Wall-mounted in the terminal's frame: the item's origin sits on the wall's
 * flush-mount plane and local +z faces into the room, so everything here is
 * built in z ≥ 0 and the wall is at the back. A wooden beam runs along the
 * wall near the top; canes climb it from the foot, and from it a curtain of
 * trailing strands drapes down, each hung with small five-petal yellow
 * blossoms and dense leaves — the mass the reference has, not a sparse
 * trellis. 1 m wide, 4.7 m tall against a 4 m wall — its crest spills over the top. Leaves, petals and flower
 * centres are one InstancedMesh (≈2 000 instances, one draw call); the
 * layout is seeded from the item id, so a row of these differs plant to
 * plant but agrees on every client.
 */
function buildClimbingRose(ctx: BuildCtx) {
  const { m, place, attach, itemId } = ctx;
  const H = 4.7; // taller than the 4 m wall (owner ruling 2026-09-25): the beam sits on the wall's top and the crest spills over it
  const W = 1.0;
  const WOOD = 0x8a6a45;
  const CANE = 0x4a7a3e;
  const CANE_D = 0x35602e;
  const LEAF = [0x3e8e4c, 0x54b062, 0x2f7a3e, 0x6cc070] as const;
  const PETAL = [0xffd400, 0xffe14a, 0xffc61a, 0xfff08a] as const;
  const CENTRE = 0xc98a12;
  let seed = idHash01(itemId) * 1000;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const Z0 = 0.05;

  // ── The beam the climber has taken over, and a pair of brackets.
  const BEAM_Y = 4.05; // resting on the wall top
  place(new THREE.BoxGeometry(W + 0.1, 0.09, 0.14), m(WOOD, 0.9, 0.05), 0, BEAM_Y, Z0 + 0.07);
  for (const x of [-W / 2 + 0.06, W / 2 - 0.06]) {
    place(new THREE.BoxGeometry(0.05, 0.05, 0.16), m(WOOD, 0.9, 0.05), x, BEAM_Y - 0.07, Z0 + 0.08);
  }

  // ── Wood: polylines drawn as short cylinders; every node remembered so the
  //    foliage sits on the stems. Canes climb from the foot to the beam;
  //    strands hang from the beam and sway a little as they fall.
  type Pt = { x: number; y: number; z: number };
  const nodes: Array<Pt & { hang: boolean }> = [];
  const stem = (pts: Pt[], r: number, hang: boolean) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      const seg = place(
        new THREE.CylinderGeometry(r * 0.9, r, len + 0.01, 5),
        m(i % 3 === 2 ? CANE_D : CANE, 0.85, 0.0),
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        (a.z + b.z) / 2,
      );
      // Orient the cylinder's +y along the segment.
      seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
      nodes.push({ ...b, hang });
    }
  };
  // Three climbing canes, wandering up to the beam.
  for (const [x0, drift] of [[-0.32, 0.12], [0.02, -0.04], [0.3, -0.14]] as const) {
    const pts: Pt[] = [{ x: x0, y: 0.02, z: Z0 + 0.05 }];
    let x: number = x0;
    let dir = Math.PI / 2 + drift;
    for (let y = 0.02; y < BEAM_Y - 0.1; ) {
      dir += (rnd() - 0.5) * 0.5 + (Math.abs(x) > W / 2 - 0.1 ? (x > 0 ? 0.3 : -0.3) : 0);
      x = Math.max(-W / 2 + 0.05, Math.min(W / 2 - 0.05, x + Math.cos(dir) * 0.24));
      y += Math.max(0.1, Math.sin(dir) * 0.24);
      pts.push({ x, y, z: Z0 + 0.05 + (rnd() - 0.5) * 0.03 });
    }
    stem(pts, 0.022, false);
  }
  // The curtain: strands from along the beam, hanging to varying depths and
  // swinging out from the wall a little — the longest in the middle.
  const STRANDS = 16;
  for (let k = 0; k < STRANDS; k++) {
    const x0 = -W / 2 + 0.05 + (k + 0.5) * ((W - 0.1) / STRANDS) + (rnd() - 0.5) * 0.04;
    const mid = 1 - Math.abs((k + 0.5) / STRANDS - 0.5) * 2; // 1 in the middle, 0 at the ends
    const len = 0.7 + mid * 1.2 + rnd() * 0.7;
    const pts: Pt[] = [{ x: x0, y: BEAM_Y - 0.03, z: Z0 + 0.1 }];
    const sway = (rnd() - 0.5) * 0.35;
    const out = 0.12 + rnd() * 0.2;
    const n = Math.max(3, Math.round(len / 0.2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      pts.push({
        x: x0 + Math.sin(t * Math.PI) * sway + (rnd() - 0.5) * 0.03,
        y: BEAM_Y - 0.03 - t * len,
        z: Z0 + 0.1 + Math.sin(t * Math.PI * 0.5) * out,
      });
    }
    stem(pts, 0.012, true);
  }

  // ── Leaves and blossoms, as instances.
  type Inst = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3; c: number };
  const inst: Inst[] = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const put = (p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, c: number) => inst.push({ p, q, s, c });
  const leaf = (at: Pt, size: number, hang: boolean) => {
    // Lance-shaped, pointing away from the stem; hanging strands' leaves droop.
    const a = hang ? Math.PI + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rnd() - 0.5) * 0.9));
    const off = new THREE.Vector3(0, size * 0.7, 0).applyQuaternion(q);
    put(new THREE.Vector3(at.x, at.y, at.z + 0.015).add(off), q, new THREE.Vector3(size * 0.3, size * 0.7, size * 0.07), LEAF[Math.floor(rnd() * LEAF.length)]);
  };
  const blossom = (at: Pt, r: number, colour: number) => {
    // Small, flat, five-petalled, facing out into the room with a tilt.
    const n = new THREE.Vector3((rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8 - 0.1, 1).normalize();
    const qN = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const centre = new THREE.Vector3(at.x, at.y, at.z + r * 0.3);
    const phase = rnd() * Math.PI * 2;
    for (let k = 0; k < 5; k++) {
      const a = phase + (k / 5) * Math.PI * 2;
      const q = qN.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, -a))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.3));
      const off = new THREE.Vector3(Math.cos(a) * r * 0.5, r * 0.06, Math.sin(a) * r * 0.5).applyQuaternion(qN);
      put(centre.clone().add(off), q, new THREE.Vector3(r * 0.58, r * 0.12, r * 0.4), colour);
    }
    put(centre.clone().add(n.clone().multiplyScalar(r * 0.1)), qN, new THREE.Vector3(r * 0.2, r * 0.14, r * 0.2), CENTRE);
  };
  for (const nd of nodes) {
    const leaves = nd.hang ? 3 : 2;
    for (let k = 0; k < leaves; k++) {
      leaf({ x: nd.x + (rnd() - 0.5) * 0.06, y: nd.y + (rnd() - 0.5) * 0.12, z: nd.z }, 0.09 + rnd() * 0.04, nd.hang);
    }
    // Blossoms: thick along the hanging strands, a few on the climbing canes.
    const count = nd.hang ? (rnd() < 0.75 ? 2 : 1) : (rnd() < 0.3 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      blossom({ x: nd.x + (rnd() - 0.5) * 0.1, y: nd.y + (rnd() - 0.5) * 0.14, z: nd.z + rnd() * 0.03 }, 0.032 + rnd() * 0.018, PETAL[Math.floor(rnd() * PETAL.length)]);
    }
  }
  // The crest: foliage and bloom heaped over the beam and the wall's top,
  // up to H — the plant has grown over the wall, not stopped at it.
  for (let k = 0; k < 110; k++) {
    const t = rnd();
    const at = { x: (rnd() - 0.5) * (W + 0.2), y: BEAM_Y + 0.05 + t * (H - BEAM_Y - 0.1), z: Z0 - 0.1 + rnd() * 0.32 };
    leaf(at, 0.1 + rnd() * 0.05, false);
    if (rnd() < 0.55) blossom(at, 0.035 + rnd() * 0.018, PETAL[k % PETAL.length]);
  }

  const geo = new THREE.SphereGeometry(1, 7, 5);
  const mat = m(0xffffff, 0.8, 0.0);
  const mesh = new THREE.InstancedMesh(geo, mat, inst.length);
  const mtx = new THREE.Matrix4();
  const col = new THREE.Color();
  inst.forEach((it, i) => {
    mtx.compose(it.p, it.q, it.s);
    mesh.setMatrixAt(i, mtx);
    mesh.setColorAt(i, col.setHex(it.c));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = "roseFoliage";
  attach(mesh);
}

/**
 * 🏝️ Thatched tiki parasol with a string of party bulbs round the brim — the
 * parasol the reference build uses at every corner. 1×1, 2.4 m.
 */
function buildTikiParasol({ m, place }: BuildCtx) {
  const THATCH = 0xb9924a;
  const THATCH_D = 0x8f6b30;
  place(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 8), m(0x6d4d31, 0.9, 0.05), 0, 1.1, 0);
  place(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 10), m(0x6d4d31, 0.9, 0.05), 0, 0.04, 0);
  // Two stacked straw cones, the lower ragged at the hem.
  place(new THREE.ConeGeometry(1.05, 0.55, 12), m(THATCH, 0.95, 0.0), 0, 2.02, 0);
  place(new THREE.ConeGeometry(0.62, 0.42, 12), m(THATCH_D, 0.95, 0.0), 0, 2.36, 0);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    place(new THREE.BoxGeometry(0.16, 0.14, 0.05), m(i % 2 ? THATCH : THATCH_D, 0.95, 0.0), Math.cos(a) * 1.0, 1.72, Math.sin(a) * 1.0).rotation.y = -a;
  }
  // The bulbs: alternating green / yellow / pink round the brim, each lit.
  const BULB = [0x7cff5a, 0xffe14a, 0xff7ad9] as const;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const c = BULB[i % 3];
    place(new THREE.SphereGeometry(0.045, 7, 7), m(c, 0.3, 0.0, c, 1.6), Math.cos(a) * 1.02, 1.64, Math.sin(a) * 1.02);
  }
}

/**
 * 🌿 Jungle plant — the reference build's hedge plant: a TALL, DENSE mass of
 * dark tropical foliage. In the video it reads as one solid dark-green shape
 * with a ragged, frond-tipped outline — never as stems and separate blades
 * (a spiky, see-through version was tried and looked like agave). So this is
 * built as VOLUME first: three tiers of overlapping leaf pads make a solid
 * silhouette, and only then do fronds fan out of the crown for the ragged
 * top. 1×1, 5.4 m (owner spec), a per-instance twist so a row is not clones.
 */
function buildJunglePlant({ m, place, itemId }: BuildCtx) {
  const H = 5.4;
  const DARK = 0x184a2b; // the mass
  const MID = 0x1f5e33; // pads catching light
  const LIGHT = 0x2a7040; // frond tips
  const twist = idHash01(itemId) * Math.PI * 2;

  // A short dark base so the mass sits on the ground rather than floating.
  place(new THREE.CylinderGeometry(0.22, 0.3, 0.9, 8), m(0x2b3d1f, 0.95, 0.0), 0, 0.45, 0);

  // ── The mass: tiers of squashed spheres, each tier a ring of pads round a
  //    core, tiers wider toward the middle and narrower at the top — the
  //    bushy pear silhouette the reference has.
  const tiers: Array<[number, number, number]> = [
    // [height, ring radius, pad radius]
    [1.5, 0.42, 0.62],
    [2.5, 0.5, 0.66],
    [3.5, 0.46, 0.62],
    [4.4, 0.34, 0.54],
    [5.0, 0.18, 0.42],
  ];
  tiers.forEach(([y, ring, r], t) => {
    const n = t === tiers.length - 1 ? 4 : 6;
    const core = place(new THREE.SphereGeometry(r * 1.05, 9, 7), m(DARK, 0.95, 0.0), 0, y, 0);
    core.scale.set(1, 0.7, 1);
    for (let i = 0; i < n; i++) {
      const a = twist + t * 0.5 + (i / n) * Math.PI * 2;
      const pad = place(
        new THREE.SphereGeometry(r, 8, 6),
        m(i % 2 ? DARK : MID, 0.95, 0.0),
        Math.cos(a) * ring,
        y + (i % 2 ? -0.08 : 0.08),
        Math.sin(a) * ring,
      );
      pad.scale.set(1, 0.62, 1);
    }
  });

  // ── The ragged outline: wide fronds fanning out of every tier's rim, up and
  //    outward, longest at the crown — this is what stops the mass reading as
  //    a topiary ball.
  const frond = (y: number, ring: number, len: number, tilt: number, count: number, phase: number) => {
    for (let i = 0; i < count; i++) {
      const a = twist + phase + (i / count) * Math.PI * 2;
      const f = place(
        new THREE.ConeGeometry(0.26, len, 4),
        m(i % 3 === 0 ? LIGHT : MID, 0.9, 0.0),
        Math.cos(a) * (ring + Math.sin(tilt) * len * 0.45),
        y + Math.cos(tilt) * len * 0.45,
        Math.sin(a) * (ring + Math.sin(tilt) * len * 0.45),
      );
      f.rotation.order = "YXZ";
      f.rotation.y = -a;
      f.rotation.z = -tilt;
      f.scale.set(1, 1, 0.18); // a wide flat blade
    }
  };
  frond(2.2, 0.9, 1.5, 1.25, 7, 0.2); // low skirt, hanging outward
  frond(3.4, 0.9, 1.6, 0.95, 8, 0.6);
  frond(4.4, 0.75, 1.7, 0.6, 8, 1.0);
  frond(H - 0.4, 0.45, 1.6, 0.28, 7, 1.4); // crown, reaching up: the H tips
}

/** 🛶 Inflatable raft — yellow, non-solid, meant to sit ON the water. */
function buildBeachRaft({ m, place }: BuildCtx) {
  const RUB = 0xf2c94c;
  const RUB_D = 0xd9a92e;
  const ring = place(new THREE.TorusGeometry(0.62, 0.2, 8, 18), m(RUB, 0.6, 0.02), 0, 0.2, 0);
  ring.scale.set(1, 1, 0.72);
  ring.rotation.x = Math.PI / 2;
  place(new THREE.BoxGeometry(0.95, 0.06, 0.62), m(RUB_D, 0.7, 0.02), 0, 0.1, 0);
  for (const sx of [-0.55, 0.55]) {
    const oar = place(new THREE.BoxGeometry(1.1, 0.04, 0.05), m(0x8a5731, 0.9, 0.02), sx, 0.42, 0.28);
    oar.rotation.z = sx < 0 ? 0.35 : -0.35;
    oar.rotation.y = 0.5;
  }
}

// ── 🏝️ Beach fixtures ───────────────────────────────────────────────────────
// A voxel port of the beach set the party skill ships as a canvas-2D reference
// room. The DRAW CODE does not transfer — that file paints iso diamonds, this
// engine has a depth buffer — but the inventory, the footprints, the heights
// and the palette do, and they are what make the room read as that beach. Sizes
// below are the reference's `size`/`height` verbatim, in tiles and metres.
//
// The one substitution: the reference's winding RIVER is terrain, and terrain
// here is flat. The station's own `lazy-pool` is already a sunken bezier river
// with a central island, real swimming and infinity edges, so it plays the
// river's part and these props dress the banks around it.

const BCH_SAND = 0xfbf7ee; // white beach sand
const BCH_CREAM = 0xfdf3e0;
const BCH_SKY = 0x8fd3f4; // the bar counter's own colour
const BCH_CORAL = 0xe8604c;
const BCH_TEAK = 0xa8683f;
const BCH_TRUNK = 0xa37a55;
const BCH_TRUNK_D = 0x6d4d31;
const BCH_FROND = 0x4fae76;
const BCH_FROND_D = 0x37905d;
const BCH_METAL = 0xdfe6e6;
const BCH_TEAL = 0x4fb8c9;
const BCH_MINT = 0x7fd1c4;

/** Slats and canopies that should read as airy rather than solid. The reveal
 *  machinery restores `baseOpacity`, so a translucent part must record it or
 *  the morph-in snaps it back to fully opaque. */
function translucent(mat: THREE.MeshStandardMaterial, opacity: number): THREE.MeshStandardMaterial {
  mat.transparent = true;
  mat.opacity = opacity;
  mat.userData.baseOpacity = opacity;
  return mat;
}

/**
 * 🌴 Palm tree — 1×1, 3.2 m. The reference leans its trunk on a quadratic and
 * fans SEVEN fronds of alternating green at the top; both are what stop a palm
 * reading as a lamp post, so both are here as a stack of tapered segments and
 * seven drooping blades.
 */
function buildPalmTree({ m, place }: BuildCtx) {
  const H = 3.0;
  const SEGS = 7;
  const LEAN = 0.42; // total horizontal drift of the crown, on a quadratic
  let prev = new THREE.Vector3(0, 0, 0);
  for (let i = 1; i <= SEGS; i++) {
    const t = i / SEGS;
    const next = new THREE.Vector3(-LEAN * t * t, H * t, 0);
    const mid = prev.clone().add(next).multiplyScalar(0.5);
    const len = prev.distanceTo(next);
    const seg = place(
      new THREE.CylinderGeometry(0.085 - 0.04 * t, 0.10 - 0.04 * (t - 1 / SEGS), len, 9),
      m(i % 2 ? BCH_TRUNK : BCH_TRUNK_D, 0.9, 0.02),
      mid.x,
      mid.y,
      mid.z,
    );
    seg.rotation.z = Math.atan2(next.x - prev.x, next.y - prev.y) * -1;
    prev = next;
  }
  const cx = -LEAN;
  const cy = H;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const len = 0.78 + (i % 3) * 0.16;
    // Each frond is a flattened, tapered blade tilted down from the crown.
    const blade = place(
      new THREE.ConeGeometry(0.17, len, 5),
      m(i % 2 ? BCH_FROND : BCH_FROND_D, 0.88, 0.02),
      cx + Math.cos(a) * len * 0.42,
      cy + 0.06 - len * 0.16,
      Math.sin(a) * len * 0.42,
    );
    blade.rotation.order = "YXZ";
    blade.rotation.y = -a;
    blade.rotation.z = Math.PI / 2 - 0.42; // droop
    blade.scale.set(1, 1, 0.28); // flatten into a leaf
  }
  for (const [dx, dz, r] of [[0.07, 0.05, 0.055], [-0.05, 0.08, 0.047]] as const) {
    place(new THREE.SphereGeometry(r, 8, 8), m(BCH_TRUNK_D, 0.9, 0.03), cx + dx, cy - 0.1, dz);
  }
}

/**
 * ⛱️ Parasol — 1×1, 2.4 m. Eight alternating canopy segments; the alternation
 * is the whole silhouette, so the wedges are real geometry (ConeGeometry takes
 * a thetaStart/thetaLength) rather than one cone in an averaged colour.
 */
function buildParasol({ m, place }: BuildCtx) {
  place(new THREE.CylinderGeometry(0.035, 0.045, 2.3, 8), m(0x9a7350, 0.8, 0.05), 0, 1.15, 0);
  const SEGS = 8;
  for (let i = 0; i < SEGS; i++) {
    const wedge = place(
      new THREE.ConeGeometry(1.02, 0.44, 6, 1, false, (i / SEGS) * Math.PI * 2, (Math.PI * 2) / SEGS),
      m(i % 2 ? BCH_CREAM : BCH_CORAL, 0.85, 0.02),
      0,
      2.16,
      0,
    );
    wedge.castShadow = false;
  }
  // Ribs peeking past the hem, and the finial.
  for (let i = 0; i < SEGS; i++) {
    const a = ((i + 0.5) / SEGS) * Math.PI * 2;
    place(
      new THREE.BoxGeometry(0.02, 0.02, 0.1),
      m(0x9a7350, 0.8, 0.05),
      Math.cos(a) * 1.0,
      1.96,
      Math.sin(a) * 1.0,
    );
  }
  place(new THREE.SphereGeometry(0.055, 8, 8), m(BCH_CORAL, 0.7, 0.05), 0, 2.42, 0);
}

/**
 * 🛋️ Sun lounger — 1×2, 0.5 m, and you LIE on it. Striped mattress (five bands,
 * cream against mint) and a raked backrest, both from the reference.
 */
function buildSunLounger({ m, place }: BuildCtx) {
  place(new THREE.BoxGeometry(0.76, 0.3, 1.76), m(0xcfc0a6, 0.85, 0.04), 0, 0.15, 0);
  place(new THREE.BoxGeometry(0.84, 0.1, 1.84), m(BCH_CREAM, 0.8, 0.03), 0, 0.35, 0);
  const N = 5;
  for (let i = 0; i < N; i++) {
    const z = -0.78 + (i + 0.5) * (1.56 / N);
    place(
      new THREE.BoxGeometry(0.72, 0.07, 1.56 / N - 0.03),
      m(i % 2 ? BCH_CREAM : BCH_MINT, 0.9, 0.02),
      0,
      0.435,
      z,
    );
  }
  // Raked backrest at the -z (head) end.
  const back = place(new THREE.BoxGeometry(0.72, 0.62, 0.08), m(0xefe3d0, 0.85, 0.03), 0, 0.66, -0.82);
  back.rotation.x = -0.42;
  // Chrome feet.
  for (const fx of [-0.3, 0.3]) {
    for (const fz of [-0.7, 0.7]) {
      place(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 6), m(BCH_METAL, 0.4, 0.6), fx, 0.07, fz);
    }
  }
}

/** 🏖️ Beach towel — 1×1 and NOT solid: it lies ON the sand and people walk
 *  over it. Striped, with one corner turned up so it reads as cloth. */
function buildBeachTowel({ m, place }: BuildCtx) {
  const W = 0.86;
  const D = 1.3;
  const N = 6;
  for (let i = 0; i < N; i++) {
    place(
      new THREE.BoxGeometry(W, 0.022, D / N - 0.01),
      m(i % 2 ? BCH_CORAL : BCH_SAND, 0.95, 0.0),
      0,
      0.012,
      -D / 2 + (i + 0.5) * (D / N),
    );
  }
  const corner = place(new THREE.BoxGeometry(0.3, 0.02, 0.3), m(BCH_SAND, 0.95, 0.0), W / 2 - 0.15, 0.05, D / 2 - 0.15);
  corner.rotation.x = -0.5;
  corner.rotation.z = 0.3;
}

/** 🏄 Surfboard — 1×1, 2.1 m, stood on its tail against the sand. */
function buildSurfboard({ m, place }: BuildCtx) {
  const body = place(new THREE.CylinderGeometry(0.26, 0.20, 1.7, 12), m(BCH_CREAM, 0.6, 0.08), 0, 1.0, 0);
  body.scale.set(1, 1, 0.26);
  const nose = place(new THREE.ConeGeometry(0.26, 0.42, 12), m(BCH_CREAM, 0.6, 0.08), 0, 2.06, 0);
  nose.scale.set(1, 1, 0.26);
  const tail = place(new THREE.ConeGeometry(0.20, 0.22, 12), m(BCH_CREAM, 0.6, 0.08), 0, 0.04, 0);
  tail.scale.set(1, 1, 0.26);
  tail.rotation.x = Math.PI;
  // The stripe down the deck — one band of colour is what makes it a surfboard.
  const stripe = place(new THREE.BoxGeometry(0.1, 1.9, 0.015), m(BCH_CORAL, 0.55, 0.1), 0, 1.05, 0.035);
  stripe.rotation.x = 0;
  // A slight lean, as if propped.
  for (const mesh of [body, nose, tail, stripe]) mesh.rotation.z += 0.09;
}

/** 🏐 Beach ball — 1×1, 0.4 m, NOT solid: it is a thing you walk past, and a
 *  ball that blocks a tile is a bug report. Six alternating panels. */
function buildBeachBall({ m, place }: BuildCtx) {
  const R = 0.2;
  const PANELS = 6;
  const cols = [BCH_CORAL, BCH_CREAM, BCH_SKY, BCH_CREAM, 0xf2c14e, BCH_CREAM] as const;
  for (let i = 0; i < PANELS; i++) {
    place(
      new THREE.SphereGeometry(R, 8, 10, (i / PANELS) * Math.PI * 2, (Math.PI * 2) / PANELS),
      m(cols[i], 0.5, 0.06),
      0,
      R,
      0,
    );
  }
}

/** 📦 Crate — 1×1, 0.7 m, stackable. Four posts and slats, not a solid cube. */
function buildBeachCrate({ m, place }: BuildCtx) {
  const W = 0.74;
  const H = 0.66;
  for (const px of [-W / 2 + 0.05, W / 2 - 0.05]) {
    for (const pz of [-W / 2 + 0.05, W / 2 - 0.05]) {
      place(new THREE.BoxGeometry(0.1, H, 0.1), m(BCH_TEAK, 0.9, 0.03), px, H / 2, pz);
    }
  }
  for (const y of [0.1, 0.33, 0.58]) {
    place(new THREE.BoxGeometry(W, 0.1, W - 0.12), m(0x8a4f2d, 0.9, 0.03), 0, y, 0);
    place(new THREE.BoxGeometry(W - 0.12, 0.1, W), m(0x8a4f2d, 0.9, 0.03), 0, y, 0);
  }
  place(new THREE.BoxGeometry(W, 0.05, W), m(BCH_TEAK, 0.9, 0.03), 0, H, 0);
}

/** 🧊 Cooler — 1×1, 0.55 m. White body, teal lid, a wire handle. */
function buildCooler({ m, place }: BuildCtx) {
  place(new THREE.BoxGeometry(0.72, 0.42, 0.72), m(0xf2f6f6, 0.6, 0.06), 0, 0.21, 0);
  place(new THREE.BoxGeometry(0.8, 0.12, 0.8), m(BCH_TEAL, 0.55, 0.1), 0, 0.48, 0);
  const handle = place(new THREE.TorusGeometry(0.11, 0.016, 6, 14, Math.PI), m(0x2c8496, 0.5, 0.3), 0, 0.54, 0);
  handle.rotation.y = Math.PI / 2;
}

/**
 * 🔥 Tiki torch — 1×1, 1.9 m. The checklist calls torch flicker the LAST
 * ambience to add, so the flame here is steady-lit geometry plus one small warm
 * light: the read without the frame cost.
 */
function buildTikiTorch({ m, place, addLight }: BuildCtx) {
  place(new THREE.CylinderGeometry(0.045, 0.06, 1.6, 8), m(BCH_TRUNK_D, 0.92, 0.02), 0, 0.8, 0);
  // Bamboo nodes.
  for (const y of [0.42, 0.86, 1.3]) {
    place(new THREE.CylinderGeometry(0.055, 0.055, 0.045, 8), m(0x4b3a24, 0.9, 0.03), 0, y, 0);
  }
  place(new THREE.CylinderGeometry(0.13, 0.09, 0.14, 10), m(0x4b3a24, 0.85, 0.05), 0, 1.66, 0);
  place(new THREE.ConeGeometry(0.075, 0.24, 8), m(0xff8a3d, 0.3, 0.0, 0xff8a3d, 2.0), 0, 1.85, 0);
  place(new THREE.ConeGeometry(0.042, 0.15, 8), m(0xffd166, 0.3, 0.0, 0xffd166, 2.6), 0, 1.83, 0);
  addLight(new THREE.PointLight(0xffbe5a, 0, 2.4), 0, 1.9, 0, 0.55);
}

/**
 * 🍹 Tiki bar counter — 4×1, 1.28 m. Deliberately TALL: chest height on an
 * avatar reads as a real bar, waist height reads as a desk. Its own sky-blue
 * body, a cream top that overhangs by 0.1, and the LED strip under the lip on
 * the customer side (local +z) that sells the whole prop.
 */
function buildTikiBarCounter({ m, place }: BuildCtx) {
  const L = 3.8;
  const H = 1.18;
  place(new THREE.BoxGeometry(L, H, 0.8), m(BCH_SKY, 0.7, 0.08), 0, H / 2, 0);
  place(new THREE.BoxGeometry(L + 0.2, 0.1, 1.0), m(BCH_CREAM, 0.5, 0.12), 0, H + 0.05, 0);
  // LED strip under the overhang, customer side.
  place(
    new THREE.BoxGeometry(L - 0.1, 0.022, 0.02),
    m(0xe6faff, 0.2, 0.0, 0xe6faff, 2.4),
    0,
    H - 0.035,
    0.42,
  );
  // A bamboo skirt, so the sky-blue slab reads as a beach bar.
  for (let i = 0; i < 14; i++) {
    place(
      new THREE.CylinderGeometry(0.038, 0.038, H - 0.06, 6),
      m(i % 3 ? BCH_TRUNK : BCH_TRUNK_D, 0.9, 0.02),
      -L / 2 + 0.16 + i * ((L - 0.32) / 13),
      (H - 0.06) / 2,
      0.41,
    );
  }
}

/**
 * 🍾 Back bar — 3×1, 2.3 m: the tallest thing in the bar and its focal point.
 * Low white cabinet, a backlit panel standing on it, two glass shelves of
 * bottles, and a neon sign on top. It goes against the BACK edge, behind the
 * bartender row — never mirrored in front of the counter.
 */
function buildTikiBackBar({ m, place, addLight }: BuildCtx) {
  const L = 2.8;
  place(new THREE.BoxGeometry(L, 0.9, 0.5), m(BCH_CREAM, 0.6, 0.08), 0, 0.45, 0);
  // Backlit panel.
  place(
    new THREE.BoxGeometry(L - 0.24, 1.3, 0.08),
    m(0xa0e1fa, 0.35, 0.05, 0x79c4e6, 1.1),
    0,
    1.55,
    -0.18,
  );
  // Two glass shelves with bottles.
  const BOTTLE = [0x7fd1c4, 0xe8604c, 0xf2c14e, 0x9a7bd0, 0x6fbf6b, 0xe88fb0, 0x4fb8c9] as const;
  for (const [y, n] of [[1.22, 6], [1.72, 5]] as const) {
    place(
      new THREE.BoxGeometry(L - 0.3, 0.03, 0.28),
      translucent(m(0xdcf0f7, 0.25, 0.3), 0.55),
      0,
      y,
      -0.02,
    );
    for (let i = 0; i < n; i++) {
      const bx = -(L - 0.5) / 2 + i * ((L - 0.5) / (n - 1));
      const h = 0.2 + (i % 3) * 0.06;
      place(new THREE.CylinderGeometry(0.04, 0.045, h, 8), m(BOTTLE[i % BOTTLE.length], 0.4, 0.15), bx, y + 0.02 + h / 2, -0.02);
      place(new THREE.CylinderGeometry(0.014, 0.014, 0.07, 6), m(BOTTLE[i % BOTTLE.length], 0.4, 0.15), bx, y + 0.02 + h + 0.035, -0.02);
    }
  }
  // Neon "BAR" — a CanvasTexture plate, the wall-computer screen idiom.
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const c2d = canvas.getContext("2d");
  if (c2d) {
    c2d.clearRect(0, 0, 256, 96);
    c2d.font = "bold 58px ui-monospace, Menlo, monospace";
    c2d.textAlign = "center";
    c2d.textBaseline = "middle";
    c2d.shadowColor = "#ff5fa2";
    c2d.shadowBlur = 22;
    c2d.fillStyle = "#ff8fc4";
    c2d.fillText("B A R", 128, 52);
    c2d.fillText("B A R", 128, 52);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.41),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  sign.position.set(0, 2.32, -0.13);
  sign.userData.baseOpacity = 1;
  place(new THREE.BoxGeometry(1.2, 0.05, 0.06), m(0x23252e, 0.8, 0.2), 0, 2.08, -0.13);
  (place(new THREE.BoxGeometry(0.001, 0.001, 0.001), m(BCH_CREAM, 1, 0), 0, 0, 0)).add(sign);
  addLight(new THREE.PointLight(0xff8fc4, 0, 2.2), 0, 2.3, 0.1, 0.35);
}

/** 🪑 Bar stool — 1×1, 0.82 m. Seat height matches the TALLER counter; a
 *  chair-height stool at a 1.28 m bar looks like a mistake. */
function buildTikiBarStool({ m, place }: BuildCtx) {
  place(new THREE.CylinderGeometry(0.22, 0.24, 0.03, 14), m(0xb9c4c4, 0.4, 0.6), 0, 0.015, 0);
  place(new THREE.CylinderGeometry(0.05, 0.05, 0.78, 10), m(BCH_METAL, 0.35, 0.65), 0, 0.39, 0);
  place(new THREE.TorusGeometry(0.16, 0.014, 6, 16), m(BCH_METAL, 0.35, 0.65), 0, 0.2, 0).rotation.x = Math.PI / 2;
  place(new THREE.CylinderGeometry(0.21, 0.19, 0.04, 16), m(0xb64b3a, 0.7, 0.05), 0, 0.80, 0);
  place(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 16), m(BCH_CORAL, 0.75, 0.04), 0, 0.835, 0);
}

/** 🏛 Pergola post — 1×1, 3.0 m. Four of these at the deck corners carry the
 *  roof; the tiles BETWEEN them stay free. */
function buildPergolaPost({ m, place }: BuildCtx) {
  place(new THREE.BoxGeometry(0.14, 3.0, 0.14), m(BCH_TEAK, 0.88, 0.03), 0, 1.5, 0);
  place(new THREE.BoxGeometry(0.24, 0.08, 0.24), m(0x6d3c21, 0.9, 0.03), 0, 0.04, 0);
  place(new THREE.BoxGeometry(0.22, 0.08, 0.22), m(0x6d3c21, 0.9, 0.03), 0, 2.96, 0);
}

/**
 * ✨ Pergola roof — 7×4, 3.2 m, OVERHEAD and non-solid. Airy slats (40% alpha,
 * so the back bar and anyone under it stay readable), five strands of fairy
 * lights, and five paper lanterns at different heights. The checklist is blunt
 * about this one: the lights are what make the bar feel like an evening party
 * rather than a kiosk, so they are not optional dressing.
 */
function buildPergolaRoof({ m, place, addLight }: BuildCtx) {
  const W = 6.6;
  const D = 3.6;
  const Y = 3.06;
  // Beams along the long axis, then slats across.
  for (const z of [-D / 2 + 0.1, 0, D / 2 - 0.1]) {
    place(new THREE.BoxGeometry(W, 0.14, 0.16), m(BCH_TEAK, 0.88, 0.03), 0, Y + 0.09, z);
  }
  const SLATS = 17;
  for (let i = 0; i < SLATS; i++) {
    place(
      new THREE.BoxGeometry(0.1, 0.07, D),
      translucent(m(0x8a4f2d, 0.9, 0.03), 0.4),
      -W / 2 + 0.2 + i * ((W - 0.4) / (SLATS - 1)),
      Y,
      0,
    );
  }
  // Fairy lights: two strands along the beams, two diagonals, one across the
  // middle. Bulbs alternate warm white / blush / gold and hang slightly.
  const BULB = [0xfff2d6, 0xffc9de, 0xffd98a] as const;
  const strand = (x0: number, z0: number, x1: number, z1: number, n: number, seed: number) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const sag = 0.1 * Math.sin(t * Math.PI);
      const col = BULB[(i + seed) % BULB.length];
      place(
        new THREE.SphereGeometry(0.032, 7, 7),
        m(col, 0.25, 0.0, col, 1.9),
        x0 + (x1 - x0) * t,
        Y - 0.12 - sag,
        z0 + (z1 - z0) * t,
      );
    }
  };
  strand(-W / 2 + 0.3, -D / 2 + 0.3, W / 2 - 0.3, -D / 2 + 0.3, 11, 0);
  strand(-W / 2 + 0.3, D / 2 - 0.3, W / 2 - 0.3, D / 2 - 0.3, 11, 1);
  strand(-W / 2 + 0.3, -D / 2 + 0.3, W / 2 - 0.3, D / 2 - 0.3, 13, 2);
  strand(-W / 2 + 0.3, D / 2 - 0.3, W / 2 - 0.3, -D / 2 + 0.3, 13, 1);
  strand(-W / 2 + 0.3, 0, W / 2 - 0.3, 0, 11, 0);
  // Paper lanterns — pastel, at different heights, each with its own glow.
  const LANTERN = [0xffc2d8, 0xd7bdf2, 0xffe08a, 0xa8ebd8, 0xffcfa8] as const;
  const at = [-2.4, -1.1, 0.3, 1.6, 2.7];
  at.forEach((lx, i) => {
    const drop = 0.26 + (i % 3) * 0.14;
    place(new THREE.CylinderGeometry(0.004, 0.004, drop, 4), m(0x8a4f2d, 0.9, 0.0), lx, Y - drop / 2, (i % 2 ? 0.7 : -0.7));
    const ball = place(
      new THREE.SphereGeometry(0.19, 12, 10),
      m(LANTERN[i], 0.55, 0.0, LANTERN[i], 0.9),
      lx,
      Y - drop - 0.17,
      i % 2 ? 0.7 : -0.7,
    );
    ball.scale.set(1, 0.84, 1);
  });
  addLight(new THREE.PointLight(0xffd9a8, 0, 7.0), 0, Y - 0.6, 0, 0.55);
}

// ── 🎉 Party fixtures ────────────────────────────────────────────────────────
// The cake, the gifts, the banner, the speaker and the dance floor. Everything
// here is ordinary registry furniture — what makes it a PARTY is that four of
// the five carry per-instance state in the room doc (partyDoc.ts) instead of
// being pure decoration, and that one of them is gated to a named person.
//
// Placement note (the element-checklist zoning rule): these want to live down
// ONE SIDE of the room facing an empty middle, with the tallest (banner) at the
// back. Nothing here should end up between the camera and the cake.

const CANDLE_WAX = 0xfff0f4;
const FLAME = 0xffb300;
const CLOTH = 0xfdf6ec;

/** Deterministic 0..1 from an item id — so a PILE of gifts isn't uniform.
 *  (FNV-1a; the same id must give the same colour on every client.) */
function idHash01(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * 🎂 THE ANCHOR OF THE ROOM. A tall clothed 2×1 table carrying a four-tier
 * floral cake.
 *
 * Two phases, driven by `cake:<itemId>` in the room doc: candles LIT (only the
 * guest of honour may blow them out) and candles OUT (the cake becomes a slice
 * dispenser for everyone). The flames and their light are one group whose
 * visibility follows the doc, so the moment lands on every screen at once.
 *
 * The table is display height (top at 0.92 m — owner ruling 2026-09-25: the
 * old 0.67 m sat at the fox's knees). The cake follows the owner's reference
 * (2026-09-25): FOUR tiers of pale mint buttercream with a rough, ridged
 * finish — the frosting shows — dressed with big open blossoms in coral,
 * pink, peach and yellow with green leaves: a cluster on top, a cascade down
 * the front-left across every tier, and tiny blossoms along each tier's foot.
 *
 * Every petal, leaf and flower centre is ONE InstancedMesh (≈1 000 instances,
 * one draw call): built as meshes they would cost more than the rest of the
 * room. Flower layout is seeded from the item id, so two cakes differ but
 * every client agrees on each.
 */
const CAKE_TOP = 0.92; // the cloth surface — every cake height is from here
function buildCakeTable(ctx: BuildCtx) {
  const { m, place, addLight, attach, itemId } = ctx;

  // Table + cloth. Deep enough for the four-tier cake's stand; the cloth
  // overhangs the top on all four sides and falls in a long skirt.
  place(new THREE.BoxGeometry(1.62, 0.85, 0.92), m(WOOD, 0.8, 0.05), 0, 0.425, 0);
  place(new THREE.BoxGeometry(1.86, 0.07, 1.14), m(CLOTH, 0.9, 0.02), 0, CAKE_TOP - 0.035, 0);
  place(new THREE.BoxGeometry(1.84, 0.30, 1.12), m(CLOTH, 0.95, 0.0), 0, CAKE_TOP - 0.22, 0);

  // ── Four tiers on a stand ──
  const TOP = CAKE_TOP;
  const MINT = [0xc3e4e0, 0xb4dcd8, 0xd0ebe7] as const; // the reference's pale blue buttercream, three ridge tones
  const RIM = 0xa9d1cc; // the shadow line under each tier
  place(new THREE.CylinderGeometry(0.46, 0.46, 0.02, 28), m(0xf4efe6, 0.6, 0.1), 0, TOP + 0.01, 0);
  place(new THREE.CylinderGeometry(0.44, 0.46, 0.015, 28), m(0xe6dfd2, 0.6, 0.05), 0, TOP + 0.0275, 0);
  const tiers: Array<[number, number]> = [
    [0.40, 0.24],
    [0.33, 0.22],
    [0.26, 0.2],
    [0.19, 0.18],
  ];
  let seed = idHash01(itemId) * 1000;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const tierBase: number[] = [];
  const tierTop: number[] = [];
  let y = TOP + 0.035;
  for (const [r, h] of tiers) {
    tierBase.push(y);
    // The ridged finish: the tier is a stack of thin bands whose radius
    // wanders a few millimetres, in three tones — buttercream pulled round
    // with a palette knife, not a smooth drum.
    const bands = Math.round(h / 0.035);
    for (let b = 0; b < bands; b++) {
      const rr = r + (rnd() - 0.35) * 0.012;
      const bh = h / bands + 0.004;
      place(new THREE.CylinderGeometry(rr, rr + 0.003, bh, 26), m(MINT[b % 3], 0.9, 0.0), 0, y + (b + 0.5) * (h / bands), 0);
    }
    place(new THREE.CylinderGeometry(r, r, 0.03, 26), m(MINT[2], 0.85, 0.0), 0, y + h + 0.015, 0);
    place(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.01, 26), m(RIM, 0.85, 0.0), 0, y + h - 0.005, 0);
    y += h + 0.03;
    tierTop.push(y);
  }
  const CAKE_TOP_Y = y;

  // ── Flowers, as instances. Every blossom is a dark centre, five cupped
  //    petals round it in the plane tangent to the cake, and a leaf or two.
  const PETAL = [0xff6f52, 0xff8fab, 0xffb07a, 0xffd84a, 0xfff0d6, 0xf26b8a] as const;
  const LEAF = [0x4fae76, 0x7cc47a, 0x3a8f5c] as const;
  const CENTRE = 0x3b2a2a;
  type Inst = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3; c: number };
  const inst: Inst[] = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const put = (p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, c: number) => inst.push({ p, q, s, c });
  /** A blossom at `at`, facing `n` (unit), radius r. */
  const blossom = (at: THREE.Vector3, n: THREE.Vector3, r: number, colour: number) => {
    const qN = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const petals = 5;
    const phase = rnd() * Math.PI * 2;
    for (let k = 0; k < petals; k++) {
      const a = phase + (k / petals) * Math.PI * 2;
      // Petal: a flattened ellipsoid, long axis radial, tipped up 25° so the
      // flower cups toward its centre.
      const q = qN.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, -a))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.44));
      const off = new THREE.Vector3(Math.cos(a) * r * 0.55, r * 0.12, Math.sin(a) * r * 0.55).applyQuaternion(qN);
      put(at.clone().add(off), q, new THREE.Vector3(r * 0.62, r * 0.16, r * 0.42), colour);
    }
    put(at.clone().add(n.clone().multiplyScalar(r * 0.14)), qN, new THREE.Vector3(r * 0.26, r * 0.2, r * 0.26), CENTRE);
    // A leaf or two poking out from under the petals.
    const leaves = rnd() < 0.6 ? 2 : 1;
    for (let k = 0; k < leaves; k++) {
      const a = phase + rnd() * Math.PI * 2;
      const q = qN.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, -a));
      const off = new THREE.Vector3(Math.cos(a) * r * 0.95, -r * 0.05, Math.sin(a) * r * 0.95).applyQuaternion(qN);
      put(at.clone().add(off), q, new THREE.Vector3(r * 0.5, r * 0.08, r * 0.24), LEAF[Math.floor(rnd() * LEAF.length)]);
    }
  };
  const hue = () => PETAL[Math.floor(rnd() * PETAL.length)];
  /** On a tier's SIDE at angle a (local, +z front), fraction f up its height. */
  const onSide = (t: number, a: number, f: number, r: number) => {
    const [R, h] = tiers[t];
    const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    blossom(new THREE.Vector3(Math.cos(a) * (R + r * 0.1), tierBase[t] + h * f, Math.sin(a) * (R + r * 0.1)), n, r, hue());
  };
  /** On the exposed TOP of tier t (the annulus outside the tier above). */
  const onTop = (t: number, a: number, radius: number, r: number) => {
    blossom(new THREE.Vector3(Math.cos(a) * radius, tierTop[t] + r * 0.12, Math.sin(a) * radius), UP, r, hue());
  };

  // The crown: a cluster on the top tier's back-left, leaving the candles
  // their ring at the centre-front.
  for (let k = 0; k < 8; k++) {
    const a = 1.9 + (k / 8) * 2.8 + rnd() * 0.3;
    onTop(3, a, 0.1 + rnd() * 0.06, 0.06 + rnd() * 0.025);
  }
  // The cascade: down the front-left, every tier — on the side and spilling
  // onto the top of the tier below, biggest in the middle.
  for (let t = 3; t >= 0; t--) {
    const n = 3 + (3 - t);
    for (let k = 0; k < n; k++) {
      const a = 2.0 + rnd() * 0.9 + (k / n) * 0.6;
      onSide(t, a, 0.25 + rnd() * 0.55, 0.06 + rnd() * 0.03);
    }
    if (t > 0) {
      const [rBelow] = tiers[t - 1];
      const [rThis] = tiers[t];
      for (let k = 0; k < 2; k++) {
        const a = 2.15 + rnd() * 1.0;
        onTop(t - 1, a, rThis + (rBelow - rThis) * 0.5, 0.05 + rnd() * 0.02);
      }
    }
  }
  // Tiny blossoms along each tier's foot, all the way round, like the
  // reference's sprinkled base.
  for (let t = 0; t < tiers.length; t++) {
    const [R] = tiers[t];
    const n = Math.round((2 * Math.PI * R) / 0.32);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.3;
      onSide(t, a, 0.06, 0.024 + rnd() * 0.01);
    }
  }

  // One InstancedMesh for the lot.
  const petalGeo = new THREE.SphereGeometry(1, 8, 6);
  const petalMat = m(0xffffff, 0.75, 0.0);
  const flowers = new THREE.InstancedMesh(petalGeo, petalMat, inst.length);
  const mtx = new THREE.Matrix4();
  const col = new THREE.Color();
  inst.forEach((it, i) => {
    mtx.compose(it.p, it.q, it.s);
    flowers.setMatrixAt(i, mtx);
    flowers.setColorAt(i, col.setHex(it.c));
  });
  flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
  flowers.name = "cakeFlowers";
  attach(flowers);

  // ── Candles. A ring on the top tier; the flames live in their own group. ──
  const flames = new THREE.Group();
  flames.name = "cakeFlames";
  const { candles } = readCake(itemId);
  const CANDLE_BASE = CAKE_TOP_Y;
  for (let i = 0; i < candles; i++) {
    const a = (i / Math.max(1, candles)) * Math.PI * 2;
    const cx = Math.cos(a) * 0.075;
    const cz = Math.sin(a) * 0.075 + 0.02; // a touch forward, clear of the crown
    place(new THREE.CylinderGeometry(0.012, 0.012, 0.13, 6), m(CANDLE_WAX, 0.7, 0.02), cx, CANDLE_BASE + 0.065, cz);
    // Flame: a small emissive teardrop. Parented to `flames`, not the item, so
    // one visibility flip blows out every candle together.
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.018, 0.055, 7),
      m(FLAME, 0.3, 0.0, FLAME, 2.2),
    );
    flame.position.set(cx, CANDLE_BASE + 0.16, cz);
    flames.add(flame);
  }
  attach(flames);

  // One warm light for the whole ring — 5 point lights would be a frame cost
  // for no visible gain at this scale.
  const glow = new THREE.PointLight(FLAME, 0, 1.6);
  addLight(glow, 0, CANDLE_BASE + 0.22, 0, 0.9);

  // ── 🎊 Confetti. The payoff of the moment, and the reason it reads as an
  //    EVENT rather than a state flag. Pre-built and parked: a burst must not
  //    allocate geometry at the instant everyone is looking.
  const CONFETTI = [0xff8fab, 0xf2c14e, 0x7fd1c4, 0x9a7bd0, 0xffffff, 0x79c4e6] as const;
  const COUNT = 48;
  const bits: THREE.Mesh[] = [];
  const vel: THREE.Vector3[] = [];
  const spin: THREE.Vector3[] = [];
  const confetti = new THREE.Group();
  confetti.name = "cakeConfetti";
  confetti.visible = false;
  for (let i = 0; i < COUNT; i++) {
    const bit = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.006, 0.028),
      m(CONFETTI[i % CONFETTI.length], 0.6, 0.05),
    );
    confetti.add(bit);
    bits.push(bit);
    vel.push(new THREE.Vector3());
    spin.push(new THREE.Vector3());
  }
  attach(confetti);

  let burstT = -1; // <0 ⇒ idle
  const BURST_SECS = 2.6;
  const fire = () => {
    burstT = 0;
    confetti.visible = true;
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.7 + Math.random() * 1.1;
      bits[i].position.set(0, CANDLE_BASE + 0.2, 0);
      vel[i].set(Math.cos(a) * speed * 0.55, 1.5 + Math.random() * 1.2, Math.sin(a) * speed * 0.55);
      spin[i].set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    }
  };
  // Reuse the per-item pulse slot World already drives — a cake is never also
  // a dance floor, so one handle per item is enough.
  const pulse: PropAnimHandle = {
    update(dt: number) {
      if (burstT < 0) return;
      burstT += dt;
      if (burstT > BURST_SECS) {
        burstT = -1;
        confetti.visible = false;
        return;
      }
      for (let i = 0; i < COUNT; i++) {
        vel[i].y -= 3.4 * dt; // gravity — paper falls slowly
        vel[i].x *= 1 - 1.6 * dt; // and air-brakes sideways
        vel[i].z *= 1 - 1.6 * dt;
        bits[i].position.addScaledVector(vel[i], dt);
        bits[i].rotation.x += spin[i].x * dt;
        bits[i].rotation.y += spin[i].y * dt;
        bits[i].rotation.z += spin[i].z * dt;
      }
    },
  };

  // ── Live state: the flames follow the doc, not the local click ──
  // First paint must NOT fire confetti: a joiner walking into a party that
  // already happened should find the candles quietly out, not re-run the
  // moment. Only a lit → unlit TRANSITION is the event.
  // The baseline is per PARTY DOC: reconcileFurniture reuses this group when
  // the next room holds a same-id cake in the same pose, and the rebind then
  // notifies this very listener — an unlit cake there must not read as "the
  // one I knew was lit just went out" (Copilot review, PR #169).
  let known: boolean | null = null;
  let knownEpoch = partyDocEpoch();
  const applyPhase = () => {
    const epoch = partyDocEpoch();
    if (epoch !== knownEpoch) {
      knownEpoch = epoch;
      known = null;
    }
    const lit = readCake(itemId).lit;
    flames.visible = lit;
    glow.intensity = lit ? 0.9 : 0;
    if (known === true && !lit) fire();
    known = lit;
  };
  applyPhase();
  // Both hooks ride the trim-style carrier rules: the subscription can live on
  // a Group (the dispose scan traverses everything), the drive handle cannot
  // (registerFurnitureHandles only visits meshes) — so it goes on a mesh.
  flames.userData.disposePartySub = subscribePartyKey(cakeKey(itemId), applyPhase);
  const carrier = place(new THREE.BoxGeometry(0.001, 0.001, 0.001), m(CLOTH, 1, 0), 0, 0.01, 0);
  carrier.visible = false;
  carrier.userData.propAnim = pulse;
}

/**
 * 🎁 A stackable, openable gift box. Colour is derived from the item id so a
 * pile reads as several presents rather than a repeated asset. Opening is the
 * small, ungated echo of the cake moment: one doc write, and the lid tilts off
 * on every client.
 */
function buildGiftBox(ctx: BuildCtx) {
  const { m, place, attach, itemId } = ctx;
  const WRAPS = [0xff8fab, 0x7fd1c4, 0xf2c14e, 0x9a7bd0, 0x6fbf6b, 0x79c4e6] as const;
  const wrap = WRAPS[Math.floor(idHash01(itemId) * WRAPS.length) % WRAPS.length];
  const RIBBON = 0xfff4e8;

  const W = 0.62;
  place(new THREE.BoxGeometry(W, 0.46, W), m(wrap, 0.78, 0.04), 0, 0.23, 0);
  // Ribbon cross on the four sides, slightly proud of the wrapping.
  place(new THREE.BoxGeometry(0.1, 0.47, W + 0.012), m(RIBBON, 0.6, 0.06), 0, 0.23, 0);
  place(new THREE.BoxGeometry(W + 0.012, 0.47, 0.1), m(RIBBON, 0.6, 0.06), 0, 0.23, 0);

  // Lid + bow ride in one group so opening tilts them together.
  const lid = new THREE.Group();
  lid.name = "giftLid";
  const lidMesh = new THREE.Mesh(new THREE.BoxGeometry(W + 0.06, 0.1, W + 0.06), m(wrap, 0.75, 0.05));
  lidMesh.position.y = 0.05;
  lid.add(lidMesh);
  for (const ry of [0, Math.PI / 2]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, W + 0.07), m(RIBBON, 0.6, 0.06));
    band.position.y = 0.05;
    band.rotation.y = ry;
    lid.add(band);
  }
  // Bow: two squashed spheres either side of a knot.
  for (const bx of [-0.07, 0.07]) {
    const loop = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), m(RIBBON, 0.55, 0.08));
    loop.position.set(bx, 0.13, 0);
    loop.scale.set(1, 0.7, 0.55);
    lid.add(loop);
  }
  lid.position.set(0, 0.46, 0);
  attach(lid);

  const applyPhase = () => {
    const { opened } = readGift(itemId);
    // Opened: the lid slides off one corner and tips, the way a lid actually
    // lands. Closed: square on the box.
    lid.position.set(opened ? 0.30 : 0, opened ? 0.50 : 0.46, opened ? 0.22 : 0);
    lid.rotation.set(opened ? 0.42 : 0, opened ? 0.55 : 0, opened ? -0.30 : 0);
  };
  applyPhase();
  lid.userData.disposePartySub = subscribePartyKey(giftKey(itemId), applyPhase);
}

/**
 * 🎊 Birthday banner — 3×1 of bunting on two poles, with a lettered cloth
 * hung beneath the string. footprint NULL on purpose: guests walk UNDER it,
 * and a banner that blocks a corridor is the fastest way to make a party
 * room unwalkable (the checklist's two-tile corridor rule).
 *
 * Poles stand 3.8 m (owner rulings 2026-09-25: 2.35 m hung at the jungle
 * plants' waist, 3.0 m still sat on the cake's crown). The cloth reads "Happy Birthday Dorkmo" from
 * both sides — two panels back to back, each with the text the right way
 * round, since a single double-sided plane mirrors it from behind.
 */
const BANNER_TEXT = "Happy Birthday Dorkmo";

/** The lettering, painted once per build into a canvas: coral script on a
 *  cream cloth with a pink border, the party palette. */
function makeBannerTexture(text: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 192;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fdf3e0"; // cream
  c.fillRect(0, 0, W, H);
  c.strokeStyle = "#ff8fab"; // pink border
  c.lineWidth = 10;
  c.strokeRect(9, 9, W - 18, H - 18);
  // Scalloped dots along the border, the way a party banner is printed.
  c.fillStyle = "#f2c14e";
  for (let x = 40; x < W - 20; x += 48) {
    c.beginPath(); c.arc(x, 24, 6, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(x, H - 24, 6, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = "#e8604c"; // coral letters
  c.textAlign = "center";
  c.textBaseline = "middle";
  let size = 96;
  c.font = `bold ${size}px "Trebuchet MS", "Gill Sans", "Helvetica Neue", sans-serif`;
  while (c.measureText(text).width > W - 120 && size > 40) {
    size -= 4;
    c.font = `bold ${size}px "Trebuchet MS", "Gill Sans", "Helvetica Neue", sans-serif`;
  }
  c.fillText(text, W / 2, H / 2 + 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildBirthdayBanner(ctx: BuildCtx) {
  const { m, place } = ctx;
  const POLE = 0xd8d2c4;
  const BUNTING = [0xff8fab, 0xf2c14e, 0x7fd1c4, 0x9a7bd0, 0xffffff] as const;
  const SPAN = 2.6;
  const POLE_H = 3.8;

  for (const px of [-SPAN / 2, SPAN / 2]) {
    place(new THREE.CylinderGeometry(0.035, 0.045, POLE_H, 8), m(POLE, 0.6, 0.35), px, POLE_H / 2, 0);
    place(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 10), m(POLE, 0.7, 0.3), px, 0.03, 0);
  }

  // The string sags: a catenary approximated by a cosine, drawn as short
  // segments so it reads as a curve rather than a taut wire.
  const SAG = 0.34;
  const TOP = POLE_H - 0.1;
  const yAt = (t: number) => TOP - SAG * Math.sin(t * Math.PI); // 0 at both poles
  const STEPS = 14;
  for (let i = 0; i < STEPS; i++) {
    const t0 = i / STEPS;
    const t1 = (i + 1) / STEPS;
    const x0 = -SPAN / 2 + t0 * SPAN;
    const x1 = -SPAN / 2 + t1 * SPAN;
    const y0 = yAt(t0);
    const y1 = yAt(t1);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const seg = place(
      new THREE.CylinderGeometry(0.012, 0.012, len, 5),
      m(POLE, 0.8, 0.1),
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      0,
    );
    seg.rotation.z = Math.PI / 2 - Math.atan2(y1 - y0, x1 - x0);

    // A bunting triangle hanging from the midpoint of every segment.
    const flag = place(
      new THREE.ConeGeometry(0.085, 0.2, 3),
      m(BUNTING[i % BUNTING.length], 0.85, 0.02),
      (x0 + x1) / 2,
      (y0 + y1) / 2 - 0.115,
      0,
    );
    flag.rotation.x = Math.PI; // point down
    flag.rotation.y = Math.PI / 2;
  }

  // ── The lettered cloth, hung below the bunting on two cords ──
  const CLOTH_W = 2.2;
  const CLOTH_H = CLOTH_W * (192 / 1024);
  const clothTop = yAt(0.5) - 0.3; // under the flag tips at the sag
  const clothY = clothTop - CLOTH_H / 2;
  for (const t of [0.2, 0.8]) {
    const x = -SPAN / 2 + t * SPAN;
    const cordLen = yAt(t) - clothTop;
    place(new THREE.CylinderGeometry(0.008, 0.008, cordLen, 4), m(POLE, 0.8, 0.1), x, clothTop + cordLen / 2, 0);
  }
  const tex = makeBannerTexture(BANNER_TEXT);
  for (const side of [1, -1] as const) {
    const mat = m(0xffffff, 0.9, 0.0);
    mat.map = tex;
    const panel = place(new THREE.PlaneGeometry(CLOTH_W, CLOTH_H), mat, 0, clothY, side * 0.006);
    if (side === -1) panel.rotation.y = Math.PI; // the back reads the right way round too
  }
  // A thin batten along the top edge so the cloth hangs straight.
  place(new THREE.BoxGeometry(CLOTH_W + 0.04, 0.02, 0.025), m(0xa86f43, 0.8, 0.1), 0, clothTop, 0);
}

/**
 * 🔊 Party speaker — the dance floor's power switch, and the room's music.
 * Toggling it is ungated (anyone may kill the music) and the state rides
 * `speaker:<itemId>`, which the dance floor subscribes to as well.
 *
 * 🎶 It PLAYS (partyAudio.ts): "Happy Birthday" on a celesta the moment the
 * local player walks into the room — once, whatever the switch says — and on
 * a loop while the switch is on, fading with the player's distance from the
 * cabinet. Driven per frame by a PropAnimHandle, so it stops dead when the
 * item is removed or the room is left.
 */
function buildPartySpeaker(ctx: BuildCtx) {
  const { m, place, attach, itemId } = ctx;
  const CAB = 0x23252e;
  const CONE = 0x3d4a5e;
  const LIT = 0x7fd1c4;

  place(new THREE.BoxGeometry(0.52, 0.86, 0.42), m(CAB, 0.72, 0.18), 0, 0.43, 0);
  place(new THREE.BoxGeometry(0.56, 0.05, 0.46), m(CAB, 0.55, 0.3), 0, 0.88, 0);
  // Two drivers facing +z (the local "front" convention the devices use).
  for (const [dy, r] of [[0.30, 0.17], [0.64, 0.10]] as const) {
    place(new THREE.CylinderGeometry(r, r, 0.03, 16), m(CONE, 0.9, 0.05), 0, dy, 0.215).rotation.x = Math.PI / 2;
    place(new THREE.CylinderGeometry(r * 0.35, r * 0.35, 0.05, 12), m(0x14181e, 0.6, 0.4), 0, dy, 0.228).rotation.x = Math.PI / 2;
  }

  // Status ring — the only part that changes with state.
  const ring = new THREE.Group();
  const ringMat = m(LIT, 0.3, 0.1, LIT, 1.8);
  const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 20), ringMat);
  ringMesh.position.set(0, 0.86, 0.14);
  ringMesh.rotation.x = Math.PI / 2;
  ring.add(ringMesh);
  attach(ring);

  const applyPhase = () => {
    const { on } = readSpeaker(itemId);
    ringMat.emissiveIntensity = on ? 1.8 : 0.05;
    ringMat.needsUpdate = true;
  };
  applyPhase();
  ring.userData.disposePartySub = subscribePartyKey(speakerKey(itemId), applyPhase);

  // ── 🎶 The music. A carrier mesh holds the per-frame handle (World only
  //    collects handles from meshes) and the dispose hook that silences it.
  const voice = createSpeakerVoice(itemId);
  const carrier = place(new THREE.BoxGeometry(0.001, 0.001, 0.001), m(CAB, 1, 0), 0, 0.01, 0);
  carrier.visible = false;
  const anim: PropAnimHandle = {
    update(dt: number) {
      const me = FURNITURE.find((f) => f.id === itemId);
      const p = localPlayerXZ();
      const distance = me ? Math.hypot(me.pos.x - p.x, me.pos.z - p.z) : 0;
      const sp = readSpeaker(itemId);
      voice.update(dt, { on: sp.on, inRoom: isLocalPlayerInRoom(), distance, track: sp.track });
    },
  };
  carrier.userData.propAnim = anim;
  carrier.userData.disposeAudio = () => voice.dispose();
}

/**
 * 💃 Dance floor — a 4×4 checkered pad. footprint NULL: it is FLOOR, people
 * must be able to stand on it, and a dance emote on plain deck is a gesture
 * while the same emote on a lit floor is a place.
 *
 * It pulses only while a speaker in the room is on. The pulse is driven by a
 * PropAnimHandle that World ticks (the trunk-lid idiom) rather than a timer
 * of its own, so it stops dead when the item is removed.
 */
function buildDanceFloor(ctx: BuildCtx) {
  const { m, place, itemId } = ctx;
  const A = 0xf7d9e6; // pastel pink
  const B = 0xd6f0ee; // pastel mint
  const N = 4;
  const CELL = 1.0;
  const pads: THREE.MeshStandardMaterial[] = [];

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const col = (i + j) % 2 === 0 ? A : B;
      const mat = m(col, 0.55, 0.06, col, 0.25);
      const x = (i - (N - 1) / 2) * CELL;
      const z = (j - (N - 1) / 2) * CELL;
      place(new THREE.BoxGeometry(CELL * 0.97, 0.035, CELL * 0.97), mat, x, 0.018, z);
      pads.push(mat);
    }
  }
  // A dark trim so the floor reads as an inset panel, not a rug. It also
  // CARRIES the handles: registerFurnitureHandles only visits meshes, so a
  // Group would be collected by nothing and the floor would never pulse.
  const trim = place(
    new THREE.BoxGeometry(N * CELL + 0.1, 0.02, N * CELL + 0.1),
    m(0x23252e, 0.8, 0.1),
    0,
    0.008,
    0,
  );

  let t = 0;
  let on = readSpeaker(itemId).on;
  // Per-frame handle — World drives update(dt) and drops it on removal.
  const pulse: PropAnimHandle = {
    update(dt: number) {
      if (!on) {
        for (const mat of pads) mat.emissiveIntensity = 0.06;
        return;
      }
      t += dt;
      // Travelling wave across the grid, not a uniform blink: each pad's phase
      // is offset by its index so the floor reads as moving light.
      for (let k = 0; k < pads.length; k++) {
        const phase = t * 3.2 - k * 0.35;
        pads[k].emissiveIntensity = 0.18 + 0.30 * (0.5 + 0.5 * Math.sin(phase));
      }
    },
  };
  trim.userData.propAnim = pulse;

  const applySpeaker = () => {
    on = readSpeaker(itemId).on;
  };
  trim.userData.disposePartySub = subscribePartyKey(speakerKey(itemId), applySpeaker);
}

/**
 * 🍸 Standing table — somewhere to put a drink down that isn't the cake table.
 * The checklist is right that a party needs a second and third place to BE;
 * this is the cheapest of them.
 */
function buildPartyStandingTable(ctx: BuildCtx) {
  const { m, place } = ctx;
  const H = 1.02;
  place(new THREE.CylinderGeometry(0.30, 0.30, 0.05, 20), m(CLOTH, 0.7, 0.05), 0, H, 0);
  place(new THREE.CylinderGeometry(0.055, 0.055, H, 10), m(0xd8d2c4, 0.5, 0.45), 0, H / 2, 0);
  place(new THREE.CylinderGeometry(0.26, 0.30, 0.04, 16), m(0xd8d2c4, 0.6, 0.4), 0, 0.02, 0);
  // A cloth sleeve down the post — bistro tables always have one.
  place(new THREE.CylinderGeometry(0.085, 0.11, H - 0.1, 12), m(CLOTH, 0.95, 0.0), 0, (H - 0.1) / 2, 0);
}

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
  // 🍸 The E1 legacy footprintOverride is GONE, so the def footprint (2×3 ⇒
  // x[4.24,6.24] z[1.6,4.6]) now applies from the start instead of only after
  // the bar's first move. The override described the 1×2-tile STOOL STRIP
  // (x[4,5] z[3,5]) rather than the bar itself, whose mesh runs x[4.40,6.00]
  // z[1.61,4.59] — counter, cabinet, back panel and shelf stack. That was
  // harmless while the walkable floor stopped at ±5.0, because everything the
  // override missed was outside the walkable box anyway. Opening the outer
  // ring (roomWalkBounds) moved the boundary to ±5.5 and left five cells —
  // (5.25, 1.75) through (5.25, 4.25) — walkable INSIDE the cabinet, so the
  // avatar could stroll through the bar. The def footprint is the honest box
  // and is what the item would have got the moment anyone moved it.
  //
  // It also closes a false negative in the wall-mount gate: the terminal's
  // panel slab reaches x=6.12 on the east wall, which the old override
  // (x1=5.0) could not see, so the room terminal could be hung inside the
  // bar's shelves at z≈1.5–2.5. The honest box overlaps the slab and refuses.
  //
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
  // wall's flush-mount plane. Footprint null ⇒ never an obstacle.
  // 🖥️ movable: the owner can re-hang it on any wall in edit mode — a carry
  // snaps it to the nearest wall and takes its rotation from that wall
  // (snapInteriorWall), the way a door drag is locked to its wall. It can
  // never be REMOVED though: its focused UI is the EDIT ROOM entry point
  // (editMode.removeSelected).
  {
    id: "wall-computer",
    kind: "wall-computer",
    pos: { x: 1.8, z: 5.97 },
    rot: 2,
    movable: true,
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
 * 🪑 The Grand Lobby manifest, FROZEN at module load.
 *
 * `FURNITURE` above is not a constant in practice: World.reconcileFurniture
 * splices and pushes it so it always mirrors the room you are standing in.
 * Two things that meant to read "the default lobby" were reading "the current
 * room" instead — the Grand Lobby template (placing it in an empty room placed
 * nothing; in a furnished one, a copy of that room) and the seeding of a brand
 * new module (which could inherit whatever room you had just walked out of).
 * Both read this snapshot now. Deep-copied so a later edit-mode drag on a live
 * item can never reach into it.
 */
export const DEFAULT_LOBBY_FURNITURE: readonly FurnitureItem[] = Object.freeze(
  FURNITURE.map((i) => ({
    ...i,
    pos: { ...i.pos },
    ...(i.footprintOverride ? { footprintOverride: { ...i.footprintOverride } } : {}),
  })),
);


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

// 🛰️ RETIRED: OUTDOOR_CASINO_ROOM_ID. This manifest is a TEMPLATE's furniture
// now (pool-1), placeable in any module — no room id means "the pool room".

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

// 🛰️ RETIRED: CASINO_ROOM_ID — see above. CASINO_FURNITURE is the casino-1
// template's manifest; a module is a casino because it holds these pieces.

// ── 🌌 Room visual theme ─────────────────────────────────────────────────────
/**
 * A room's VISUAL biome — what backdrop + lighting scheme applyRoomVisuals
 * paints. A per-room SETTING, stored in roomInfo['theme'] and stamped by the
 * template that furnished the room (or by its owner); absent ⇒ 'interior'.
 * Any module can be an 'outdoor-deck' (real space through a glass ceiling +
 * warm bright light) or a 'casino' — there is no room whose id means either
 * (owner ruling 2026-08-13: no room types).
 */
export type RoomTheme = "interior" | "casino" | "outdoor-deck" | "beach";

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
  // 🎲 #69 G3: the craps pit — the marquee table takes the south half of the
  // floor (the z=1/z=3 column tables moved aside to give its eight standing
  // positions and the stickman's dice-stick spot clear room). 3×1 footprint at
  // (0, 2.8); stands ring out to z∈[1.3,4.3] · x∈[-2,2], clear of every wall
  // (±6) and door centre.
  {
    id: "casino-craps",
    kind: "craps-table",
    pos: { x: 0, z: 2.8 },
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
    movable: true, // 🖥️ wall-snapped in edit mode; never removable
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

  // 🕳️ #80: solid rect pool BOTTOM across the full water footprint — mirrors
  // the lazy pool. With the octagon floor hole cut, looking down the hole shows
  // a real basin bottom sinking into the basement instead of the void; without
  // the octagon flag the legacy hidden-floor pool is unchanged. The classic
  // water is a full rect, so this rect bottom backs it completely (no organic
  // corners to leak — no extra tint fill needed beyond the existing plane).
  if (OCTAGON_HULL) {
    place(
      new THREE.BoxGeometry(WX + HX, 0.08, HZ * 2),
      m(0x0e3244, 0.98, 0.02),
      (HX - WX) / 2,
      EDGE_BOT - 0.02,
      0,
    );
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

/**
 * 🏊 Which kinds ARE water — the one list every pool-shaped question asks.
 *
 * The floor hole, the hole outline, the water bbox, the swim basin and World's
 * "hide the platform floor" test all used to spell this pair out inline, and a
 * new water kind had to find all five. It is a predicate now, so adding one is
 * adding it here.
 */
/** World point → a cardinally-posed item's LOCAL frame. */
function toLocal(item: FurnitureItem, wx: number, wz: number): { x: number; z: number } {
  const inv = ((4 - item.rot) % 4) as Rot;
  return rotXZ(wx - item.pos.x, wz - item.pos.z, inv);
}

/** A local AABB → the world AABB it becomes under a CARDINAL rotation. */
function localBoxToWorld(item: FurnitureItem, x0: number, z0: number, x1: number, z1: number): Box {
  const a = rotXZ(x0, z0, item.rot);
  const b = rotXZ(x1, z1, item.rot);
  return {
    x0: item.pos.x + Math.min(a.x, b.x),
    z0: item.pos.z + Math.min(a.z, b.z),
    x1: item.pos.x + Math.max(a.x, b.x),
    z1: item.pos.z + Math.max(a.z, b.z),
  };
}

/** A bridge's footprint in the RIVER's local frame (both are cardinal, so the
 *  rotated box is still an AABB). */
function bridgeLocalBox(river: FurnitureItem, bridge: FurnitureItem): Box {
  const half = ((4 - river.rot) % 4) as Rot;
  const c = rotXZ(BRIDGE_W / 2, bridgeLen() / 2, bridge.rot);
  const w0 = { x: bridge.pos.x - Math.abs(c.x), z: bridge.pos.z - Math.abs(c.z) };
  const w1 = { x: bridge.pos.x + Math.abs(c.x), z: bridge.pos.z + Math.abs(c.z) };
  const a = rotXZ(w0.x - river.pos.x, w0.z - river.pos.z, half);
  const b = rotXZ(w1.x - river.pos.x, w1.z - river.pos.z, half);
  return {
    x0: Math.min(a.x, b.x),
    z0: Math.min(a.z, b.z),
    x1: Math.max(a.x, b.x),
    z1: Math.max(a.z, b.z),
  };
}

/**
 * 🌊 The river's blocked area, as one strip per metre of its length rather
 * than one box round the lot — see FurnitureDef.obstacleBoxes for why. Each
 * strip spans the water at that column (widened to the drift WITHIN the
 * column, so no water leaks out between strips) and is then cut by any bridge
 * crossing it, which is what makes the crossing walkable.
 */
function riverObstacleBoxes(item: FurnitureItem, all: FurnitureItem[]): Box[] {
  const boxes: Box[] = [];
  const bridges = all
    .filter((i) => i.kind === "plank-bridge")
    .map((b) => bridgeLocalBox(item, b));
  const STRIP = 1.0;
  // Blocked-ness is a strict inequality (pathfinding.ts, the collision
  // resolver), so strips overlap slightly: a point landing exactly on a shared
  // edge would otherwise belong to neither.
  const SEAM = 0.01;

  const { halfLen, wWet } = riverMetrics();
  for (let lx0 = -halfLen; lx0 < halfLen; lx0 += STRIP) {
    const lx1 = Math.min(lx0 + STRIP, halfLen);

    // Split the column in X at every bridge edge inside it FIRST. Cutting the
    // whole column whenever a bridge merely clipped its edge used to delete a
    // full metre of river for a few centimetres of bridge, leaving walkable
    // water alongside the crossing.
    const xEdges = new Set<number>([lx0, lx1]);
    for (const b of bridges) {
      if (b.x0 > lx0 && b.x0 < lx1) xEdges.add(b.x0);
      if (b.x1 > lx0 && b.x1 < lx1) xEdges.add(b.x1);
    }
    const xs = [...xEdges].sort((a, b) => a - b);

    for (let k = 0; k < xs.length - 1; k++) {
      const sx0 = xs[k];
      const sx1 = xs[k + 1];
      if (sx1 - sx0 < 1e-6) continue;
      const mid = (sx0 + sx1) / 2;
      // The cut spans the whole EXCAVATION here, widened to the centre line's
      // drift within this piece so no water leaks out between pieces.
      const zc = [riverCentreZ(sx0), riverCentreZ(mid), riverCentreZ(sx1)];
      const spans = [{ z0: Math.min(...zc) - wWet, z1: Math.max(...zc) + wWet }];
      // Only a bridge that actually covers THIS piece in x may cut it.
      for (const b of bridges) {
        if (mid <= b.x0 || mid >= b.x1) continue;
        for (let i = spans.length - 1; i >= 0; i--) {
          const sp = spans[i];
          if (b.z1 <= sp.z0 || b.z0 >= sp.z1) continue;
          spans.splice(i, 1);
          if (b.z0 > sp.z0) spans.push({ z0: sp.z0, z1: b.z0 });
          if (b.z1 < sp.z1) spans.push({ z0: b.z1, z1: sp.z1 });
        }
      }
      for (const sp of spans) {
        if (sp.z1 - sp.z0 < 0.05) continue;
        boxes.push(localBoxToWorld(item, sx0 - SEAM, sp.z0, sx1 + SEAM, sp.z1));
      }
    }
  }
  return boxes;
}

/**
 * 🏊 Is this WORLD point actually in a pool's water? Kind-aware, unlike the
 * basin rectangle: the river's band bends away from its own bounding box, and
 * auto-swimming someone standing on the dry sand at a bend is exactly the bug
 * the rect test would cause.
 */
export function poolWaterContains(items: FurnitureItem[], wx: number, wz: number): boolean {
  for (const item of items) {
    if (!isPoolKind(item.kind)) continue;
    if (item.kind === "beach-river") {
      const l = toLocal(item, wx, wz);
      if (!riverHasWaterAt(l.x, l.z)) continue;
      // Standing ON the bridge is standing over water, not in it.
      const onBridge = items.some((b) => {
        if (b.kind !== "plank-bridge") return false;
        const bb = bridgeLocalBox(item, b);
        return l.x > bb.x0 && l.x < bb.x1 && l.z > bb.z0 && l.z < bb.z1;
      });
      return !onBridge;
    }
    const basin = getPoolBasin(items);
    if (!basin) return false;
    return wx > basin.x0 && wx < basin.x1 && wz > basin.z0 && wz < basin.z1;
  }
  return false;
}

/**
 * 🕳️ Is this WORLD point inside a pool's EXCAVATION — what the floor hole and
 * the obstacle strips follow? For every pool but the river this is the same as
 * the water; the river also cuts its wet shelf, which is dry but 30 cm down.
 */
export function poolCutContains(items: FurnitureItem[], wx: number, wz: number): boolean {
  for (const item of items) {
    if (!isPoolKind(item.kind)) continue;
    if (item.kind === "beach-river") {
      const l = toLocal(item, wx, wz);
      if (!riverHasCutAt(l.x, l.z)) continue;
      const onBridge = items.some((b) => {
        if (b.kind !== "plank-bridge") return false;
        const bb = bridgeLocalBox(item, b);
        return l.x > bb.x0 && l.x < bb.x1 && l.z > bb.z0 && l.z < bb.z1;
      });
      return !onBridge;
    }
    return poolWaterContains(items, wx, wz);
  }
  return false;
}

/** 🏝️ Kinds whose geometry, tiles and blocked area come from the ROOM, not
 *  from the item's pose (the sea, the infinity pool): they can be added and
 *  removed but not dragged — a drag would move the mesh's offset and nothing
 *  else (Copilot review, PR #169). */
export function isRoomAnchoredKind(kind: FurnitureKind): boolean {
  return kind === "beach-sea" || kind === "infinity-pool";
}

export function isPoolKind(kind: FurnitureKind): boolean {
  return kind === "lazy-pool" || kind === "classic-pool" || kind === "beach-river";
}

/**
 * 🌊 A swim route that stays IN a winding river: from `from` to `to` along
 * the centre line, the swimmer's offset from the centre eased from where it
 * started to where it is going, never past the bank. Null when the room's
 * pool is not a river (rectangular water needs no routing) or either end is
 * not in its water. Straight lines between two bends crossed the sand
 * (Copilot review, PR #169).
 */
/**
 * 🌊 Where a swimmer in the river climbs out: the point on the NEAR bank —
 * the bank on the target's side of the water when the target is out of it,
 * else the closer one — just past the wet shelf, straight across the flow
 * from where they are. A straight glide there never crosses sand; the
 * basin rectangle's edges did (Copilot review, PR #169). Null when the
 * room's pool is not a river or the swimmer is not in its water.
 */
export function riverClimbOut(
  items: FurnitureItem[],
  from: { x: number; z: number },
  target: { x: number; z: number },
): { x: number; z: number } | null {
  const river = items.find((i) => i.kind === "beach-river");
  if (!river) return null;
  const a = toLocal(river, from.x, from.z);
  if (!riverHasWaterAt(a.x, a.z)) return null;
  const t = toLocal(river, target.x, target.z);
  const { wWet, halfLen } = riverMetrics();
  const offFrom = a.z - riverCentreZ(a.x);
  const offTarget = t.z - riverCentreZ(t.x);
  const side = riverHasWaterAt(t.x, t.z) ? Math.sign(offFrom) || 1 : Math.sign(offTarget) || 1;
  const lx = Math.max(-halfLen + 0.3, Math.min(halfLen - 0.3, a.x));
  const lz = riverCentreZ(lx) + side * (wWet + 0.35);
  const w = rotXZ(lx, lz, river.rot);
  return { x: river.pos.x + w.x, z: river.pos.z + w.z };
}

export function riverSwimWaypoints(
  items: FurnitureItem[],
  from: { x: number; z: number },
  to: { x: number; z: number },
): Array<{ x: number; z: number }> | null {
  const river = items.find((i) => i.kind === "beach-river");
  if (!river) return null;
  const a = toLocal(river, from.x, from.z);
  const b = toLocal(river, to.x, to.z);
  if (!riverHasWaterAt(a.x, a.z) || !riverHasWaterAt(b.x, b.z)) return null;
  const { wWater } = riverMetrics();
  const lane = Math.max(0.1, wWater - 0.3); // stay this far inside the bank
  const offA = Math.max(-lane, Math.min(lane, a.z - riverCentreZ(a.x)));
  const offB = Math.max(-lane, Math.min(lane, b.z - riverCentreZ(b.x)));
  const steps = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / 0.75));
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const lx = a.x + (b.x - a.x) * t;
    const lz = riverCentreZ(lx) + offA + (offB - offA) * t;
    const w = rotXZ(lx, lz, river.rot);
    out.push({ x: river.pos.x + w.x, z: river.pos.z + w.z });
  }
  return out;
}

/** 🕳️ Kinds that sink BELOW the floor and so need a hole cut in it: every pool,
 *  plus the infinity pool (unswimmable, but its terraces are under floor level). */
export function isFloorCutKind(kind: FurnitureKind): boolean {
  return isPoolKind(kind) || kind === "infinity-pool";
}

/** 🕳️ The floor's hole outlines for these items — the infinity pool's
 *  staircase polygons, else the swim pool's outline. World XZ. Empty when nothing is sunk. */
export function floorCutOutlines(items: FurnitureItem[]): Array<Array<{ x: number; z: number }>> {
  // The UNION: a room can hold a swim pool and an infinity pool at once
  // (edit mode, additive sets), and each needs its hole (Copilot review, PR #169).
  const out: Array<Array<{ x: number; z: number }>> = [];
  if (items.some((i) => i.kind === "infinity-pool")) out.push(...infinityPoolOutlines());
  const outline = poolHoleOutline(items);
  if (outline) out.push(outline);
  return out;
}

export function getPoolBasin(items: FurnitureItem[]): {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  exit: { x0: number; z0: number; x1: number; z1: number };
} | null {
  for (const item of items) {
    if (!isPoolKind(item.kind)) continue;
    if (item.kind === "beach-river") {
      // The band's bounding box. Swim CLAMPING and climb-out both want a
      // rectangle, and over-covering is safe here because ENTRY is gated by
      // poolWaterContains — you cannot start swimming on the dry sand at a
      // bend, you can only drift over it once already in the water.
      const rm = riverMetrics();
      const half = rm.amp + rm.wWater - 0.2;
      const a = rotXZ(-rm.halfLen + 0.4, -half, item.rot);
      const b = rotXZ(rm.halfLen - 0.4, half, item.rot);
      const e1 = rotXZ(-rm.halfLen + 0.4, -(half + 0.9), item.rot);
      const e2 = rotXZ(rm.halfLen - 0.4, half + 0.9, item.rot);
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
 * the pool water actually covers, so the floor is punched to the water's shape
 * (deck cells keep their floor), not a loose bounding box. KIND-AWARE so the
 * hole always matches the water it's cut for:
 *   • classic-pool — a full RECTANGLE (its water is a rect PlaneGeometry), so
 *     every cell in the footprint rect is cut (no organic corners to leak, no
 *     island patch left uncut under the water);
 *   • lazy-pool — the organic lazy-river curve minus the central island, sampled
 *     point-in-poly (the water Shape's y maps to local −z, mesh rotateX(−π/2), so
 *     we test (localX, −localZ)).
 * Empty when there's no pool.
 */
export function poolHoleCells(items: FurnitureItem[]): Set<string> {
  const cells = new Set<string>();
  const pool = items.find((i) => isPoolKind(i.kind));
  if (!pool) return cells;
  const rect = poolHoleRect(items)!; // world bbox of the water footprint

  if (pool.kind === "beach-river") {
    // Analytic band — no polygon sampling needed, the half-width is constant
    // about a known centre line. Bridge cells keep their floor, which is what
    // a bridge IS.
    for (let i = Math.floor(rect.x0); i < Math.ceil(rect.x1); i++) {
      for (let j = Math.floor(rect.z0); j < Math.ceil(rect.z1); j++) {
        if (poolCutContains(items, i + 0.5, j + 0.5)) cells.add(`${i},${j}`);
      }
    }
    return cells;
  }

  if (pool.kind === "classic-pool") {
    // Rectangular water ⇒ rectangular hole: cut cells whose CENTRE lies inside
    // the water rect (the same centre-in-shape rule the lazy sampling uses), so
    // the holes stay ⊆ the water (and ⊆ the pool obstacle — never a walkable hole).
    for (let i = Math.floor(rect.x0); i < Math.ceil(rect.x1); i++) {
      for (let j = Math.floor(rect.z0); j < Math.ceil(rect.z1); j++) {
        const cx = i + 0.5;
        const cz = j + 0.5;
        if (cx >= rect.x0 && cx <= rect.x1 && cz >= rect.z0 && cz <= rect.z1) {
          cells.add(`${i},${j}`);
        }
      }
    }
    return cells;
  }

  const shape = lazyRiverShape();
  const outer = shape.getPoints(64).map((p) => ({ x: p.x, y: p.y }));
  const island = (shape.holes[0]?.getPoints(48) ?? []).map((p) => ({ x: p.x, y: p.y }));
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
 * 🕳️ #80: greedy-merge a set of 1 m cells ("i,j", cell = world [i,i+1]×[j,j+1])
 * into maximal world rects — SHARED by the floor-hole cut (world.ts) and the
 * pool obstacle (buildObstacleList) so the hole and the non-walkable region are
 * byte-identical (you can never walk on a hole).
 */
export function mergeCellsToRects(cells: Set<string>): Box[] {
  const remaining = new Set(cells);
  const rects: Box[] = [];
  const sorted = [...remaining]
    .map((k) => {
      const [i, j] = k.split(",").map(Number);
      return { i, j };
    })
    .sort((a, b) => a.j - b.j || a.i - b.i);
  for (const { i, j } of sorted) {
    if (!remaining.has(`${i},${j}`)) continue;
    let w = 1;
    while (remaining.has(`${i + w},${j}`)) w++;
    let h = 1;
    grow: for (;;) {
      for (let dx = 0; dx < w; dx++)
        if (!remaining.has(`${i + dx},${j + h}`)) break grow;
      h++;
    }
    for (let dz = 0; dz < h; dz++)
      for (let dx = 0; dx < w; dx++) remaining.delete(`${i + dx},${j + dz}`);
    rects.push({ x0: i, z0: j, x1: i + w, z1: j + h });
  }
  return rects;
}

/**
 * 🕳️ #80: the pool water OUTLINE as world-XZ points — the EXACT floor-hole
 * shape, so no solid floor peeks over the water (the blocky 1 m cell holes
 * couldn't match the organic curve). Lazy pool → the lazy-river OUTER curve;
 * classic pool → the water rect. Transformed by the pool's pose. The floor hole
 * is purely visual (the pool OBSTACLE is a separate rect — buildObstacleList),
 * so an organic hole is safe for pathfinding. Null when there's no pool.
 */
export function poolHoleOutline(items: FurnitureItem[]): Array<{ x: number; z: number }> | null {
  const pool = items.find((i) => isPoolKind(i.kind));
  if (!pool) return null;
  let local: Array<{ x: number; z: number }>;
  if (pool.kind === "beach-river") {
    // Down one bank and back along the other — the same centre line the water
    // ribbon is built from, so the cut edge and the water edge coincide.
    // ⚠️ The hole must stay STRICTLY INSIDE the floor's outer ring: a hole
    // touching the outer edge is not a hole to the triangulator
    // (ShapeGeometry/earcut) — the floor comes back as bridging triangles that
    // tilt down into the basin, a steep slope where there should be flat sand.
    // riverMetrics().halfLen already stops RIVER_END_LIP short of the walls.
    const rm = riverMetrics();
    const ring: Array<{ x: number; z: number }> = [];
    for (let i = 0; i <= RIVER_SEGS; i++) {
      const lx = -rm.halfLen + (i / RIVER_SEGS) * rm.halfLen * 2;
      ring.push({ x: lx, z: riverCentreZ(lx) - rm.wWet });
    }
    for (let i = RIVER_SEGS; i >= 0; i--) {
      const lx = -rm.halfLen + (i / RIVER_SEGS) * rm.halfLen * 2;
      ring.push({ x: lx, z: riverCentreZ(lx) + rm.wWet });
    }
    local = ring;
  } else if (pool.kind === "classic-pool") {
    // Rectangular water footprint.
    local = [
      { x: -POOL_WATER_WEST, z: -POOL_WATER_HALFZ },
      { x: POOL_WATER_EAST, z: -POOL_WATER_HALFZ },
      { x: POOL_WATER_EAST, z: POOL_WATER_HALFZ },
      { x: -POOL_WATER_WEST, z: POOL_WATER_HALFZ },
    ];
  } else {
    // Lazy-river OUTER curve, sampled at the SAME resolution as the water mesh
    // (ShapeGeometry(shape, 48)) so the hole edge coincides with the water edge —
    // no floor sliver, no over-cut. The water mesh is rotateX(−π/2), so a shape
    // point (x, y) maps to world-local (x, −y) — the mapping poolHoleCells uses.
    local = lazyRiverShape()
      .getPoints(48)
      .map((p) => ({ x: p.x, z: -p.y }));
  }
  // Local → world by the pool's pose (cardinal rot + offset).
  return local.map((p) => {
    const r = rotXZ(p.x, p.z, pool.rot);
    return { x: pool.pos.x + r.x, z: pool.pos.z + r.z };
  });
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
    if (!isPoolKind(item.kind)) continue;
    if (item.kind === "beach-river") {
      const rm = riverMetrics();
      const half = rm.amp + rm.wWet;
      return localBoxToWorld(item, -rm.halfLen, -half, rm.halfLen, half);
    }
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

// ── 🖥️ Interior wall mounts (the room terminal) ───────────────────────────────

/** Does this kind hang on an interior wall rather than stand on the floor? */
export function isWallMounted(kind: FurnitureKind): boolean {
  return FURNITURE_DEFS[kind].wallMount !== undefined;
}

/** Gap from the wall plane to a mounted panel's origin — the flush-mount
 *  inset the wall computer has always used (its 0.12 m housing straddles the
 *  plane, so the screen face ends up just inside the room). */
const WALL_MOUNT_INSET = 0.03;

/**
 * The rot that faces a wall-mounted panel INTO the room, per wall. The panel's
 * local +z is its screen, and rot is a CCW quarter-turn about +y, so: north
 * wall (z=-half) wants +z ⇒ rot 0; east (x=+half) wants -x ⇒ rot 3; south
 * (z=+half) wants -z ⇒ rot 2; west (x=-half) wants +x ⇒ rot 1.
 */
const WALL_MOUNT_ROT: Record<DoorWall, Rot> = {
  'y-': 0, // engine −Z wall wants +z ⇒ rot 0
  'x+': 3,
  'y+': 2,
  'x-': 1,
};

/** Which wall a wall-mounted item at `rot` is hanging on (inverse of the map
 *  above) — lets the validators ask "is this the north wall?" from a pose. */
export function wallOfMountRot(rot: Rot): DoorWall {
  return rot === 0 ? "y-" : rot === 3 ? "x+" : rot === 2 ? "y+" : "x-";
}

/**
 * Snap a raw floor point to the nearest wall for a wall-mounted kind. The item
 * lands on that wall's flush-mount plane, its along-wall coordinate snaps to
 * the 0.5 m half-grid (clamped so the whole panel stays on the wall), and its
 * rotation is DERIVED from the wall so the screen always faces into the room.
 *
 * The exact interior mirror of hull.snapExteriorPos — and, like a door drag,
 * the pose is 1-D: you choose a wall and a position along it, never a free
 * point in the room. Returns null for kinds that aren't wall-mounted.
 */
export function snapInteriorWall(
  kind: FurnitureKind,
  x: number,
  z: number,
): { x: number; z: number; rot: Rot } | null {
  const spec = FURNITURE_DEFS[kind].wallMount;
  if (!spec) return null;
  const { halfX, halfZ } = roomHalfExtents();

  // Nearest wall wins. Ties fall through to the z walls (north/south), which
  // is where the terminal lives by default.
  const dYneg = Math.abs(z + halfZ);
  const dYpos = Math.abs(halfZ - z);
  const dXneg = Math.abs(x + halfX);
  const dXpos = Math.abs(halfX - x);
  const min = Math.min(dYneg, dYpos, dXneg, dXpos);
  const wall: DoorWall =
    min === dYpos ? "y+" : min === dYneg ? "y-" : min === dXpos ? "x+" : "x-";

  // Along-wall snap, clamped to the last half-grid stop that (a) keeps the
  // panel fully on the wall and (b) leaves the panel's stand-point on a
  // WALKABLE cell.
  //
  // (b) is not decoration. The device front sits at the same along-coordinate
  // as the panel, and worldToCol/Row floor(), so a point on the 0.5 m lattice
  // always resolves to the cell whose centre is 0.25 m FURTHER OUT. Clamping
  // only by (a) therefore hands the user a stop whose front cell is outside
  // the walkable bound — and only at the +x/+z end, since the floor() bias is
  // one-directional. The result was a wall whose east half accepted the
  // terminal and whose west half silently refused it (or vice versa),
  // including at the very stop the clamp itself offered.
  const alongHalf = wall === "y-" || wall === "y+" ? halfX : halfZ;
  const { boundX, boundZ } = roomWalkBounds();
  const alongBound = wall === "y-" || wall === "y+" ? boundX : boundZ;
  const stop = Math.min(
    Math.floor((alongHalf - spec.halfW) * 2) / 2,
    Math.floor((alongBound - CELL / 2) * 2) / 2,
  );
  const along = Math.max(-stop, Math.min(stop, Math.round((wall === "y-" || wall === "y+" ? x : z) * 2) / 2));

  const plane = (h: number) => h - WALL_MOUNT_INSET;
  const rot = WALL_MOUNT_ROT[wall];
  switch (wall) {
    case "y-": return { x: along, z: -plane(halfZ), rot };
    case "y+": return { x: along, z: plane(halfZ), rot };
    case "x-": return { x: -plane(halfX), z: along, rot };
    case "x+": return { x: plane(halfX), z: along, rot };
  }
}

/**
 * The thin slab a wall-mounted panel occupies on its wall. NOT an obstacle —
 * wall-mounted kinds keep `footprint: null` and never block the floor — this
 * is only the volume the placement gate tests against doorways, windows and
 * other furniture, so the terminal can't be re-hung inside a bookcase, behind
 * the bar, or across a door frame. Depth is generous (±0.15) so a flush mount
 * still registers as overlapping whatever it is buried in.
 */
export function wallMountBox(
  kind: FurnitureKind,
  pos: { x: number; z: number },
  rot: Rot,
): Box | null {
  const spec = FURNITURE_DEFS[kind].wallMount;
  if (!spec) return null;
  const D = 0.15;
  const alongX = rot % 2 === 0; // north/south walls run along x
  const hw = alongX ? spec.halfW : D;
  const hd = alongX ? D : spec.halfW;
  return { x0: pos.x - hw, z0: pos.z - hd, x1: pos.x + hw, z1: pos.z + hd };
}

/** A wall-mounted panel's half-width along its wall (0 for other kinds) — the
 *  span the doorway/window clearance checks measure against. */
export function wallMountHalfWidth(kind: FurnitureKind): number {
  return FURNITURE_DEFS[kind].wallMount?.halfW ?? 0;
}

/** Is this kind the ROOM TERMINAL — the device whose focused UI hosts the
 *  EDIT ROOM button, and therefore the one piece of furniture that must never
 *  be removable (see editMode.removeSelected)? */
export function isRoomTerminalKind(kind: FurnitureKind): boolean {
  return FURNITURE_DEFS[kind].device?.kind === "roomTerminal";
}

/**
 * The device stand-point this kind WOULD have at (pos, rot) — the same
 * derivation buildDeviceList performs after a commit (rotated template front,
 * with computeFront's nearest-usable fallback), exposed so the placement gate
 * can check that a moved device still has somewhere to be used from. Returns
 * null for kinds with no device template.
 */
export function deviceFrontFor(
  kind: FurnitureKind,
  pos: { x: number; z: number },
  rot: Rot,
  aabb: Box | null,
  isWalkable: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  const t = FURNITURE_DEFS[kind].device;
  if (!t) return null;
  const fr = rotXZ(t.front.x, t.front.z, rot);
  return computeFront({ x: pos.x + fr.x, z: pos.z + fr.z }, aabb, isWalkable);
}

/** Derive the collision obstacle list (order = FURNITURE order). */
export function buildObstacleList(items: FurnitureItem[]): Box[] {
  const boxes: Box[] = [];
  for (const item of items) {
    const multi = FURNITURE_DEFS[item.kind].obstacleBoxes;
    if (multi) {
      boxes.push(...multi(item, items));
      continue;
    }
    const box = itemAabb(item);
    if (box) boxes.push(box);
  }
  return boxes;
}
// 🕳️ #80 NOTE: the pool's obstacle stays the (safe, established) water rect
// footprintOverride — which fully CONTAINS the precise water-cell floor holes,
// so you can never walk on a hole ("swim not walk" holds) and swim entry keeps
// working via the seat jump-in + getPoolBasin auto-swim. Making the obstacle
// itself cell-precise was walked back: it freed deck cells INSIDE the basin
// rect, and the auto-swim net (keyed on that rect) would then swim a walker on
// dry tile. Reconciling auto-swim to poolHoleCells is a follow-up (needs a live
// pool room to verify the swim/jump-in against the true water cells).

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
        firstPerson: t.firstPerson ?? false,
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
    const eye = rotXZ(t.eye.x, t.eye.z, item.rot);
    const anchor = rotXZ(t.anchor.x, t.anchor.z, item.rot);
    devices.push({
      id: item.id,
      kind: t.kind,
      // Via deviceFrontFor, NOT a second inline copy of the same derivation:
      // the edit-mode placement gate calls it to predict where this line will
      // put the stand-point after a commit, and that prediction is only worth
      // anything while both sides are literally the same code.
      front: deviceFrontFor(item.kind, item.pos, item.rot, itemAabb(item), isWalkable)!,
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
    itemId: item.id,
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
      if ((obj as THREE.Mesh).isMesh && !obj.userData.skipDeviceHit) {
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
