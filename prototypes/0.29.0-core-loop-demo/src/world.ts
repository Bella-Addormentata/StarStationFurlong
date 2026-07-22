/**
 * World/Room Management
 * Handles room creation and game world state with planet-to-platform morphing.
 * Includes a click-navigation plane for point-and-click pathfinding.
 */

import * as THREE from "three";
// 🚪↦ One-way door policy reads (hint flavor + the arrival turnstile).
import { readDoorPolicy } from "./doorPolicy";
import { physicalDoorPose, setActiveDoorLayout } from "./doorLayout";
import { Player } from "./player";
import {
  PoolWaiter,
  POOL_PATROL,
  LOBBY_PATROL,
  CASINO_PATROL,
} from "./poolWaiter";
import { InputManager } from "./input";
import { findSeatAt, rebuildSeats, SEATS } from "./seats";
import { STANDS, rebuildStands, standsForItem } from "./stands";
import { readTableState } from "./casinoDoc";
import {
  beatCroupier,
  canRunCroupier,
  closeTable,
  croupierBeatLine,
  HEARTBEAT_MS,
  isCroupierLive,
  tickAutoCroupier,
} from "./croupier";
import { spawnFixedBubble } from "./chatBubbles";
import { readRobotConfig, subscribeRobot } from "./robotDoc";
import type { RobotRoutine } from "./robotDoc";
import type { StandSlot } from "./furniture";
import { getDefaultRoomId } from "./identity";
import {
  FURNITURE,
  FURNITURE_DEFS,
  DEFAULT_FOOTPRINT_OVERRIDES,
  buildItemGroup,
  furnitureVisualYaw,
  BUNK_TOP_Y,
  rotXZ,
  CASINO_ROOM_ID,
  OUTDOOR_CASINO_ROOM_ID,
  legacyThemeFromRoomId,
  POOL_SWIM_Y,
  POOL_WATER_Y,
  DIVE_TIME,
  DIVE_ARC_LIFT,
  bridgeDeckY,
  poolHoleCells,
  mergeCellsToRects,
} from "./furniture";
import type { FurnitureItem, RoomTheme } from "./furniture";
import { northDoorUnlocked } from "./stationParts";
import { rebuildObstacles } from "./obstacles";
import {
  rebakeWalkableGrid,
  walkable,
  worldToRow,
  worldToCol,
  colToWorld,
  rowToWorld,
  findPath,
} from "./pathfinding";
import { subscribeFurniture, readAllFurniture } from "./furnitureDoc";
import {
  subscribeDoors,
  readAllDoors,
  writeDoorPairing,
  deleteDoorPairing,
  type DoorRecord,
} from "./doorsDoc";
import { readDoorDeltas, roomHalfExtents } from "./floorPlanDoc";
import { applyDoorSlideDeltas } from "./doors";
import { setDoorSlideDeltas } from "./adapter";
import { roomIdFromSeed } from "./stationAtlas";
import type { FurnitureRecord } from "./furnitureDoc";
import { findDoor, DOORS, rebuildDoors } from "./doors";
import type { DoorId, DoorTarget, DoorSequenceHooks } from "./doors";
import { subscribeDoorLayout, readAllDoorLayout } from "./doorLayoutDoc";
import type { DoorLayoutRecord } from "./doorLayoutDoc";
import {
  buildVestibule,
  buildConnectorChain,
  setVestibuleLightState,
  setVestibuleOpacity,
} from "./adapter";
import {
  findDevice,
  rebuildDevices,
  createRoomTerminalUI,
  createMapTableUI,
  createStorageTrunkUI,
  createGameTableUI,
  createHelmUI,
  createCashierUI,
  createRouletteUI,
  createRobotDockUI,
  createCloneVatUI,
  readLiveRoomStatus,
} from "./devices";
import { preferredSpawnVat, setPreferredSpawnVat } from "./spawnPoint";
import type {
  WallScreenHandle,
  TrunkLidHandle,
  GameTableTopHandle,
  CloneVatHandle,
  DeviceTarget,
} from "./devices";
import { subscribeGames, readGame } from "./games/gamesDoc";
import { deviceFocus } from "./deviceFocus";
import { roomEdit, canEditRoom } from "./editMode";
import { showHint } from "./hud";
import { DoorDockingPortSystem } from "./docking";
import { VoxelCharacter, OUTLINE_MAT, snapTo8Ways } from "./voxelCharacter";
import { getOutfitById, saveOutfitId } from "./outfits";
import type { OutfitDef } from "./outfits";
import { buildOctagonHull } from "./octagonHull";
import type {
  OctagonHull,
  HullWindows,
  WindowOpening,
} from "./octagonHull";
import { getCameraYaw } from "./cameraRig";

/**
 * A networked peer replica: a full fox rig plus interpolation state (issue #21
 * — remote players render as the avatar character, not a red sphere).
 */
interface RemoteAvatar {
  rig: VoxelCharacter;
  /** Latest network position (lerp target). */
  targetX: number;
  targetZ: number;
  /** Previous frame's rendered position — used for heading derivation. */
  lastX: number;
  lastZ: number;
  /** Sender-reported moving flag (movement tick flags bit0). */
  moving: boolean;
  /** #63: sender-reported seated flag (movement tick flags bit1). */
  seated: boolean;
  /** #63: seated world facing (tick yaw when seated) — orients the sit pose. */
  facing: number;
  /** 🛏️ sender-reported lie-down flag (tick flags bit2) — 'sleep' pose. */
  lying: boolean;
  /** 🛏️ berth elevation lerp target (BUNK_TOP_Y when tick flags bit3). */
  elevY: number;
  /** Last known 8-way facing (radians, π/4 steps). */
  heading: number;
  /** 🏊 sender-reported swim flag (tick flags bit4) — 'swim' pose in the pool. */
  swimming: boolean;
  /** 🏊‍♂️ sender-reported dive flag (tick flags bit5) — mid parabolic arc. */
  diving: boolean;
  /** 🏊‍♂️ local arc clock (seconds since bit5 rose); null when not diving. */
  diveAge: number | null;
  /** 🏊‍♂️ replica y at arc start — the receiver replays its own parabola. */
  diveStartY: number;
}

/** 🛑📐 #80 S1: render each room as an OCTAGON barrel (walls + 45° roof +
 *  basement) instead of the flat open-top box. Preview-gated OFF by default —
 *  `?octagon=1` turns it on so collaborators can see the new shell without
 *  changing any existing room. Same URL-flag idiom as ?devzoom / ?vestibule. */
const OCTAGON_HULL =
  new URLSearchParams(window.location.search).get("octagon") === "1";

export class World {
  private scene: THREE.Scene;
  private player: Player;
  private platformGroup: THREE.Group;
  private stationPlanet: THREE.Mesh | null = null;
  private platformFloor: THREE.Mesh | null = null;
  /** 🛑📐 #80: XZ rectangles cut out of the solid floor (a pool sinks into the
   *  basement through the hole). Empty ⇒ a plain solid floor plane. */
  private floorHoles: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];
  /** JSON of the last-applied floorHoles ("[]" = the initial solid floor) —
   *  skips redundant geometry rebuilds. */
  private floorHolesKey = "[]";
  /** A standalone demo hole (`?octagon=1&hole=1`), merged with the pool hole by
   *  refreshOutdoorFloor so both survive its rebuilds. */
  private demoFloorHole: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private platformGrid: THREE.GridHelper | null = null;
  private platformElements: THREE.Object3D[] = [];
  private sideWalls: THREE.Mesh[] = [];
  /** 🚪 Glassy north wall backing the paired doors (no coverage rule). */
  private northWall: THREE.Mesh | null = null;
  /** 🤖 #77C: service/croupier robots, keyed by the CHARGING-DOCK item id they
   *  belong to — one robot per placed dock. A room with NO dock has NO robot
   *  (owner request 2026-07-21: robots come ONLY from the docking system). */
  private robots = new Map<string, PoolWaiter>();
  /** Route the live robots were built with — a change rebuilds them all. */
  private robotsPatrol: Array<[number, number]> | null = null;
  /** 🎰🤖 #77B croupier: wall-clock ms of the last operator heartbeat write, and
   *  the last narration beat spoken per table (edge-detect one bubble per beat). */
  private croupierLastBeatAt = 0;
  private croupierNarrated = new Map<string, string>();
  /** 🤖 #77C: which robot (dock key) is the current croupier — sticky so a
   *  second robot doesn't dance toward the wheel before one "wins" nearest. */
  private croupierRobotKey: string | null = null;
  private morphProgress = 0;
  private isMorphing = false;
  private morphDuration = 2.0; // seconds
  private time = 0; // For animations
  // Spinning orbital rings above the platform
  private orbitRingOuter: THREE.Mesh | null = null;
  private orbitRingInner: THREE.Mesh | null = null;
  // Dynamic outer structural elements (Roof & complete outer hull walls for Level 3 visual context)
  private capsuleRoof: THREE.Mesh | null = null;
  private capsuleOuterWalls: THREE.Mesh[] = [];
  // 🛑📐 #80 S1: the octagon hull barrel (only built under the ?octagon=1 flag).
  private octagonHull: OctagonHull | null = null;
  // Active interactive docking doors subsystem
  public dockingSystem: DoorDockingPortSystem | null = null;
  // ── Adapter transit (T1 of issue #30) ───────────────────────────────────────
  /**
   * Room-swap driver, wired by main.ts (callback pattern — world must not
   * import main). Receives the paired door's seed string and the departure
   * door id when the avatar reaches the vestibule hold point (mid-HOLD).
   * Transit is only offered on paired doors when this is non-null.
   */
  public onAdapterTransit:
    | ((seed: string, departureDoorId: DoorId) => void)
    | null = null;
  /**
   * Transit-latch mirror, wired by main.ts beside onAdapterTransit (review
   * fix F4): true while a swap is in flight. A paired-door click then falls
   * through to the normal peek round-trip — beginTransit would spawn a
   * vestibule whose swap request the busy driver silently drops (never
   * completed, never failed, never disposed).
   */
  public isTransitBusy: (() => boolean) | null = null;
  /**
   * Persistent gangway vestibules, one per PAIRED door (#51). Spawned the
   * frame a door's pairing completes, resting lightly translucent and
   * solidifying as the player approaches; disposed on unpair / morph restart.
   * A transit rides the SAME instance (no separate transit vestibule) — the
   * 'cycling'/'fault' lights only run while the transit is in flight.
   */
  private pairedVestibules: Map<DoorId, THREE.Group> = new Map();
  /** Door whose vestibule is lit for an in-flight transit, or null. */
  private transitVestibuleDoorId: DoorId | null = null;
  /** Resting opacity of a paired-door vestibule when the player is far.
   *  0 — the ghost gangways read as a pile of dark capsules outside the
   *  walls (owner request: remove them from view); the tube still fades in
   *  on approach and goes solid during a transit. */
  private static readonly VESTIBULE_BASE_OPACITY = 0;
  /** Proximity fade range (m from the door's front stand-point). */
  private static readonly VESTIBULE_FADE_RANGE = 4.0;
  // Lobby furniture (fades in to full opacity)
  private furnitureMeshes: THREE.Mesh[] = [];
  private furnitureLights: Array<{
    light: THREE.PointLight;
    targetIntensity: number;
  }> = [];
  /** One group per furniture item, keyed by item id (selection/movement — E2+). */
  public furnitureGroups: Map<string, THREE.Group> = new Map();
  /** Live wall-computer screens, keyed by item id (M1 — driven at ~1 Hz). */
  private wallScreens: Map<string, WallScreenHandle> = new Map();
  /** Accumulator for the 1 Hz wall-screen status redraw. */
  private screenStatusTimer = 0;
  /** Holo-ring spinners (M4 map table) — meshes tagged userData.holoSpin. */
  private holoSpinners: Array<{ mesh: THREE.Mesh; speed: number }> = [];
  /** Animated trunk lids, keyed by item id (TR2 — driven every frame). */
  private trunkLids: Map<string, TrunkLidHandle> = new Map();
  /** 🧬 Clone-vat tanks, keyed by item id (driven every frame like the lids). */
  private cloneVats: Map<string, CloneVatHandle> = new Map();
  /** 🧬 Boot spawn queued at morph-complete, run at the first room-level view. */
  private pendingVatSpawn = false;
  /** 🧬 True once the queued spawn has seen the exterior boot view (zoom ≥ 3)
   *  — the PRIMARY arming signal: the reveal then fires on the zoom-in
   *  transition, however long the v0.32.20 auto-boot's join-under-intro takes
   *  to flip the view (a fixed grace lost that race on slow joins and the
   *  ceremony played unseen behind the intro). */
  private vatSawExterior = false;
  /** 🧬 Fallback arming grace for paths where no exterior boot ever flips the
   *  zoom (legacy boots, missing multiScaleZoom) — long, because it only
   *  exists so the clone can't be held forever. */
  private pendingVatSpawnGrace = 0;
  /** Flippable game-table tops, keyed by item id (#45 — driven every frame). */
  private gameTableTops: Map<string, GameTableTopHandle> = new Map();
  // Atmosphere effects (animated each frame)
  private particleGeo: THREE.BufferGeometry | null = null;
  private particlePositions: Float32Array | null = null;
  private particleMat: THREE.PointsMaterial | null = null;
  // ── 💦 One-shot splash bursts (pool water entry) ──────────────────────────
  private splashes: Array<{
    points: THREE.Points;
    geo: THREE.BufferGeometry;
    mat: THREE.PointsMaterial;
    vel: Float32Array;
    age: number;
    life: number;
  }> = [];
  /** Invisible plane covering the walkable floor — used as the raycast target. */
  private clickPlane: THREE.Mesh | null = null;
  /** 🏝️ Stored floor material for dynamic outdoor/lobby theme swap. */
  private floorMat: THREE.MeshStandardMaterial | null = null;
  /** Original lobby wood texture — saved once, restored on return from outdoor room. */
  private woodTex: THREE.Texture | null = null;
  /** Lazy-created outdoor stone tile texture (created on first outdoor entry). */
  private outdoorFloorTex: THREE.Texture | null = null;
  /** Lazy-created casino carpet texture (created on first casino entry). */
  private casinoFloorTex: THREE.Texture | null = null;
  /** True while the active room is the outdoor casino pool room. */
  private isOutdoorRoom = false;
  /** 🌌 True while the active room's THEME is 'outdoor-deck' (space seen through
   *  the glass ceiling + warm bright light). Independent of isOutdoorRoom —
   *  ANY module can be a deck via its roomInfo theme. Drives the space backdrop
   *  visibility toggle in applyRoomVisuals. */
  private isOutdoorDeck = false;
  /** 🪐 Overhead ocean-planet for the outdoor-deck backdrop — the "beach" world
   *  the station orbits, seen up through the skylights. Built once, spun slowly,
   *  shown only for the deck theme. */
  private deckPlanet: THREE.Group | null = null;
  /** 🎰 Edit-mode-only floor rings marking table STANDING positions (#76): one
   *  ring per STANDS slot (amber = reserved wheel-head, cyan = open), shown
   *  ONLY while room-editing so the owner sees where the stand slots land as a
   *  table is moved. A reused pool of rings; positioned from STANDS each frame. */
  private standMarkers: THREE.Group | null = null;
  /** 🏊 "POOL & HOT TUB" sign over the lobby's south door (lazy-built). */
  private poolSign: THREE.Group | null = null;
  /** 🎰 Gold "CASINO" lintel over the east door's physical slot. */
  private casinoSign: THREE.Group | null = null;
  /** Return-wayfinding engraving for the lobby door in casino/pool rooms. */
  private lobbySign: THREE.Group | null = null;
  /** Text-only LOBBY carving applied directly to the casino return door. */
  private casinoLobbySign: THREE.Group | null = null;
  /** Casino-only marquee and colored ceiling lights (lazy-built). */
  private casinoDecor: THREE.Group | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.platformGroup = new THREE.Group();
    this.platformGroup.position.set(0, 0, 0);
    this.scene.add(this.platformGroup);

    // Create the station as a mini planet initially
    this.createStationPlanet();

    // Create player (will be shown after morph)
    this.player = new Player(this.scene);
    this.player.mesh.visible = false;

    // 🤖 #77C s3: re-drive robot routines the instant a dock console edit syncs
    // (no furniture reconcile needed). Lifetime subscription (one World).
    subscribeRobot(() => this.applyRobotRoutines());

    // 💦 Pool water entry → splash burst at the surface (big = dive landing).
    this.player.onWaterEntry = (x, y, z, big) => this.spawnSplash(x, y, z, big);

    // Furniture layout sync (issue #60 E4): reconcile the local room to the
    // shared `furniture` map whenever it changes. Subscribed ONCE here (not per
    // morph) — furnitureDoc re-notifies on every room (re)bind, and reconcile
    // is a no-op until the platform exists (empty map / no groups yet).
    subscribeFurniture(() => this.reconcileFurniture(readAllFurniture()));

    // Door-pairing sync (issue #64): reconcile docked-module pairings from the
    // shared `doors` map whenever it changes. Subscribed ONCE here — doorsDoc
    // re-notifies on every room (re)bind, and reconcile is a no-op until the
    // docking system exists.
    subscribeDoors(() => this.reconcileDoors(readAllDoors()));

    // Door-LAYOUT sync (#28 S4): reconcile WHICH doors the room has from the
    // shared `doorLayout` map. Subscribed ONCE here — doorLayoutDoc re-notifies
    // on every room (re)bind, and reconcile no-ops until the docking system
    // exists / the map is seeded (un-migrated rooms keep the cardinal defaults).
    subscribeDoorLayout(() => this.reconcileDoorLayout(readAllDoorLayout()));

    console.log("✅ World initialized - Station planet ready");
  }

  /**
   * Create station as a mini planet hanging on the galaxy spiral
   */
  private createStationPlanet() {
    // Load Mars texture
    const textureLoader = new THREE.TextureLoader();

    // Create a small glowing planet (Mars-style station)
    const planetGeometry = new THREE.SphereGeometry(2, 64, 64);
    const planetMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.1,
      emissive: 0x331100,
      emissiveIntensity: 0.2,
    });

    // Load Mars texture asynchronously
    textureLoader.load(
      "/assets/mars.png",
      (texture) => {
        // Nearest-neighbour keeps the texture crisp in the pixelated renderer.
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        planetMaterial.map = texture;
        planetMaterial.needsUpdate = true;
        console.log("✅ Mars texture loaded");
      },
      undefined,
      (_error) => {
        console.warn("⚠️ Mars texture not found, using fallback color");
        planetMaterial.color.setHex(0xd84315);
      },
    );

    this.stationPlanet = new THREE.Mesh(planetGeometry, planetMaterial);
    this.stationPlanet.position.set(0, 0, 0);
    this.platformGroup.add(this.stationPlanet);

    // Add subtle atmosphere glow (Mars-like)
    const glowGeometry = new THREE.SphereGeometry(2.15, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6644,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    this.stationPlanet.add(glow);

    // Add ring around planet (station orbit ring)
    const ringGeometry = new THREE.RingGeometry(2.5, 2.7, 64);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x1e88e5,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    this.stationPlanet.add(ring);

    // Add subtle point light (Mars doesn't emit much light)
    const planetLight = new THREE.PointLight(0xff6633, 0.3, 15);
    planetLight.position.set(0, 0, 0);
    this.stationPlanet.add(planetLight);

    // Orbital rings — children of Mars so they follow its position
    this.orbitRingOuter = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.22, 20, 80),
      new THREE.MeshBasicMaterial({
        color: 0x00ffee,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.orbitRingOuter.rotation.x = Math.PI * 0.28; // tilted orbital plane
    this.stationPlanet.add(this.orbitRingOuter);

    this.orbitRingInner = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.16, 20, 80),
      new THREE.MeshBasicMaterial({
        color: 0xff8800,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.orbitRingInner.rotation.x = -Math.PI * 0.18;
    this.orbitRingInner.rotation.z = Math.PI * 0.12;
    this.stationPlanet.add(this.orbitRingInner);

    console.log(
      "✅ Station planet created (Mars-style) - hanging on galaxy spiral",
    );
  }

  /**
   * Create the full platform (called during morph)
   */
  private createPlatform() {
    // 🧱 #66 R1: the room is a rectangle of half-extents (halfX, halfZ); floor
    // + shell derive from these. Default 2×2 room ⇒ {6,6} ⇒ 12×12, reproducing
    // every legacy literal below bit-for-bit.
    const { halfX, halfZ } = roomHalfExtents();
    const platformW = 2 * halfX,
      platformD = 2 * halfZ;

    // Floor - warm light oak herringbone wood (solid, minus any pool holes)
    const floorGeometry = this.makeFloorGeometry();

    // Build a canvas herringbone wood texture
    const makeWoodTexture = (): THREE.CanvasTexture => {
      const CW = 512,
        CH = 512;
      const cv = document.createElement("canvas");
      cv.width = CW;
      cv.height = CH;
      const ctx = cv.getContext("2d")!;

      // plank tile: 96px wide × 32px tall
      const PW = 96,
        PH = 32,
        GAP = 2;
      // base fill
      ctx.fillStyle = "#D4A86A";
      ctx.fillRect(0, 0, CW, CH);

      const drawPlank = (
        x: number,
        y: number,
        w: number,
        h: number,
        seed: number,
      ) => {
        // base plank colour — vary slightly per plank for realism
        const v = (seed % 5) * 8;
        const r = 196 + v,
          g = (154 + v * 0.6) | 0,
          b = (88 + v * 0.3) | 0;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x + GAP, y + GAP, w - GAP, h - GAP);
        // grain lines
        ctx.strokeStyle = `rgba(0,0,0,0.07)`;
        ctx.lineWidth = 0.8;
        for (let i = 1; i < 4; i++) {
          const gx = x + GAP + (w - GAP) * (i / 4);
          ctx.beginPath();
          ctx.moveTo(gx, y + GAP);
          ctx.lineTo(gx + 2, y + h);
          ctx.stroke();
        }
        // highlight top edge
        ctx.fillStyle = "rgba(255,255,230,0.12)";
        ctx.fillRect(x + GAP, y + GAP, w - GAP, 3);
        // shadow bottom edge
        ctx.fillStyle = "rgba(0,0,0,0.10)";
        ctx.fillRect(x + GAP, y + h - 3, w - GAP, 3);
      };

      // Herringbone: alternating horizontal and vertical planks in 2×1 tiles
      const TW = PW,
        TH = PH; // horizontal plank size
      let seed = 0;
      for (let row = -1; row * TH < CH + TH; row++) {
        for (let col = -1; col * TW < CW + TW; col++) {
          const tx = col * TW,
            ty = row * TH;
          if ((row + col) % 2 === 0) {
            // horizontal plank
            drawPlank(tx, ty, PW, PH, seed++);
          } else {
            // vertical plank (rotated: tall and narrow)
            drawPlank(tx, ty, PH, PW, seed++);
          }
        }
      }

      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      // Scale the repeat with the plane so plank size stays constant in world
      // space (3.5 over 12 m for the default room; bigger rooms tile more).
      tex.repeat.set((3.5 * platformW) / 12, (3.5 * platformD) / 12);
      // Point (nearest-neighbour) sampling — preserves sharp pixel edges when
      // the low-res framebuffer is scaled up by the pixelation pass.
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      return tex;
    };

    const floorMaterial = new THREE.MeshStandardMaterial({
      map: makeWoodTexture(),
      roughness: 0.78,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
    });
    this.floorMat = floorMaterial; // 🏝️ kept for applyRoomVisuals swaps
    this.woodTex = floorMaterial.map; // save original wood texture for restoration
    this.platformFloor = new THREE.Mesh(floorGeometry, floorMaterial);
    this.platformFloor.rotation.x = -Math.PI / 2;
    this.platformGroup.add(this.platformFloor);

    // 🛑📐 #80: pool-hole cutter — exposed for testing + a demo hole under
    // `?octagon=1&hole=1` (the floor is solid otherwise). The pool furniture /
    // template will drive this for real in a later slice.
    (
      window as unknown as {
        __ssfSetFloorHoles?: (
          h: Array<{ x0: number; z0: number; x1: number; z1: number }>,
        ) => void;
      }
    ).__ssfSetFloorHoles = (h) => this.setFloorHoles(h ?? []);
    if (
      OCTAGON_HULL &&
      new URLSearchParams(window.location.search).get("hole") === "1"
    ) {
      this.demoFloorHole = {
        x0: -halfX + 1,
        z0: -halfZ + 1.5,
        x1: -0.6,
        z1: halfZ - 1.5,
      };
      this.refreshOutdoorFloor();
    }

    // ── Click-navigation plane ────────────────────────────────────────────────
    // Invisible horizontal plane covering the walkable floor used as the
    // raycast hit target for point-and-click navigation.
    const clickGeo = new THREE.PlaneGeometry(platformW, platformD);
    clickGeo.rotateX(-Math.PI / 2);
    const clickMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this.clickPlane = new THREE.Mesh(clickGeo, clickMat);
    this.clickPlane.position.y = 0.005; // just above the floor
    this.clickPlane.userData = { isTile: true };
    this.platformGroup.add(this.clickPlane);

    // Grid helper (invisible by default; GridHelper is square-only, so size it
    // to the larger dimension at 1 m divisions — default room stays 12/12).
    const gridSpan = Math.max(platformW, platformD);
    this.platformGrid = new THREE.GridHelper(
      gridSpan,
      gridSpan,
      0x1e88e5,
      0x0a1e3a,
    );
    this.platformGrid.position.y = 0.01;
    this.platformGrid.visible = false;
    this.platformGroup.add(this.platformGrid);

    // Add corner markers and edges
    this.addCornerMarkers();
    this.addPlatformEdgeLights();
    // 🛑📐 #80 S1: the octagon hull REPLACES the two flat interior side walls
    // with the full barrel (walls + 45° roof + basement) when previewing.
    // The exterior capsule (zoom ≥ 3) is left untouched either way.
    if (OCTAGON_HULL) {
      this.addOctagonHull();
    } else {
      this.addSideWalls();
    }
    this.addCapsuleOuterStructure();
    this.addLobbyFurniture();
    this.addAtmosphereEffects();

    // Construct and build 4-Directional sliding door docking ports natively!
    this.initializeDockingPorts();

    // Floor-plan work: initial north-door state honors the (default) fireplace
    // position — and the local owner's move path re-runs this via reconcile.
    this.updateNorthDoorForFireplace();
    this.updateSideWallCoverage();

    // 🪟 The view outside (owner request): a distant planet + its glow hang
    // off the room's open/left side — what you see through a window-wall's
    // glass (or an opened wall) at ROOM level, without waiting for zoom 3.
    {
      const ambient = new THREE.Mesh(
        new THREE.SphereGeometry(16, 32, 24),
        new THREE.MeshStandardMaterial({
          color: 0x2a5a8f,
          roughness: 0.9,
          metalness: 0.05,
          emissive: 0x0c2038,
          emissiveIntensity: 0.55,
        }),
      );
      ambient.name = "ambientPlanet";
      ambient.position.set(-70, -10, -28);
      this.platformGroup.add(ambient);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(16.8, 32, 24),
        new THREE.MeshBasicMaterial({
          color: 0x7fb8ff,
          transparent: true,
          opacity: 0.08,
          side: THREE.BackSide,
        }),
      );
      glow.position.copy(ambient.position);
      this.platformGroup.add(glow);
    }

    // 🪐 Overhead OCEAN-PLANET for the outdoor-deck theme: a big blue world the
    // station orbits, hanging high in the +y sky so it's seen up through the
    // skylights (and looms in the upper backdrop at the iso view). Its ocean
    // blue is the "beach" note while staying 100% space-consistent. fog=false
    // so it stays crisp; hidden until applyRoomVisuals flips the deck theme on.
    {
      const deck = new THREE.Group();
      deck.name = "deckPlanet";
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(60, 48, 36),
        new THREE.MeshStandardMaterial({
          color: 0x2f6aa0,
          roughness: 0.85,
          metalness: 0.04,
          emissive: 0x143a63,
          emissiveIntensity: 0.6,
          fog: false,
        } as THREE.MeshStandardMaterialParameters & { fog: boolean }),
      );
      // Faint swirled cloud band (a lighter shell, additive-ish via low opacity).
      const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(60.6, 48, 36),
        new THREE.MeshStandardMaterial({
          color: 0xbfe4ff,
          roughness: 1.0,
          metalness: 0.0,
          transparent: true,
          opacity: 0.16,
          fog: false,
        } as THREE.MeshStandardMaterialParameters & { fog: boolean }),
      );
      // Soft atmosphere halo.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(64, 48, 36),
        new THREE.MeshBasicMaterial({
          color: 0x7fc8ff,
          transparent: true,
          opacity: 0.14,
          side: THREE.BackSide,
          fog: false,
        } as THREE.MeshBasicMaterialParameters & { fog: boolean }),
      );
      deck.add(planet, clouds, halo);
      // High and toward the back so it's seen up through the skylights in first
      // person AND looms in the upper backdrop at the iso view.
      deck.position.set(14, 60, -84);
      deck.visible = false;
      this.deckPlanet = deck;
      this.platformGroup.add(deck);
    }

    // (orbital rings live on the Mars sphere — created in createStationPlanet)
  }

  /**
   * Add transparent side walls on the left (X=-6) and right (X=+6) sides.
   */
  private addSideWalls() {
    // 🧱 #66 R1: the left wall runs the full Z span (2·halfZ); the north wall
    // runs the full X span (2·halfX). Default 2×2 room ⇒ both 12.
    const { halfX, halfZ } = roomHalfExtents();
    const wallDepth = 2 * halfZ; // left/right wall run (Z)
    const wallSpanX = 2 * halfX; // north wall run (X)
    const wallHeight = 4;
    const wallThick = 0.35;
    const wallY = wallHeight / 2;

    // ── 🧊 Wall tile canvas texture ──────────────────────────────────────────
    // Calippo-Lido restyle (owner request): the old charcoal brick becomes a
    // fine pale-blue tile grid with white grout — soft, airy, and matching
    // the pool room's tiled deck/tower (furniture.ts makePoolTileTex).
    const makeBrickTexture = (): THREE.CanvasTexture => {
      const CW = 512,
        CH = 171;
      const cv = document.createElement("canvas");
      cv.width = CW;
      cv.height = CH;
      const ctx = cv.getContext("2d")!;

      // grout background — clean white
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, CW, CH);

      const BW = 30; // tile width px (small square grid, no brick bond)
      const BH = 30; // tile height px
      const MO = 2; // grout thickness px
      const cols = ["#A9CBE9", "#9FC4E5", "#B2D1EC", "#A4C8E7"];

      for (let row = 0; row * (BH + MO) < CH + BH; row++) {
        const y = row * (BH + MO);
        for (let col = 0; col * (BW + MO) < CW + BW; col++) {
          const x = col * (BW + MO);
          ctx.fillStyle = cols[(row * 3 + col) % 4];
          ctx.fillRect(x + MO, y + MO, BW - MO, BH - MO);
          // soft highlight top-left edge
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillRect(x + MO, y + MO, BW - MO, 2);
          ctx.fillRect(x + MO, y + MO, 2, BH - MO);
        }
      }

      const tex = new THREE.CanvasTexture(cv);
      // Repeat so a tile reads ≈ 0.25 m in world space (fine Habbo grid) — scale
      // with the wall run/height so tiles never stretch (12×4 for the default).
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(
        wallDepth / ((BW + MO) * 0.023),
        wallHeight / ((BH + MO) * 0.023),
      );
      // Nearest-neighbour — keeps tile edges sharp in the pixelated renderer.
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };

    const brickTex = makeBrickTexture();

    const makeMat = () =>
      new THREE.MeshStandardMaterial({
        map: brickTex,
        roughness: 0.85,
        metalness: 0.0,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      });

    const wallGeo = new THREE.BoxGeometry(wallThick, wallHeight, wallDepth);

    const leftWall = new THREE.Mesh(wallGeo, makeMat());
    leftWall.position.set(-halfX, wallY, 0);
    this.platformGroup.add(leftWall);
    this.sideWalls.push(leftWall);

    // 🚪 North wall — same glassy tile treatment. The paired door layout puts
    // TWO doors on the north wall; without a wall panel there they floated on
    // the room boundary (owner: "doors must read inset in a wall, like the
    // west one"). Kept out of sideWalls: the window-wall coverage rule is
    // side-wall (|x|>5) specific.
    const northWallGeo = new THREE.BoxGeometry(
      wallSpanX,
      wallHeight,
      wallThick,
    );
    this.northWall = new THREE.Mesh(northWallGeo, makeMat());
    this.northWall.position.set(0, wallY, -halfZ);
    this.platformGroup.add(this.northWall);

    // Subtle top-edge coping strips
    const edgeGeo = new THREE.BoxGeometry(
      wallThick + 0.06,
      0.1,
      wallDepth + 0.06,
    );
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0xb8c8d8,
      roughness: 0.75,
      metalness: 0.05,
      transparent: true,
      opacity: 0,
    });
    const strip = new THREE.Mesh(edgeGeo, edgeMat.clone());
    strip.position.set(-halfX, wallHeight + 0.05, 0);
    this.platformGroup.add(strip);
    this.platformElements.push(strip);
    const northStrip = new THREE.Mesh(
      new THREE.BoxGeometry(wallSpanX + 0.06, 0.1, wallThick + 0.06),
      edgeMat.clone(),
    );
    northStrip.position.set(0, wallHeight + 0.05, -halfZ);
    this.platformGroup.add(northStrip);
    this.platformElements.push(northStrip);
  }

  /**
   * Add complete capsule outer structure (Roof + solid outer walls for Level 3 isometric view)
   */
  private addCapsuleOuterStructure() {
    // 🧱 #66 R1: hull shell derives from the room size (+0.35 hull overhang).
    // Default 2×2 room ⇒ 12.35 × 12.35, bit-for-bit.
    const { halfX, halfZ } = roomHalfExtents();
    const hullW = 2 * halfX + 0.35,
      hullD = 2 * halfZ + 0.35;
    // 1. Sleek metallic outer roof
    const roofGeo = new THREE.BoxGeometry(hullW, 0.28, hullD);
    const outerMetallicMat = new THREE.MeshStandardMaterial({
      color: 0x2a3e52, // carbon structural blueprint slate
      roughness: 0.4,
      metalness: 0.8,
      transparent: true,
      opacity: 0, // starts completely hidden for internal levels <= 2
    });
    this.capsuleRoof = new THREE.Mesh(roofGeo, outerMetallicMat);
    this.capsuleRoof.position.set(0, 4.14, 0);
    this.platformGroup.add(this.capsuleRoof);

    // 2. Solid metallic outer front/back walls to block inner rendering during external views
    const wallGeoF = new THREE.BoxGeometry(hullW, 4.0, 0.35);
    const frontWall = new THREE.Mesh(wallGeoF, outerMetallicMat);
    frontWall.position.set(0, 2.0, halfZ);
    this.platformGroup.add(frontWall);
    this.capsuleOuterWalls.push(frontWall);

    const backWall = new THREE.Mesh(wallGeoF, outerMetallicMat);
    backWall.position.set(0, 2.0, -halfZ);
    this.platformGroup.add(backWall);
    this.capsuleOuterWalls.push(backWall);

    // Also build a full solid left/right wall set with ports slots included
    const wallGeoLR = new THREE.BoxGeometry(0.35, 4.0, hullD);
    const rightWall = new THREE.Mesh(wallGeoLR, outerMetallicMat);
    rightWall.position.set(halfX, 2.0, 0);
    this.platformGroup.add(rightWall);
    this.capsuleOuterWalls.push(rightWall);

    const leftWall = new THREE.Mesh(wallGeoLR, outerMetallicMat);
    leftWall.position.set(-halfX, 2.0, 0);
    this.platformGroup.add(leftWall);
    this.capsuleOuterWalls.push(leftWall);
  }

  /**
   * 🛑📐 #80 S1: build the octagon hull barrel (walls + 45° roof + basement)
   * from the room's half-extents and add it to the platform. Preview only
   * (`?octagon=1`) — the camera-facing wall fade is driven each frame in
   * update(); the barrel hides at exterior zoom (≥3) like the interior walls.
   */
  private addOctagonHull() {
    // Idempotent: a morph restart re-runs createPlatform, so drop any prior
    // barrel before rebuilding (mirrors the vestibule dispose discipline).
    if (this.octagonHull) {
      this.platformGroup.remove(this.octagonHull.group);
      this.octagonHull.dispose();
      this.octagonHull = null;
    }
    const { halfX, halfZ } = roomHalfExtents();
    this.octagonHull = buildOctagonHull(
      { halfX, halfZ },
      this.collectWindowOpenings(),
    );
    this.platformGroup.add(this.octagonHull.group);
  }

  /**
   * 🪟 #80: rounded-rect window openings cut from the octagon side walls (look
   * outside). A demo opening rides `?octagon=1&window=1`; movable `window`
   * furniture items map to openings here in a later slice (item world pos →
   * which side wall + along-wall coord), the same way the pool drives floor
   * holes. Rebuilt with the hull (addOctagonHull) whenever windows change.
   */
  private collectWindowOpenings(): HullWindows {
    const neg: WindowOpening[] = [];
    const pos: WindowOpening[] = [];
    if (
      new URLSearchParams(window.location.search).get("window") === "1"
    ) {
      neg.push({ along: 0, y: 2, w: 3, h: 1.8, r: 0.5 });
    }
    return {
      neg: neg.length ? neg : undefined,
      pos: pos.length ? pos : undefined,
    };
  }

  /**
   * 🛑📐 #80: the floor plane — SOLID by default, with any `floorHoles` cut out
   * (a pool sinks into the basement through the hole). No holes ⇒ a plain
   * PlaneGeometry (bit-identical to the legacy floor). The outline is authored
   * in plane coords (x, y=−z) so it lays flat under the mesh's rotation.x=−π/2,
   * and UVs are remapped to 0..1 so the wood texture tiles exactly as before.
   */
  private makeFloorGeometry(): THREE.BufferGeometry {
    const { halfX, halfZ } = roomHalfExtents();
    const w = 2 * halfX,
      d = 2 * halfZ;
    if (this.floorHoles.length === 0) return new THREE.PlaneGeometry(w, d);
    const shape = new THREE.Shape();
    shape.moveTo(-halfX, -halfZ);
    shape.lineTo(halfX, -halfZ);
    shape.lineTo(halfX, halfZ);
    shape.lineTo(-halfX, halfZ);
    shape.closePath();
    for (const h of this.floorHoles) {
      const path = new THREE.Path();
      const py0 = -h.z1,
        py1 = -h.z0; // world z → plane y (the mesh is rotated -π/2)
      path.moveTo(h.x0, py0);
      path.lineTo(h.x1, py0);
      path.lineTo(h.x1, py1);
      path.lineTo(h.x0, py1);
      path.closePath();
      shape.holes.push(path);
    }
    const geo = new THREE.ShapeGeometry(shape);
    // ShapeGeometry UVs are raw shape coords; remap to 0..1 across the floor so
    // the wood texture's repeat matches the PlaneGeometry mapping.
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + halfX) / w;
      uv[i * 2 + 1] = (pos.getY(i) + halfZ) / d;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    return geo;
  }

  /**
   * 🛑📐 #80: set the pool holes cut from the solid floor (world XZ rects) and
   * rebuild the floor mesh. Empty restores a solid floor. The invisible
   * click-navigation plane is left intact (walking over a hole still resolves;
   * the swim/sink-into-basement mechanic is a later slice).
   */
  public setFloorHoles(
    holes: Array<{ x0: number; z0: number; x1: number; z1: number }>,
  ): void {
    const key = JSON.stringify(holes);
    if (key === this.floorHolesKey) return; // no change — skip the rebuild
    this.floorHolesKey = key;
    this.floorHoles = holes.slice();
    if (!this.platformFloor) return;
    const old = this.platformFloor.geometry;
    this.platformFloor.geometry = this.makeFloorGeometry();
    old.dispose();
  }

  /**
   * Add lobby furniture — sofas, coffee table, side tables, cabinets, fireplace.
   * All pieces start at opacity 0 and are stored in furnitureMeshes for morph fade-in.
   */
  private addLobbyFurniture() {
    // Data-driven: each FurnitureItem builds one THREE.Group at its origin
    // (see furniture.ts). The group is positioned/rotated here, its meshes
    // feed the existing morph fade-in + zoom-hide machinery unchanged, and
    // its point lights carry their fade target in userData.targetIntensity.
    // reveal=false: built-in items ride the morph fade-in (opacity starts 0).
    for (const item of FURNITURE) {
      this.registerFurnitureGroup(item, false);
    }

    // In-world checkers mirror (#45): repaint every game table's board face
    // from the doc-synced `games` map, so spectators see the live game
    // without focusing (the wall-screen hybrid idiom, §D0.4). The
    // subscription survives room rebinds — gamesDoc re-notifies on bind.
    if (this.gameTableTops.size > 0) {
      const repaintBoards = () => {
        for (const [id, top] of this.gameTableTops) {
          top.setBoard(readGame(id)?.board ?? null);
        }
      };
      subscribeGames(repaintBoards);
      repaintBoards();
    }
  }

  /**
   * Build ONE furniture item's group, add it to the platform, and collect its
   * per-item drive handles — the shared registration used by both the initial
   * lobby build and the E4 reconcile (issue #60). `reveal` decides opacity:
   *  - false: the item rides the morph fade-in (materials start at opacity 0);
   *    used for the initial build, where the morph reveals everything.
   *  - true: reveal immediately (materials → baseOpacity, lights → target
   *    intensity); used for a runtime add (DEV spawn, or a synced item landing
   *    on a client already past the morph) which no fade-in will ever touch.
   * ⚠ Every per-item collection here MUST have its inverse delete in
   * removeFurnitureVisuals, or removal leaves a live driven handle (#45 F1).
   */
  private registerFurnitureGroup(item: FurnitureItem, reveal: boolean): void {
    const group = buildItemGroup(item);
    this.platformGroup.add(group);
    this.furnitureGroups.set(item.id, group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        this.furnitureMeshes.push(obj);
        if (obj.userData.wallScreen) {
          this.wallScreens.set(
            item.id,
            obj.userData.wallScreen as WallScreenHandle,
          );
        }
        if (typeof obj.userData.holoSpin === "number") {
          this.holoSpinners.push({ mesh: obj, speed: obj.userData.holoSpin });
        }
        if (obj.userData.trunkLid) {
          this.trunkLids.set(item.id, obj.userData.trunkLid as TrunkLidHandle);
        }
        if (obj.userData.gameTableTop) {
          this.gameTableTops.set(
            item.id,
            obj.userData.gameTableTop as GameTableTopHandle,
          );
        }
        if (obj.userData.cloneVat) {
          this.cloneVats.set(item.id, obj.userData.cloneVat as CloneVatHandle);
        }
        if (reveal) {
          const mat = obj.material as THREE.Material & {
            opacity: number;
            userData: { baseOpacity?: number };
          };
          if ("opacity" in mat) mat.opacity = mat.userData.baseOpacity ?? 1;
        }
      } else if (obj instanceof THREE.PointLight) {
        const targetIntensity = (obj.userData.targetIntensity as number) ?? 0;
        this.furnitureLights.push({ light: obj, targetIntensity });
        if (reveal) obj.intensity = targetIntensity;
      }
    });
  }

  /**
   * Reconcile the local room to the shared `furniture` layout map (issue #60
   * E4). Called from the furnitureDoc subscription on every change — including
   * the initial sync burst that brings a joiner the host's arrangement. Diffs
   * the desired records against the local FURNITURE registry and applies
   * removals, adds and moves, then rebakes the pipeline ONCE.
   *
   * Empty map ⇒ no-op: an unseeded room (nobody has claimed/edited) keeps the
   * identical code-default layout every client already built, so we never
   * wipe the room to nothing while waiting for a seed that isn't coming.
   *
   * Self-echo safe: the owner's own edit already mutated FURNITURE + visuals
   * before writing the doc, so its record matches local state and the diff
   * finds nothing to do. Only genuinely-remote changes apply here.
   */
  /**
   * #64: reconcile docked-module door pairings from the shared `doors` map — a
   * module someone docked to a door now shows (adjacent-room projection) and is
   * enterable (transitReady) for everyone. A door present + paired in the doc is
   * applied; a door absent (unpaired/removed) is torn down. Both apply-paths are
   * idempotent + self-echo safe (the local docker already drew via completePairing,
   * so applyRemotePairing early-returns), and never re-publish.
   */
  public reconcileDoors(records: Map<string, DoorRecord>): void {
    if (!this.dockingSystem) return; // docking ports not built yet
    const doors: Array<"north" | "south" | "east" | "west"> = [
      "north",
      "south",
      "east",
      "west",
    ];
    for (const doorId of doors) {
      const rec = records.get(doorId);
      if (rec && rec.paired && rec.connectedRoomAddress) {
        // #62 P2: geometry (sanitized by readAllDoors) rides along; the diff
        // inside applyRemotePairing catches chain edits on a same-address record.
        this.dockingSystem.applyRemotePairing(
          doorId,
          rec.connectedRoomAddress,
          {
            segments: rec.segments,
            farDoor: rec.farDoor,
            farYawDeg: rec.farYawDeg,
            transient: rec.transient, // #67 D2
          },
        );
      } else {
        this.dockingSystem.clearRemotePairing(doorId);
      }
    }
  }

  /**
   * 🧱 #66 S1: re-derive every door anchor from the shared floor plan's
   * slide deltas — walk targets (doors.ts), the 3D door groups (frame +
   * leaves + keypad ride together), adapter anchors for FUTURE pairings
   * (paired doors cannot slide, so live chains never re-solve), and the
   * north blocking zone (it reads the slid front). Delta 0 everywhere ⇒
   * bit-identical legacy behavior.
   */
  public reconcileDoorPlacements(): void {
    const deltas = readDoorDeltas();
    applyDoorSlideDeltas(deltas);
    setDoorSlideDeltas(deltas);
    this.dockingSystem?.repositionDoorGroups(deltas);
    this.updateNorthDoorForFireplace();
  }

  /**
   * 🚪↔🛰️ #28 S4: reconcile WHICH doors the room has from the shared
   * `doorLayout` map (doorLayoutDoc). MEMBERSHIP only — rebuildDoors adds/removes
   * DOORS entries; positions are then set by reconcileDoorPlacements and the
   * click bodies re-tagged. An UNSEEDED room (empty map) keeps the local cardinal
   * defaults, so un-migrated rooms are byte-identical. No-op until ports exist.
   * (Distinct from reconcileDoors, which is the door-PAIRING reconcile.)
   */
  public reconcileDoorLayout(records: Map<string, DoorLayoutRecord>): void {
    if (records.size === 0) return; // unseeded → keep the local cardinal defaults
    if (!this.dockingSystem) return; // docking ports not built yet
    rebuildDoors(records); // walk-target membership (makes findDoor correct first)
    this.dockingSystem.syncDoorGroups(records); // 3D group add/remove/rebuild
    this.reconcileDoorPlacements(); // position the (possibly new) groups
    this.dockingSystem.refreshDoorInteractivity();
    // 🚪 #28 S6b: keep a live edit session's raycast index in sync with the door
    // groups just added / removed / rebuilt — a TARGETED door-slice rebuild that
    // preserves the current selection by id. Deliberately NOT the furniture
    // reconcile's forceExit+enter (~2076): that would deselect on every local
    // door edit (add/remove fire this synchronously via the doc observer).
    if (roomEdit.isEditModeActive()) roomEdit.onDoorLayoutChanged();
  }

  /**
   * Floor-plan work (owner request): the NORTH door unblocks DYNAMICALLY once
   * the fireplace no longer covers its approach — move the hearth aside and
   * the fourth door opens; move it back and the door disables again. The DEV
   * NORTH DOOR toggle still force-enables regardless (walkthrough tool).
   * Called after every furniture reconcile and at platform build.
   */
  /**
   * 🧱🪟 Modular walls (owner request): when a brick-wall / window-wall
   * furniture item sits ON a structural side wall's line (|x| > 5 — the
   * built-in bricks live at ±6), that side's built-in wall HIDES — the
   * placed sections become the wall, and a window section becomes a real
   * view out (stars, the planet, docked-module projections through the
   * glass). Remove the sections and the built-in wall returns. Same
   * furniture-drives-structure pattern as the fireplace/north door.
   */
  public updateSideWallCoverage(): void {
    // "On a side wall's line" = within 1 m of the ±halfX wall (default ±5).
    const { halfX } = roomHalfExtents();
    const nearWall = halfX - 1;
    this.sideWallCovered[0] = false;
    this.sideWallCovered[1] = false;
    for (const item of FURNITURE) {
      if (item.kind !== "brick-wall" && item.kind !== "window-wall") continue;
      if (item.pos.x < -nearWall) this.sideWallCovered[0] = true;
      if (item.pos.x > nearWall) this.sideWallCovered[1] = true;
    }
    // addSideWalls order: [0] = left (x=-6). The zoom machinery consults the
    // flags too (it force-restores walls at interior levels otherwise).
    this.sideWalls.forEach((wall, i) => {
      wall.visible = !this.hullEditView && !this.sideWallCovered[i];
    });
    if (this.northWall) this.northWall.visible = !this.hullEditView;
  }

  /** Which built-in side walls are REPLACED by placed wall sections. */
  private sideWallCovered: boolean[] = [false, false];

  /** 🛰️ HULL EDIT presentation (editMode hull scope): walls drop so the
   *  outside is visible/clickable; the per-frame interior restore respects
   *  the flag, and clearing it re-runs the coverage rules. */
  private hullEditView = false;

  public setHullEditView(on: boolean): void {
    this.hullEditView = on;
    this.sideWalls.forEach((wall, i) => {
      wall.visible = !on && !this.sideWallCovered[i];
    });
    if (this.northWall) this.northWall.visible = !on;
  }

  /**
   * 🏝️ Apply room-type visual theme (lobby vs. outdoor casino pool).
   * Called from main.ts right after joinRoomAtEpoch completes so the floor
   * colour and wall visibility update before the fade-in reveals the room.
   * Safe to call multiple times — fully idempotent.
   */
  /** 🪧 Wayfinding lintels — text ENGRAVED into the wall above a door (owner
   *  request: no floating plate/"sticker"): a shallow recessed panel sunk
   *  into the tile wall (translucent darker wash — tiles ghost through —
   *  with a shadowed top lip and a lit bottom lip), letters chiselled with a
   *  dark upper edge + bright lower edge, one plane flush on the wall face.
   *  The quiet recessed backdrop is what lets the carving read over the busy
   *  tile grid — without it the letters dissolve into the grout lines. */
  private makeEngravedSign(
    title: string,
    ink: { shadow: string; light: string; face: string },
    recessedPanel = true,
  ): THREE.Group {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 128;
    const c = cv.getContext("2d")!;
    c.clearRect(0, 0, 512, 128); // transparent — the wall shows through
    if (recessedPanel) {
      c.fillStyle = "rgba(58, 92, 116, 0.55)"; // recessed panel wash
      c.fillRect(10, 10, 492, 108);
      c.fillStyle = "rgba(8, 30, 44, 0.6)"; // shadowed top/left lips
      c.fillRect(10, 10, 492, 7);
      c.fillRect(10, 10, 7, 108);
      c.fillStyle = "rgba(255, 255, 255, 0.55)"; // lit bottom/right lips
      c.fillRect(10, 111, 492, 7);
      c.fillRect(495, 10, 7, 108);
    }
    (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      "6px";
    c.font = 'bold 44px Georgia, "Palatino Linotype", serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = ink.shadow; // recess shadow (upper edge)
    c.fillText(title, 256, 49);
    c.fillStyle = ink.light; // catch-light (lower edge)
    c.fillText(title, 256, 56);
    c.fillStyle = ink.face; // carved face popping off the dark recess
    c.fillText(title, 256, 52);
    // Slim flourish beneath, chiselled the same way.
    const flourish = (color: string, dy: number) => {
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(186, 92 + dy);
      c.quadraticCurveTo(256, 101 + dy, 326, 92 + dy);
      c.stroke();
    };
    flourish(ink.shadow, -3);
    flourish(ink.face, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Lintel-banner proportions: wide enough to read at the room camera —
    // smaller plates dissolve into the tile grid.
    const geo = new THREE.PlaneGeometry(3.4, 0.66);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: recessedPanel,
      depthWrite: recessedPanel,
    });
    const group = new THREE.Group();
    const front = new THREE.Mesh(geo, mat); // faces INTO the room
    front.rotation.y = Math.PI;
    front.renderOrder = recessedPanel ? 0 : 20;
    group.add(front);
    this.platformGroup.add(group);
    return group;
  }

  private ensurePoolSign(): void {
    if (!this.poolSign) {
      this.poolSign = this.makeEngravedSign(
        "POOL & HOT TUB",
        {
          shadow: "rgba(4, 48, 24, 0.98)",
          light: "rgba(226, 255, 235, 0.98)",
          face: "#72f59a",
        },
        false,
      );
    }
    if (!this.casinoSign) {
      // High-contrast green matches every directional door engraving.
      this.casinoSign = this.makeEngravedSign(
        "CASINO",
        {
          shadow: "rgba(4, 48, 24, 0.98)",
          light: "rgba(226, 255, 235, 0.98)",
          face: "#72f59a",
        },
        false,
      );
    }
    if (!this.lobbySign) {
      this.lobbySign = this.makeEngravedSign(
        "LOBBY",
        {
          shadow: "rgba(4, 48, 24, 0.98)",
          light: "rgba(226, 255, 235, 0.98)",
          face: "#72f59a",
        },
        false,
      );
    }
    if (!this.casinoLobbySign) {
      this.casinoLobbySign = this.makeEngravedSign(
        "LOBBY",
        {
          shadow: "rgba(4, 48, 24, 0.98)",
          light: "rgba(226, 255, 235, 0.98)",
          face: "#72f59a",
        },
        false,
      );
    }
  }

  private ensureCasinoDecor(): void {
    if (this.casinoDecor) return;
    const group = new THREE.Group();
    group.name = "casino-theme-decor";

    const gold = new THREE.MeshStandardMaterial({
      color: 0xf4c45e,
      emissive: 0x7a3b08,
      emissiveIntensity: 0.18,
      metalness: 0.82,
      roughness: 0.2,
    });
    const crystalGlass = new THREE.MeshPhysicalMaterial({
      color: 0xffe9b0,
      metalness: 0,
      roughness: 0.08,
      transmission: 0.82,
      transparent: true,
      opacity: 0.24,
      thickness: 0.12,
      depthWrite: false,
    });
    const trellisGold = new THREE.MeshStandardMaterial({
      color: 0xd99b2b,
      emissive: 0x5a2604,
      emissiveIntensity: 0.12,
      metalness: 0.72,
      roughness: 0.28,
    });
    const vine = new THREE.MeshStandardMaterial({
      color: 0x174d24,
      roughness: 0.88,
    });
    const leafMaterials = [0x246c32, 0x358642, 0x4b9b4c].map(
      (color) =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.82,
        }),
    );
    const flowerGold = new THREE.MeshStandardMaterial({
      color: 0xffb51d,
      emissive: 0x8b3800,
      emissiveIntensity: 0.22,
      roughness: 0.48,
    });
    const berryRed = new THREE.MeshStandardMaterial({
      color: 0x9e1f2f,
      roughness: 0.5,
    });

    const addBox = (
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      group.add(mesh);
    };

    const dollarCanvas = document.createElement("canvas");
    dollarCanvas.width = 128;
    dollarCanvas.height = 128;
    const dollarCtx = dollarCanvas.getContext("2d")!;
    dollarCtx.clearRect(0, 0, 128, 128);
    dollarCtx.font = "900 104px Georgia";
    dollarCtx.textAlign = "center";
    dollarCtx.textBaseline = "middle";
    dollarCtx.lineWidth = 8;
    dollarCtx.strokeStyle = "#6f3500";
    dollarCtx.strokeText("$", 64, 66);
    dollarCtx.fillStyle = "#ffd96b";
    dollarCtx.fillText("$", 64, 66);
    const dollarTexture = new THREE.CanvasTexture(dollarCanvas);
    dollarTexture.colorSpace = THREE.SRGBColorSpace;
    dollarTexture.minFilter = THREE.LinearMipmapLinearFilter;
    const dollarMaterial = new THREE.MeshBasicMaterial({
      map: dollarTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const addDollar = (
      position: [number, number, number],
      rotationY: number,
      size = 0.34,
    ) => {
      const symbol = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        dollarMaterial,
      );
      symbol.position.set(...position);
      symbol.rotation.y = rotationY;
      symbol.renderOrder = 3;
      group.add(symbol);
    };

    // Camera-facing east and south walls become a layered grand-salon shell.
    addBox([0.16, 0.2, 11.2], [5.7, 3.22, 0], gold);
    addBox([11.2, 0.2, 0.16], [0, 3.22, 5.7], gold);
    addBox([0.16, 0.2, 11.2], [-5.7, 3.22, 0], gold);
    addBox([11.2, 0.2, 0.16], [0, 3.22, -5.7], gold);
    addBox([0.12, 0.12, 11.0], [5.64, 0.18, 0], gold);
    addBox([11.0, 0.12, 0.12], [0, 0.18, 5.64], gold);
    for (const offset of [-3.7, 0, 3.7]) {
      addBox([0.24, 2.66, 0.42], [5.56, 1.65, offset], crystalGlass);
      addBox([0.34, 0.18, 0.58], [5.56, 0.28, offset], gold);
      addBox([0.34, 0.18, 0.58], [5.56, 3.02, offset], gold);
      addBox([0.42, 2.66, 0.24], [offset, 1.65, 5.56], crystalGlass);
      addBox([0.58, 0.18, 0.34], [offset, 0.28, 5.56], gold);
      addBox([0.58, 0.18, 0.34], [offset, 3.02, 5.56], gold);
    }

    // Gold-dollar crown moulding on the north and west door walls only.
    for (let offset = -5.1; offset <= 5.1; offset += 0.85) {
      addDollar([offset, 3.04, -5.79], 0);
      addDollar([-5.79, 3.04, offset], Math.PI / 2);
    }

    const addStem = (
      from: THREE.Vector3,
      to: THREE.Vector3,
      radius = 0.035,
    ) => {
      const direction = to.clone().sub(from);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(
          radius,
          radius * 1.08,
          direction.length(),
          6,
        ),
        vine,
      );
      stem.position.copy(from).add(to).multiplyScalar(0.5);
      stem.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
      );
      group.add(stem);
    };

    const addFloralTrellis = (wall: "north" | "west") => {
      const alongX = wall === "north";
      const wallPlane = -5.52;
      const point = (along: number, y: number, inward = 0) =>
        new THREE.Vector3(
          alongX ? along : wallPlane + inward,
          y,
          alongX ? wallPlane + inward : along,
        );

      for (const along of [-4.8, -2.4, 0, 2.4, 4.8]) {
        addBox(
          alongX ? [0.07, 0.82, 0.07] : [0.07, 0.82, 0.07],
          [alongX ? along : wallPlane, 3.72, alongX ? wallPlane : along],
          trellisGold,
        );
      }
      addBox(
        alongX ? [10.7, 0.07, 0.07] : [0.07, 0.07, 10.7],
        alongX ? [0, 3.48, wallPlane] : [wallPlane, 3.48, 0],
        trellisGold,
      );
      addBox(
        alongX ? [10.7, 0.07, 0.07] : [0.07, 0.07, 10.7],
        alongX ? [0, 4.03, wallPlane] : [wallPlane, 4.03, 0],
        trellisGold,
      );

      const vinePoints: THREE.Vector3[] = [];
      for (let index = 0; index < 13; index++) {
        const along = -5.1 + index * 0.85;
        const y = 3.82 + Math.sin(index * 1.55) * 0.22;
        const center = point(along, y, 0.08);
        vinePoints.push(center);
        if (index > 0) addStem(vinePoints[index - 1], center);

        for (const side of [-1, 1]) {
          const leaf = new THREE.Mesh(
            new THREE.SphereGeometry(0.17, 7, 5),
            leafMaterials[(index + (side > 0 ? 1 : 0)) % leafMaterials.length],
          );
          leaf.scale.set(1.35, 0.48, 0.72);
          leaf.position.copy(center);
          leaf.position.y += side * 0.12;
          if (alongX) {
            leaf.position.x += side * 0.19;
            leaf.position.z += 0.09;
            leaf.rotation.z = side * 0.55;
          } else {
            leaf.position.z += side * 0.19;
            leaf.position.x += 0.09;
            leaf.rotation.x = side * 0.55;
          }
          leaf.rotation.y = index * 0.72;
          group.add(leaf);
        }

        if (index % 2 === 0) {
          const flowerCenter = center.clone();
          flowerCenter.y += 0.28;
          flowerCenter.add(point(0, 0, 0.16).sub(point(0, 0, 0)));
          for (let petal = 0; petal < 5; petal++) {
            const angle = (petal / 5) * Math.PI * 2;
            const bloom = new THREE.Mesh(
              new THREE.ConeGeometry(0.09, 0.22, 6),
              flowerGold,
            );
            bloom.position.copy(flowerCenter);
            if (alongX) {
              bloom.position.x += Math.cos(angle) * 0.1;
              bloom.position.y += Math.sin(angle) * 0.1;
              bloom.rotation.z = -angle + Math.PI / 2;
            } else {
              bloom.position.z += Math.cos(angle) * 0.1;
              bloom.position.y += Math.sin(angle) * 0.1;
              bloom.rotation.x = angle - Math.PI / 2;
            }
            group.add(bloom);
          }
        } else if (index % 3 === 0) {
          for (const drop of [-0.08, 0.08]) {
            const berry = new THREE.Mesh(
              new THREE.SphereGeometry(0.065, 7, 5),
              berryRed,
            );
            berry.position.copy(center);
            berry.position.y -= 0.2;
            if (alongX) berry.position.x += drop;
            else berry.position.z += drop;
            group.add(berry);
          }
        }
      }
    };

    addFloralTrellis("north");
    addFloralTrellis("west");

    // Casino doors occupy paired slots on north and west. Stamp both jambs
    // and the lintel without adding collision or narrowing the opening.
    for (const doorId of ["north", "south", "west", "east"] as const) {
      const pose = physicalDoorPose(doorId);
      const northSouth = pose.wall === "north" || pose.wall === "south";
      const inward =
        pose.wall === "north" || pose.wall === "west" ? 0.19 : -0.19;
      const faceYaw = northSouth ? 0 : Math.PI / 2;
      for (const side of [-1, 1]) {
        for (const y of [0.5, 1.2, 1.9, 2.6]) {
          addDollar(
            northSouth
              ? [pose.x + side * 1.27, y, pose.z + inward]
              : [pose.x + inward, y, pose.z + side * 1.27],
            faceYaw,
            0.3,
          );
        }
      }
      for (const along of [-0.9, -0.3, 0.3, 0.9]) {
        addDollar(
          northSouth
            ? [pose.x + along, 3.02, pose.z + inward]
            : [pose.x + inward, 3.02, pose.z + along],
          faceYaw,
          0.3,
        );
      }
    }

    const lightColors = [0xffbf48, 0xffd976, 0xffbf48, 0xffd976];
    const lightPositions = [
      [-3.3, 3.45, -2.8],
      [3.3, 3.45, -2.8],
      [-3.3, 3.45, 2.8],
      [3.3, 3.45, 2.8],
    ] as const;
    lightPositions.forEach(([x, y, z], index) => {
      const color = lightColors[index];
      const canopy = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.38, 0.1, 16),
        gold,
      );
      canopy.position.set(x, y + 0.18, z);
      group.add(canopy);
      for (let tier = 0; tier < 3; tier++) {
        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.13 - tier * 0.02, 0),
          new THREE.MeshPhysicalMaterial({
            color: 0xffe5a3,
            emissive: color,
            emissiveIntensity: 0.65,
            metalness: 0.05,
            roughness: 0.08,
            transmission: 0.35,
            transparent: true,
            opacity: 0.9,
          }),
        );
        crystal.position.set(x, y - tier * 0.19, z);
        crystal.rotation.y = tier * (Math.PI / 4);
        group.add(crystal);
      }
      const light = new THREE.PointLight(color, 2.8, 6.5, 1.45);
      light.position.set(x, y - 0.22, z);
      group.add(light);
    });

    this.casinoDecor = group;
    this.platformGroup.add(group);
  }

  public applyRoomVisuals(
    roomId: string,
    returnDoorId?: DoorId,
    theme?: RoomTheme,
  ): void {
    const outdoor = roomId === OUTDOOR_CASINO_ROOM_ID;
    const casino = roomId === CASINO_ROOM_ID;
    this.isOutdoorRoom = outdoor;
    // 🌌 Resolve the VISUAL theme (backdrop + lighting) — an explicit roomInfo
    // theme (passed by the caller) wins; otherwise fall back to the room's
    // identity. This is SEPARATE from the roomId-keyed MECHANICS below (door
    // layout, waiter, floor, signs stay keyed on outdoor/casino), so the pool
    // room keeps its pool plumbing while its backdrop becomes real space.
    const resolvedTheme: RoomTheme = theme ?? legacyThemeFromRoomId(roomId);
    const deck = resolvedTheme === "outdoor-deck";
    const casinoTheme = resolvedTheme === "casino";
    this.isOutdoorDeck = deck;
    // 🚪 Camera-near south/east edges stay clear EVERYWHERE: the lobby and
    // the casino run "casino-pairs", the outdoor pool room "pool-pairs" —
    // aliases of the same paired arrangement (SOUTH on the north wall, EAST
    // on the west wall; the dive tower stands between the two north doors).
    setActiveDoorLayout(outdoor ? "pool-pairs" : "casino-pairs");

    // 🤖 One drink-service waiter implementation serves every authored room;
    // each room supplies a route through its own open aisles. Recreate on a
    // route change so transits swap the floor plan without duplicating logic.
    // Keyed on pool PRESENCE (like refreshOutdoorFloor), not the roomId — a
    // pool template dropped into a minted module runs the pool route too, while
    // a poolless sky deck (theme outdoor-deck, no pool) stays on the lobby route.
    const hasPoolForPatrol = FURNITURE.some(
      (i) => i.kind === "lazy-pool" || i.kind === "classic-pool",
    );
    const waiterPatrol = hasPoolForPatrol
      ? POOL_PATROL
      : casinoTheme
        ? CASINO_PATROL
        : LOBBY_PATROL;
    // 🤖 #77C: reconcile the robot SET (one per placed charging-dock, else a
    // single ambient theme robot) against the current furniture.
    this.reconcileRobots(waiterPatrol);

    const doorDeltas = readDoorDeltas();
    applyDoorSlideDeltas(doorDeltas);
    setDoorSlideDeltas(doorDeltas);
    this.dockingSystem?.repositionDoorGroups(doorDeltas);
    const north = findDoor("north");
    if (casino && north) north.enabled = true;
    else this.updateNorthDoorForFireplace();
    this.dockingSystem?.refreshDoorInteractivity();

    // 🏊 The pool sign points the way FROM the lobby — hidden inside the pool
    // room itself (that same door leads back home there). It hangs over the
    // SOUTH door's PHYSICAL slot, which the paired layout moves to the north
    // wall — so place it from the live pose, not a hard-coded south spot.
    this.ensurePoolSign();
    const placeOnDoor = (
      sign: THREE.Group | null,
      doorId: DoorId,
      visible: boolean,
    ) => {
      if (!sign) return;
      const pose = physicalDoorPose(doorId);
      const doorFaceOffset = 0.14;
      sign.position.set(
        pose.x + Math.sin(pose.frameYaw) * doorFaceOffset,
        2.08,
        pose.z + Math.cos(pose.frameYaw) * doorFaceOffset,
      );
      sign.rotation.y = pose.frameYaw + Math.PI;
      sign.scale.setScalar(
        doorId === "north" || doorId === "south" ? 0.36 : 0.62,
      );
      sign.visible = visible;
    };
    placeOnDoor(this.poolSign, "south", !outdoor && !casino); // 🏊 pool door
    placeOnDoor(this.casinoSign, "east", !outdoor && !casino); // 🎰 casino door
    const pairedDoorId =
      returnDoorId ??
      ([...readAllDoors()].find(([, record]) => record.paired)?.[0] as
        | DoorId
        | undefined);
    placeOnDoor(this.lobbySign, pairedDoorId ?? "north", outdoor);
    placeOnDoor(this.casinoLobbySign, pairedDoorId ?? "west", casino);
    this.ensureCasinoDecor();
    if (this.casinoDecor) this.casinoDecor.visible = casinoTheme;

    // 🏊 Outdoor pool room: HIDE the solid y=0 floor plane and its grid — the
    // lazy-pool item's white-tile deck slabs provide all visible flooring, and
    // the sunken water (y<0) must show through the deck hole. The invisible
    // clickPlane still catches walk clicks, so navigation is unaffected.
    // Pool-GATED (owner request: the pool is removable now): if the room has
    // no lazy-pool, the deck is gone, so SHOW the solid floor instead of
    // leaving a void. Re-run from reconcileFurniture when the pool is
    // added/removed. See refreshOutdoorFloor.
    this.refreshOutdoorFloor();

    // ☀️ Day/night: the outdoor pool room runs bright poolside daylight —
    // sky-blue backdrop, warm sun, nebula + stars hidden. Every other room
    // restores the warm-nebula night scheme (values mirror renderer.ts).
    const sc = this.scene;
    const amb = sc.getObjectByName("light-ambient") as
      | THREE.AmbientLight
      | undefined;
    const sun = sc.getObjectByName("light-sun") as
      | THREE.DirectionalLight
      | undefined;
    const hemi = sc.getObjectByName("light-hemi") as
      | THREE.HemisphereLight
      | undefined;
    const nebSky = sc.getObjectByName("nebula-sky");
    const starLayers = sc.children.filter((o) => o.name === "nebula-stars");
    if (deck) {
      // 🌌 OUTDOOR DECK: deep-space backdrop (the REAL nebula + star layers +
      // the orbiting ocean-planet, un-hidden by the centralized toggle below)
      // with warm, BRIGHT "sunward" light for the beach feel. Fog stays very
      // low so the interior reads crisp and airy (the nebula/star materials
      // ignore fog anyway — this just keeps the room itself un-hazed).
      sc.background = new THREE.Color(0x05070f); // deep space
      if (sc.fog instanceof THREE.FogExp2) {
        sc.fog.color.setHex(0x0a1420);
        sc.fog.density = 0.0016;
      }
      if (amb) {
        amb.color.setHex(0xfff2e0);
        amb.intensity = 1.05;
      }
      if (sun) {
        sun.color.setHex(0xfff0d0);
        sun.intensity = 1.75;
      } // warm sunward flood — bright beach daylight
      if (hemi) {
        hemi.color.setHex(0x9fd0ff); // soft ocean-planet sky glow
        hemi.groundColor.setHex(0xe8d8b8); // warm sand bounce
        hemi.intensity = 0.95;
      }
    } else if (casinoTheme) {
      sc.background = new THREE.Color(0x3b101b);
      if (sc.fog instanceof THREE.FogExp2) {
        sc.fog.color.setHex(0x5a1b28);
        sc.fog.density = 0.004;
      }
      if (amb) {
        amb.color.setHex(0xffe0b0);
        amb.intensity = 1.08;
      }
      if (sun) {
        sun.color.setHex(0xffd98a);
        sun.intensity = 1.85;
      }
      if (hemi) {
        hemi.color.setHex(0xffedcf);
        hemi.groundColor.setHex(0x6d1728);
        hemi.intensity = 0.72;
      }
    } else {
      // 🌅 LOBBY / INTERIOR: bright, cheerful MORNING light (owner request —
      // the old warm-nebula night read as dim). Soft sunrise-blue sky, gentle
      // gold sun, airy ambient.
      sc.background = new THREE.Color(0xbfe0f2); // soft morning sky
      if (sc.fog instanceof THREE.FogExp2) {
        sc.fog.color.setHex(0xcde8f5);
        sc.fog.density = 0.005;
      }
      if (amb) {
        amb.color.setHex(0xfff6e8);
        amb.intensity = 0.95;
      }
      if (sun) {
        sun.color.setHex(0xffeccb);
        sun.intensity = 1.35;
      } // low golden morning sun
      if (hemi) {
        hemi.color.setHex(0xdcefff);
        hemi.groundColor.setHex(0xd9cdbb);
        hemi.intensity = 0.7;
      }
    }
    // 🌌 Backdrop visibility — ONE centralized toggle AFTER the if/else (never
    // per-branch, so no branch can forget it and leaving a deck self-cleans):
    // the real nebula sky, the star layers, and the overhead ocean-planet show
    // ONLY on a deck. Doors ghost to faint glass on the open-air deck too.
    const showSpace = deck;
    if (nebSky) nebSky.visible = showSpace;
    starLayers.forEach((s) => {
      s.visible = showSpace;
    });
    if (this.deckPlanet) this.deckPlanet.visible = showSpace;
    this.dockingSystem?.setGhostDoors(deck);

    if (this.floorMat) {
      if (outdoor) {
        // Swap to a stone-tile texture (created once, cached).
        if (!this.outdoorFloorTex)
          this.outdoorFloorTex = this.makeOutdoorFloorTex();
        this.floorMat.map = this.outdoorFloorTex;
        this.floorMat.color.setHex(0xffffff); // no tint — texture has its own palette
        this.floorMat.roughness = 0.92;
        this.floorMat.metalness = 0.0;
      } else if (casinoTheme) {
        if (!this.casinoFloorTex)
          this.casinoFloorTex = this.makeCasinoFloorTex();
        this.floorMat.map = this.casinoFloorTex;
        this.floorMat.color.setHex(0xffffff);
        this.floorMat.roughness = 0.48;
        this.floorMat.metalness = 0.08;
      } else {
        // Restore original lobby wood herringbone.
        this.floorMat.map = this.woodTex;
        this.floorMat.color.setHex(0xffffff);
        this.floorMat.roughness = 0.78;
        this.floorMat.metalness = 0.0;
      }
      this.floorMat.needsUpdate = true;
    }

    // 🧊 Walls: the pale-blue tile wall shows in BOTH rooms (owner request —
    // it carries the starry windows and reads light/airy at its glassy
    // opacity). No tint — the tile texture's own palette is the look.
    const themedWalls: THREE.Mesh[] = [...this.sideWalls];
    if (this.northWall) themedWalls.push(this.northWall);
    themedWalls.forEach((wall, i) => {
      wall.visible =
        !this.hullEditView &&
        (wall === this.northWall || !this.sideWallCovered[i]);
      const mat = wall.material as THREE.MeshStandardMaterial;
      if (mat && "color" in mat) {
        mat.color.setHex(casinoTheme ? 0xffdfad : 0xffffff);
        mat.roughness = casinoTheme ? 0.5 : 0.72;
        mat.metalness = casinoTheme ? 0.08 : 0;
        mat.needsUpdate = true;
      }
    });
    const themeLabel = outdoor
      ? "outdoor-casino (stone floor)"
      : casino
        ? "casino (festival carpet)"
        : "lobby (wood floor)";
    console.log(
      `🏝️ Room visuals applied: ${themeLabel} · theme=${resolvedTheme}`,
    );
  }

  private makeCasinoFloorTex(): THREE.Texture {
    const size = 512;
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#5A1018";
    c.fillRect(0, 0, size, size);

    const tile = 64;
    for (let row = 0; row < size / tile; row++) {
      for (let col = 0; col < size / tile; col++) {
        const cx = col * tile + tile / 2;
        const cy = row * tile + tile / 2;
        c.fillStyle = (row + col) % 2 === 0 ? "#9E2633" : "#741A25";
        c.fillRect(col * tile + 4, row * tile + 4, tile - 8, tile - 8);
        c.fillStyle = "#D7A236";
        c.fillRect(cx - 7, cy - 7, 14, 14);
        c.fillStyle = "#4A9A3A";
        c.fillRect(cx - 3, cy - 3, 6, 6);
      }
    }
    c.strokeStyle = "#B77B24";
    c.lineWidth = 4;
    for (let p = 0; p <= size; p += tile) {
      c.beginPath();
      c.moveTo(p, 0);
      c.lineTo(p, size);
      c.stroke();
      c.beginPath();
      c.moveTo(0, p);
      c.lineTo(size, p);
      c.stroke();
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2.5, 2.5);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 🏊 Floor visibility for the outdoor pool room. The solid y=0 floor is
   * hidden there so the sunken water shows through the pool's deck — but only
   * while a pool is actually present. If the pool is removed (it's movable
   * furniture now), restore the floor so the room isn't a void. Idempotent;
   * called from applyRoomVisuals (on entry) and reconcileFurniture (when the
   * pool is added/removed). Non-outdoor rooms always show the floor.
   * PUBLIC so the local edit-mode add/remove paths can call it too (reconcile
   * covers remote changes; editMode's local splice/spawn does not).
   */
  public refreshOutdoorFloor(): void {
    // A pool (either style) sinks its water below the floor.
    const hasPool = FURNITURE.some(
      (i) => i.kind === "lazy-pool" || i.kind === "classic-pool",
    );
    if (OCTAGON_HULL) {
      // 🛑📐 #80: keep the floor SOLID and cut holes only in the GRID CELLS the
      // pool water actually covers (merged into rects) — the deck keeps its
      // floor. The pool's basin (with its drawn-in bottom) sinks into the
      // basement through the hole. No pool ⇒ no holes, plus any demo hole.
      const holes: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];
      if (hasPool) holes.push(...mergeCellsToRects(poolHoleCells(FURNITURE)));
      if (this.demoFloorHole) holes.push(this.demoFloorHole);
      this.setFloorHoles(holes);
      if (this.platformFloor) this.platformFloor.visible = true;
      if (this.platformGrid) this.platformGrid.visible = !hasPool;
      return;
    }
    // Legacy (no octagon): hide the whole floor/grid wherever a pool is present
    // — the pool's deck slabs provide the visible flooring instead.
    if (this.platformFloor) this.platformFloor.visible = !hasPool;
    if (this.platformGrid) this.platformGrid.visible = !hasPool;
  }

  /**
   * 🎰 #76: while ROOM-EDITING, draw a flat ring on the floor at every table
   * standing position (STANDS) so the owner can see where the stand slots land
   * — and watch them move as they drag a table. Amber = the reserved wheel-head
   * (owner / owner's robot); cyan = an open position. Hidden outside edit mode.
   * A reused pool of rings lives in platformGroup (room space, like furniture)
   * and is repositioned from STANDS each frame; STANDS itself is re-derived on
   * every furniture reconcile, so a moved table drags its rings along.
   */
  private updateStandMarkers(): void {
    const editing = roomEdit.isEditModeActive();
    if (!editing) {
      if (this.standMarkers) this.standMarkers.visible = false;
      return;
    }
    if (!this.standMarkers) {
      this.standMarkers = new THREE.Group();
      this.standMarkers.name = "standMarkers";
      this.platformGroup.add(this.standMarkers);
    }
    const group = this.standMarkers;
    group.visible = true;
    // Grow the ring pool to cover every stand slot.
    while (group.children.length < STANDS.length) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.26, 0.4, 28),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2; // lie flat on the floor
      ring.renderOrder = 3; // over the floor, under furniture picks
      group.add(ring);
    }
    // Position + colour one ring per stand slot; hide any surplus.
    group.children.forEach((child, i) => {
      const ring = child as THREE.Mesh;
      if (i >= STANDS.length) {
        ring.visible = false;
        return;
      }
      const slot = STANDS[i];
      ring.visible = true;
      ring.position.set(slot.front.x, 0.05, slot.front.z);
      (ring.material as THREE.MeshBasicMaterial).color.setHex(
        slot.role === "wheelHead" ? 0xffb733 : 0x35e0ff,
      );
    });
  }

  /**
   * 🏝️ Canvas stone-tile floor texture for the outdoor casino pool room.
   * Large square tiles in warm beige/sandstone, with grout lines and subtle
   * surface variation to distinguish from the lobby's herringbone wood.
   * Created lazily on first outdoor entry and cached for the session.
   */
  private makeOutdoorFloorTex(): THREE.Texture {
    const W = 512,
      H = 512;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const c = cv.getContext("2d")!;

    // 🧊 Calippo-Lido white checkerboard: fine white tiles alternating with a
    // whisper-of-blue tile, powder blue-white grout — matches the lazy-pool's
    // deck slabs (furniture.ts makePoolTileTex).
    c.fillStyle = "#D9E8F2"; // grout
    c.fillRect(0, 0, W, H);

    const TW = 40,
      TH = 40,
      G = 3; // small fine grid
    for (let row = 0; row * (TH + G) < H; row++) {
      for (let col = 0; col * (TW + G) < W; col++) {
        const x = col * (TW + G);
        const y = row * (TH + G);
        // Checkerboard: white ↔ pale blue-white
        c.fillStyle = (row + col) % 2 === 0 ? "#FFFFFF" : "#EDF5FB";
        c.fillRect(x + G, y + G, TW - G, TH - G);
        // Soft highlight top-left edge
        c.fillStyle = "rgba(255,255,255,0.55)";
        c.fillRect(x + G, y + G, TW - G, 2);
        c.fillRect(x + G, y + G, 2, TH - G);
      }
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3.5, 3.5); // same repeat as the wood texture
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  public updateNorthDoorForFireplace(): void {
    // Every door whose PHYSICAL slot sits on the north wall is gated by the
    // hearth (the paired layout moves the logical SOUTH door up there too):
    // move the fireplace aside and the covered door opens; move it back and
    // it disables again. The DEV NORTH DOOR toggle still force-enables the
    // north door regardless (walkthrough tool).
    // North wall sits at z = -halfZ (default -6); the zone spans from just
    // outside it (−0.2 m) to the door's stand-point (+1.6 m).
    const { halfZ } = roomHalfExtents();
    for (const id of ["north", "south"] as const) {
      if (physicalDoorPose(id).wall !== "north") continue;
      const door = findDoor(id);
      if (!door) continue;
      // Approach zone in front of the north wall opening (opening ~1.4 wide
      // at z=-halfZ; the zone reaches to the door's `front` stand-point).
      // 🧱 #66 S1: the zone FOLLOWS the door — centred on its slid position
      // (front.x carries the slide delta).
      const cx = door.front.x;
      const zone = {
        x0: cx - 1.4,
        x1: cx + 1.4,
        z0: -halfZ - 0.2,
        z1: -halfZ + 1.6,
      };
      const blocked = FURNITURE.some((item) => {
        if (item.kind !== "fireplace-wall") return false;
        const fp = FURNITURE_DEFS[item.kind].footprint;
        if (!fp) return false; // footprint-less def — nothing to block with
        const w = item.rot % 2 === 0 ? fp.w : fp.d;
        const d = item.rot % 2 === 0 ? fp.d : fp.w;
        const x0 = item.pos.x - w / 2,
          x1 = item.pos.x + w / 2;
        const z0 = item.pos.z - d / 2,
          z1 = item.pos.z + d / 2;
        return x0 < zone.x1 && x1 > zone.x0 && z0 < zone.z1 && z1 > zone.z0;
      });
      const unlocked = id === "north" && northDoorUnlocked();
      door.enabled = unlocked || !blocked;
    }
  }

  public reconcileFurniture(records: Map<string, FurnitureRecord>): void {
    if (records.size === 0) return; // unseeded — keep local defaults
    if (this.furnitureGroups.size === 0) return; // platform not built yet

    const changedIds = new Set<string>();

    // 1. Removals — local items no longer in the shared layout.
    for (const item of [...FURNITURE]) {
      if (records.has(item.id)) continue;
      this.evictAndDefocusForItem(item.id);
      this.removeFurnitureVisuals(item.id);
      const idx = FURNITURE.findIndex((i) => i.id === item.id);
      if (idx !== -1) FURNITURE.splice(idx, 1);
      changedIds.add(item.id);
    }

    // 2. Adds + moves.
    for (const [id, rec] of records) {
      const existing = FURNITURE.find((i) => i.id === id);
      if (!existing) {
        const item: FurnitureItem = {
          id,
          kind: rec.kind,
          pos: { x: rec.x, z: rec.z },
          rot: rec.rot,
          movable: rec.movable,
        };
        if (rec.mountParent !== undefined) item.mountParent = rec.mountParent; // 🛰️ hull stack
        // Records can't carry hand-authored footprintOverrides — restore the
        // authored obstacle when the item sits at its exact default pose, so
        // a doc round-trip (cross-room travel) bakes the same walkable grid
        // as a fresh boot (per-client grid drift otherwise).
        const dov = DEFAULT_FOOTPRINT_OVERRIDES[id];
        if (
          dov &&
          rec.x === dov.x &&
          rec.z === dov.z &&
          rec.rot === dov.rot &&
          rec.mountParent === undefined
        ) {
          item.footprintOverride = { ...dov.box };
        }
        FURNITURE.push(item);
        this.registerFurnitureGroup(item, /* reveal */ true);
        changedIds.add(id);
      } else if (
        existing.pos.x !== rec.x ||
        existing.pos.z !== rec.z ||
        existing.rot !== rec.rot ||
        existing.mountParent !== rec.mountParent
      ) {
        this.evictAndDefocusForItem(id);
        existing.pos = { x: rec.x, z: rec.z };
        existing.rot = rec.rot;
        // A moved item sheds its hand-authored obstacle override (matches
        // commitCarry) — the derived footprint is now the honest obstacle.
        // Moved BACK to the exact default pose, it takes the authored box
        // again (keeps every client's grid identical for default layouts).
        const mdov = DEFAULT_FOOTPRINT_OVERRIDES[id];
        if (
          mdov &&
          rec.x === mdov.x &&
          rec.z === mdov.z &&
          rec.rot === mdov.rot &&
          rec.mountParent === undefined
        ) {
          existing.footprintOverride = { ...mdov.box };
        } else if (existing.footprintOverride !== undefined) {
          delete existing.footprintOverride;
        }
        const group = this.furnitureGroups.get(id);
        if (group) {
          group.position.set(rec.x, 0, rec.z);
          group.rotation.y = furnitureVisualYaw(existing);
        }
        changedIds.add(id);
      }
    }

    // Floor-plan work: run BEFORE the no-change early-return — the LOCAL
    // owner's own move self-echoes with an empty diff (see module header), and
    // their north door must still unblock. Cheap (one AABB test).
    this.updateNorthDoorForFireplace();
    this.updateSideWallCoverage(); // 🧱🪟 wall sections replace the built-in wall
    // 🏊 A pool added/removed toggles whether the outdoor room shows its solid
    // floor (cheap array scan; before the no-change return so a self-echoed
    // local removal still reveals the floor).
    this.refreshOutdoorFloor();

    if (changedIds.size === 0) return;

    // Same order commitCarry/commitSpawn use: seats AND devices bake world-space
    // fronts/poses off the fresh walkable grid, then replan in-flight nav.
    rebuildObstacles();
    rebakeWalkableGrid();
    rebuildSeats();
    rebuildStands();
    rebuildDevices();
    // 🤖 #77C: a placed/removed/moved charging-dock spawns/disposes/repositions
    // its robot (uses the route the room was last set up with).
    this.reconcileRobots(this.robotsPatrol);
    // Replan per changed item (review fix): onObstaclesChanged only cancels an
    // in-flight APPROACH/FINE/TURN toward the item when given that item's id —
    // a no-arg call left a joiner walking to (and sitting/focusing onto) where
    // a remotely moved/removed item USED to be. evictAndDefocusForItem above
    // handles the already-SEATED/FOCUSED case; this handles the approach case.
    for (const id of changedIds) {
      this.player.onObstaclesChanged(id);
    }

    // A live edit session indexed its raycast targets on enter; refresh it so
    // a remotely-added piece is selectable and a removed one drops out.
    if (roomEdit.isEditModeActive()) {
      roomEdit.forceExit();
      roomEdit.enter(this);
    }
  }

  /**
   * A remote layout change is about to move or remove item `id`. Protect the
   * LOCAL player from being stranded on it (issue #60 E4 hazards): stand them
   * up if seated on it, and drop a device focus anchored to it (the eye/anchor
   * baked in world space go stale the moment it moves). Seat ids are
   * `${itemId}:${idx}`; a device's id IS the item id (buildDeviceList).
   */
  private evictAndDefocusForItem(id: string): void {
    const seatedId = this.player.getSeatedSeatId();
    if (seatedId && seatedId.startsWith(`${id}:`)) {
      this.player.evictFromSeat();
    }
    if (deviceFocus.isActive() && deviceFocus.getActiveDeviceId() === id) {
      deviceFocus.forceRelease();
    }
  }

  /**
   * Despawn ONE furniture item's visuals and deregister every per-item
   * handle — the exact inverse of addLobbyFurniture's per-item registration
   * (#53 remove-to-inventory). Scene-graph and World-collection side only:
   * the FURNITURE registry splice and the rebake pipeline (obstacles → grid
   * → seats → devices → replan) are the CALLER's responsibility, mirroring
   * how commitCarry/spawnFurniture own that pipeline around their mutation.
   *
   * Disposal follows the removeRemotePlayer discipline: dedupe geometries
   * and materials (one material serves many meshes), never dispose the
   * shared OUTLINE_MAT (furniture groups don't contain it, but guard anyway
   * — #27's lesson), and dispose .map textures explicitly (the wall
   * computer's live screen CanvasTexture, the trunk's stencil decal) —
   * Material.dispose() does NOT free them.
   *
   * Deleting from wallScreens/trunkLids/holoSpinners is what stops update()
   * driving freed handles: the 1 Hz screen redraw, the per-frame lid ease
   * and the holo-ring spin all iterate those collections.
   */
  public removeFurnitureVisuals(itemId: string): boolean {
    const group = this.furnitureGroups.get(itemId);
    if (!group) return false;
    this.platformGroup.remove(group);
    this.furnitureGroups.delete(itemId);
    this.wallScreens.delete(itemId);
    this.trunkLids.delete(itemId);
    // #45 merge (review F1): without this, a removed game table leaves a live
    // handle — update() tweens against disposed meshes and the games-map
    // mirror re-uploads a freed CanvasTexture every doc change.
    this.gameTableTops.delete(itemId);
    // 🎰🤖 #77B: reclaim the croupier narration edge-detect entry for this table.
    this.croupierNarrated.delete(itemId);
    // 🎰 A roulette table removed mid-round must refund outstanding stakes (the
    // operator) and wipe its casino keys — else bettors' debited chips vanish
    // and table:/bets: records orphan. Runs pre-splice, so the kind is still known.
    if (FURNITURE.find((i) => i.id === itemId)?.kind === "roulette-table") {
      closeTable(itemId);
    }
    // 🧬 A vat removed mid-spawn-cycle must also release the held avatar —
    // its onOpen would otherwise never fire (only the HOLD watchdog would).
    if (this.cloneVats.delete(itemId) && this.player.isVatSpawning()) {
      this.player.abortVatSpawn();
    }

    const groupMeshes = new Set<THREE.Object3D>();
    const groupLights = new Set<THREE.PointLight>();
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    group.traverse((obj) => {
      if (obj instanceof THREE.PointLight) {
        groupLights.add(obj);
        obj.dispose();
        return;
      }
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      groupMeshes.add(mesh);
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || disposed.has(mat)) continue;
        disposed.add(mat);
        const map = (mat as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        mat.dispose();
      }
    });
    this.furnitureMeshes = this.furnitureMeshes.filter(
      (m) => !groupMeshes.has(m),
    );
    this.furnitureLights = this.furnitureLights.filter(
      ({ light }) => !groupLights.has(light),
    );
    this.holoSpinners = this.holoSpinners.filter(
      ({ mesh }) => !groupMeshes.has(mesh),
    );
    return true;
  }

  /**
   * Add atmosphere effects: pendant lights, holographic display,
   * space-view windows, floating particles.
   */
  private addAtmosphereEffects() {
    const m = (
      color: number,
      rough = 0.72,
      metal = 0.06,
      em = 0x000000,
      emI = 0,
    ) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: rough,
        metalness: metal,
        emissive: em,
        emissiveIntensity: emI,
        transparent: true,
        opacity: 0,
      });

    const place = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      ry = 0,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      this.platformGroup.add(mesh);
      this.furnitureMeshes.push(mesh);
      return mesh;
    };

    const addLight = (
      light: THREE.PointLight,
      x: number,
      y: number,
      z: number,
      ti: number,
    ) => {
      light.position.set(x, y, z);
      this.platformGroup.add(light);
      this.furnitureLights.push({ light, targetIntensity: ti });
    };

    // ── SPACE-VIEW WINDOWS on side walls ──────────────────────────────────────
    const makeStarTex = (top: string, bot: string): THREE.CanvasTexture => {
      const cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 192;
      const ctx = cv.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 0, 192);
      g.addColorStop(0, top);
      g.addColorStop(1, bot);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 192);
      for (let i = 0; i < 140; i++) {
        ctx.beginPath();
        ctx.arc(
          Math.random() * 256,
          Math.random() * 192,
          Math.random() * 1.3,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.65})`;
        ctx.fill();
      }
      // Soft nebula bloom
      for (let i = 0; i < 2; i++) {
        const gr = ctx.createRadialGradient(
          Math.random() * 256,
          Math.random() * 192,
          4,
          128,
          96,
          70,
        );
        gr.addColorStop(
          0,
          i === 0 ? "rgba(80,170,255,0.20)" : "rgba(255,150,70,0.14)",
        );
        gr.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, 256, 192);
      }
      const starTex = new THREE.CanvasTexture(cv);
      // Nearest-neighbour keeps the tiny pixel stars crisply rendered.
      starTex.minFilter = THREE.NearestFilter;
      starTex.magFilter = THREE.NearestFilter;
      starTex.generateMipmaps = false;
      return starTex;
    };

    const winGeo = new THREE.PlaneGeometry(2.2, 1.65);
    const winZs = [-2.8, 0.6];
    winZs.forEach((wz) => {
      // Left wall — cool cerulean tint
      const winL = new THREE.Mesh(
        winGeo.clone(),
        new THREE.MeshBasicMaterial({
          map: makeStarTex("#010d22", "#041530"),
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
        }),
      );
      winL.rotation.y = Math.PI / 2;
      winL.position.set(-5.81, 2.1, wz);
      this.platformGroup.add(winL);
      this.furnitureMeshes.push(winL);
      // Frame
      place(
        new THREE.BoxGeometry(0.06, 1.85, 2.42),
        m(0x8899aa, 0.48, 0.62),
        -5.84,
        2.1,
        wz,
      );
      addLight(new THREE.PointLight(0x3388ff, 0, 4.5), -5.5, 2.1, wz, 0.5);

      // Right wall removed — no paintings or frames on that side
    });

    // (Coloured throw cushions moved into the sofa builders — furniture.ts.)

    // ── AMBIENT WALL LIGHT STRIPS — glowing accents at ceiling edge ───────────
    // Thin emissive strips along the top of each side wall (z axis, y=3.9)
    const stripMat = (col: number) =>
      new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0,
      });
    place(
      new THREE.BoxGeometry(0.04, 0.06, 10.8),
      stripMat(0x2266cc),
      -5.76,
      3.92,
      0,
    ); // left  — blue
    addLight(new THREE.PointLight(0x1155bb, 0, 14), -5.5, 3.8, 0, 0.55);

    // ── FLOATING DUST MOTES ───────────────────────────────────────────────────
    const COUNT = 220;
    this.particlePositions = new Float32Array(COUNT * 3);
    const pCols = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.particlePositions[i * 3] = (Math.random() - 0.5) * 10.5;
      this.particlePositions[i * 3 + 1] = Math.random() * 3.8 + 0.1;
      this.particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 10.5;
      const rc = Math.random();
      if (rc < 0.38) {
        pCols[i * 3] = 0.92;
        pCols[i * 3 + 1] = 0.78;
        pCols[i * 3 + 2] = 0.38;
      } // gold
      else if (rc < 0.62) {
        pCols[i * 3] = 0.25;
        pCols[i * 3 + 1] = 0.62;
        pCols[i * 3 + 2] = 1.0;
      } // blue
      else if (rc < 0.8) {
        pCols[i * 3] = 0.92;
        pCols[i * 3 + 1] = 0.42;
        pCols[i * 3 + 2] = 0.35;
      } // rose
      else {
        pCols[i * 3] = 1.0;
        pCols[i * 3 + 1] = 0.95;
        pCols[i * 3 + 2] = 0.85;
      } // warm white
    }
    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.particlePositions, 3),
    );
    this.particleGeo.setAttribute("color", new THREE.BufferAttribute(pCols, 3));
    this.particleMat = new THREE.PointsMaterial({
      size: 1.8,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    (this.particleMat as THREE.PointsMaterial & { fog: boolean }).fog = false;
    this.platformGroup.add(
      new THREE.Points(this.particleGeo, this.particleMat),
    );

    console.log("✅ Atmosphere effects built");
  }

  // ── 💦 Splash bursts — one-shot water-entry particles (Lido pool) ──────────

  /**
   * Spawn a short-lived splash burst at a pool water-entry point. Mirrors the
   * dust-mote Points pattern above but with a finite lifetime: upward cone
   * velocities under gravity, faded out and disposed after `life` seconds.
   * Fired locally via player.onWaterEntry and for REMOTE peers on the tick
   * flag edges (see updateRemotePlayer) — no extra network message needed.
   */
  public spawnSplash(x: number, y: number, z: number, big = true): void {
    const count = big ? 48 : 24;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Seed in a small disc at the entry point.
      const seedA = Math.random() * Math.PI * 2;
      const seedR = Math.random() * 0.15;
      positions[i * 3] = x + Math.cos(seedA) * seedR;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z + Math.sin(seedA) * seedR;
      // Upward cone: random horizontal direction, strong vertical kick.
      const a = Math.random() * Math.PI * 2;
      const h = 0.3 + Math.random() * (big ? 1.4 : 0.9);
      vel[i * 3] = Math.cos(a) * h;
      vel[i * 3 + 1] = 1.6 + Math.random() * 1.8;
      vel[i * 3 + 2] = Math.sin(a) * h;
      // Cyan→white droplet mix.
      const w = Math.random();
      colors[i * 3] = 0.55 + w * 0.35;
      colors[i * 3 + 1] = 0.85 + w * 0.15;
      colors[i * 3 + 2] = 1.0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.4,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    (mat as THREE.PointsMaterial & { fog: boolean }).fog = false;
    const points = new THREE.Points(geo, mat);
    this.platformGroup.add(points);
    this.splashes.push({ points, geo, mat, vel, age: 0, life: 0.65 });
  }

  /** Advance every live splash: ballistic droplets, fade, dispose on expiry. */
  private updateSplashes(deltaTime: number): void {
    for (let s = this.splashes.length - 1; s >= 0; s--) {
      const splash = this.splashes[s];
      splash.age += deltaTime;
      if (splash.age >= splash.life) {
        this.platformGroup.remove(splash.points);
        splash.geo.dispose();
        splash.mat.dispose();
        this.splashes.splice(s, 1);
        continue;
      }
      const pos = splash.geo.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const n = arr.length / 3;
      for (let i = 0; i < n; i++) {
        arr[i * 3] += splash.vel[i * 3] * deltaTime;
        arr[i * 3 + 1] += splash.vel[i * 3 + 1] * deltaTime;
        arr[i * 3 + 2] += splash.vel[i * 3 + 2] * deltaTime;
        splash.vel[i * 3 + 1] -= 6.5 * deltaTime; // gravity
      }
      pos.needsUpdate = true;
      splash.mat.opacity = 0.95 * (1 - splash.age / splash.life);
    }
  }

  /**
   * Start morphing from planet to platform
   */
  public startMorph() {
    if (this.isMorphing) return;
    // Morph restart: instantly tear down any live device focus (ortho camera
    // + avatar restored, player released) before the room rebuilds — plan
    // §D0.3 force-release rule. Edit mode force-exits for the same reason
    // (#25 plan §4.5 — highlights restored, grid hidden).
    deviceFocus.forceRelease();
    roomEdit.forceExit();
    // #51: paired-door vestibules belong to the docking system being rebuilt
    // by createPlatform — dispose them all (clears the transit latch too).
    for (const doorId of [...this.pairedVestibules.keys()])
      this.disposeVestibule(doorId);
    this.isMorphing = true;
    this.morphProgress = 0;
    this.createPlatform();
    console.log("🔄 Morphing station planet into platform...");
  }

  /**
   * Add glowing corner markers for sci-fi feel
   */
  private addCornerMarkers() {
    const markerGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8);
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffaa22,
      emissive: 0xffaa22,
      emissiveIntensity: 0.9,
      metalness: 0.8,
      roughness: 0.2,
      transparent: true,
      opacity: 0,
    });

    // Markers sit 0.5 m inside each corner (walls at ±half). Default ±5.5.
    const { halfX, halfZ } = roomHalfExtents();
    const mx = halfX - 0.5,
      mz = halfZ - 0.5;
    const positions = [
      [-mx, 0.2, -mz],
      [mx, 0.2, -mz],
      [-mx, 0.2, mz],
      [mx, 0.2, mz],
    ];

    positions.forEach(([x, y, z]) => {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(x, y, z);
      this.platformGroup.add(marker);
      this.platformElements.push(marker);

      const cornerLight = new THREE.PointLight(0xffaa22, 0, 5);
      cornerLight.position.set(x, y, z);
      this.platformGroup.add(cornerLight);
      this.platformElements.push(cornerLight);
    });
  }

  /**
   * Add edge lights to mark platform boundaries
   */
  private addPlatformEdgeLights() {
    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x1e88e5,
      transparent: true,
      opacity: 0,
    });

    const { halfX, halfZ } = roomHalfExtents();
    const edgeGeometry = new THREE.BoxGeometry(2 * halfX, 0.05, 0.1);

    const northEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    northEdge.position.set(0, 0.03, -halfZ);
    this.platformGroup.add(northEdge);
    this.platformElements.push(northEdge);

    const southEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    southEdge.position.set(0, 0.03, halfZ);
    this.platformGroup.add(southEdge);
    this.platformElements.push(southEdge);

    const eastEdgeGeometry = new THREE.BoxGeometry(0.1, 0.05, 2 * halfZ);
    const westEdge = new THREE.Mesh(eastEdgeGeometry, edgeMaterial.clone());
    westEdge.position.set(-halfX, 0.03, 0);
    this.platformGroup.add(westEdge);
    this.platformElements.push(westEdge);
  }

  /**
   * Update morph animation
   */
  private updateMorph(deltaTime: number) {
    if (!this.isMorphing) return;

    this.morphProgress += deltaTime / this.morphDuration;

    if (this.morphProgress >= 1) {
      this.morphProgress = 1;
      this.isMorphing = false;
      this.player.mesh.visible = true;
      this.platformGroup.position.set(0, 0, 0);
      console.log("✅ Morph complete - Platform active");
      // 🧬 Diegetic boot spawn: if this room has a clone vat, the fresh
      // avatar materialises INSIDE it (held, tank full) and the reveal cycle
      // is deferred until the player actually looks at the room (update()'s
      // zoom ≤ 2 gate) — it would otherwise play unseen behind the exterior
      // boot view (#65). Vat-less rooms (docs seeded before this feature)
      // keep the legacy mid-room spawn.
      const vat = this.findSpawnVat();
      if (vat) {
        this.player.beginVatSpawn(
          { x: vat.item.pos.x, z: vat.item.pos.z },
          vat.item.rot * (Math.PI / 2),
        );
        this.pendingVatSpawn = true;
        this.vatSawExterior = false;
        this.pendingVatSpawnGrace = 8; // fallback only — see the field docs
      }
    }

    const t = this.morphProgress;
    const eased = 1 - Math.pow(1 - t, 3);

    this.platformGroup.position.lerp(new THREE.Vector3(0, 0, 0), eased);

    // Shrink and fade planet
    if (this.stationPlanet) {
      const scale = 1 - eased;
      this.stationPlanet.scale.setScalar(scale);
      (this.stationPlanet.material as THREE.MeshStandardMaterial).opacity =
        scale;
      (this.stationPlanet.material as THREE.MeshStandardMaterial).transparent =
        true;
      if (this.morphProgress >= 1) {
        this.platformGroup.remove(this.stationPlanet);
        this.stationPlanet = null;
        this.orbitRingOuter = null;
        this.orbitRingInner = null;
      }
    }

    // Fade in platform floor
    if (this.platformFloor) {
      (this.platformFloor.material as THREE.MeshStandardMaterial).opacity =
        eased * 0.9;
    }

    // The platform grid is an EDIT-MODE affordance (E2 of #25) — it no
    // longer auto-shows during the morph; setEditMode() owns its visibility.
    // (It sat under the near-opaque wooden floor anyway.)

    // Fade in all platform elements
    this.platformElements.forEach((element) => {
      if (element instanceof THREE.Mesh && element.material) {
        const material = element.material as
          | THREE.MeshStandardMaterial
          | THREE.MeshBasicMaterial;
        if ("opacity" in material) {
          material.opacity = eased * 0.6;
        }
      } else if (element instanceof THREE.PointLight) {
        element.intensity = eased * 0.5;
      }
    });

    // Fade in side walls — semi-transparent glass feel
    this.sideWalls.forEach((wall) => {
      (wall.material as THREE.MeshStandardMaterial).opacity = eased * 0.35;
    });
    if (this.northWall) {
      (this.northWall.material as THREE.MeshStandardMaterial).opacity =
        eased * 0.35;
    }

    // Fade in furniture to its design opacity — materials declaring a
    // userData.baseOpacity (the map table's translucent holo disc/ring, M4)
    // fade toward that instead of 1.0 (same contract as zoom.ts's avatar fade).
    this.furnitureMeshes.forEach((mesh) => {
      const mat = mesh.material as
        | THREE.MeshStandardMaterial
        | THREE.MeshBasicMaterial;
      if ("opacity" in mat)
        mat.opacity = eased * ((mat.userData.baseOpacity as number) ?? 1);
    });

    // Fade in lobby point lights
    this.furnitureLights.forEach(({ light, targetIntensity }) => {
      light.intensity = eased * targetIntensity;
    });

    // Fade in floating particles
    if (this.particleMat) this.particleMat.opacity = eased * 0.7;
  }

  /**
   * Update world state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    this.time += deltaTime;

    this.updateMorph(deltaTime);

    // Retrieve active zoom level to adjust interior vs exterior capsule visibility selectively (Level 3 optimization)
    const zoomView = (window as any).multiScaleZoom;
    const zoomLevel = zoomView
      ? typeof zoomView.getLevel === "function"
        ? zoomView.getLevel()
        : 2
      : 2;

    // 🧬 Deferred boot spawn: run the vat reveal the first frame the player
    // actually sees the room interior (zoom ≤ 2) — queued at morph-complete.
    // Armed by SEEING the exterior boot view first (zoom ≥ 3), so the reveal
    // always lands on the deliberate zoom-in no matter how long the
    // join-under-intro flip takes; the long grace is a fallback for boots
    // that never flip to the exterior at all.
    if (this.pendingVatSpawn && !this.isMorphing) {
      if (zoomLevel >= 3) this.vatSawExterior = true;
      this.pendingVatSpawnGrace -= deltaTime;
      if (
        (this.vatSawExterior || this.pendingVatSpawnGrace <= 0) &&
        zoomLevel <= 2
      ) {
        this.pendingVatSpawn = false;
        this.respawnAtVat();
      }
    }

    if (zoomLevel >= 3) {
      // Hide interior furniture so it is not visible through walls or wastes render power
      this.furnitureMeshes.forEach((mesh) => {
        mesh.visible = false;
      });
      // Hide side walls & flooring (which is cut off by the capsule envelope)
      if (this.platformFloor) this.platformFloor.visible = false;
      this.sideWalls.forEach((wall) => {
        wall.visible = false;
      });
      if (this.northWall) this.northWall.visible = false;
      // 🛑📐 #80 S1: the interior octagon barrel gives way to the exterior
      // capsule at zoom ≥ 3 (same as the interior side walls).
      if (this.octagonHull) this.octagonHull.group.visible = false;

      if (zoomLevel === 4) {
        // Level 4 (Space Station) uses a simpler silhouette/solid representation of the capsules
        if (this.capsuleRoof) {
          this.capsuleRoof.visible = true;
          // Apply a matte structural slate gray style to represent a simplified silhouette unit
          (
            this.capsuleRoof.material as THREE.MeshStandardMaterial
          ).color.setHex(0x1b2835);
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).roughness =
            0.9;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).metalness =
            0.1;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).opacity =
            1.0;
        }
        this.capsuleOuterWalls.forEach((wall) => {
          wall.visible = true;
          (wall.material as THREE.MeshStandardMaterial).color.setHex(0x1b2835);
          (wall.material as THREE.MeshStandardMaterial).roughness = 0.9;
          (wall.material as THREE.MeshStandardMaterial).metalness = 0.1;
          (wall.material as THREE.MeshStandardMaterial).opacity = 1.0;
        });
      } else {
        // Level 3 (Outside Room) uses the high-fidelity metal capsule texture mapping
        if (this.capsuleRoof) {
          this.capsuleRoof.visible = true;
          (
            this.capsuleRoof.material as THREE.MeshStandardMaterial
          ).color.setHex(0x2a3e52);
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).roughness =
            0.4;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).metalness =
            0.8;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).opacity =
            1.0;
        }
        this.capsuleOuterWalls.forEach((wall) => {
          wall.visible = true;
          (wall.material as THREE.MeshStandardMaterial).color.setHex(0x2a3e52);
          (wall.material as THREE.MeshStandardMaterial).roughness = 0.4;
          (wall.material as THREE.MeshStandardMaterial).metalness = 0.8;
          (wall.material as THREE.MeshStandardMaterial).opacity = 1.0;
        });
      }
      // 🛑📐 #80 S1 preview: hide the flat box capsule so the exterior OCTAGON
      // shell (built by exteriorView at zoom 3) is the module's outside skin.
      if (OCTAGON_HULL) {
        if (this.capsuleRoof) this.capsuleRoof.visible = false;
        this.capsuleOuterWalls.forEach((wall) => {
          wall.visible = false;
        });
      }
    } else {
      // Restore interior rendering when playing inside levels <= 2 (Room / First-Person)
      this.furnitureMeshes.forEach((mesh) => {
        mesh.visible = true;
      });
      // 🏊 Outdoor pool room: legacy hides the floor (deck slabs are the floor;
      // sunken water shows through). Under the octagon flag the floor stays
      // SOLID with a pool hole cut (refreshOutdoorFloor), so keep it visible.
      if (this.platformFloor)
        this.platformFloor.visible = OCTAGON_HULL || !this.isOutdoorRoom;
      // 🛑📐 #80: the octagon floor is SOLID by default now (basement hidden
      // beneath it); a hole is cut only where a pool sinks into the basement
      // (setFloorHoles → makeFloorGeometry). No blanket hide.
      // 🧱🪟 Placed wall sections REPLACE a built-in side wall — the interior
      // restore must not resurrect a covered one (nor one dropped for 🛰️
      // HULL EDIT).
      this.sideWalls.forEach((wall, i) => {
        wall.visible = !this.hullEditView && !this.sideWallCovered[i];
      });
      if (this.northWall) this.northWall.visible = !this.hullEditView;
      // 🛑📐 #80 S1: restore the interior octagon barrel at room/first-person.
      if (this.octagonHull) this.octagonHull.group.visible = !this.hullEditView;

      // Completely clear and hide outer capsule roof and shielding so they don't block the camera!
      if (this.capsuleRoof) {
        this.capsuleRoof.visible = false;
      }
      this.capsuleOuterWalls.forEach((wall) => {
        wall.visible = false;
      });
    }

    // Animate station planet (rotation + gentle floating)
    if (this.stationPlanet) {
      this.stationPlanet.rotation.y += deltaTime * 0.3;
      this.stationPlanet.rotation.x = Math.sin(this.time * 0.5) * 0.05;
      this.stationPlanet.position.y = Math.sin(this.time * 0.8) * 0.15;
    }
    // 🪐 Overhead deck ocean-planet: a slow, calm spin (only while on a deck).
    if (this.isOutdoorDeck && this.deckPlanet) {
      this.deckPlanet.rotation.y += deltaTime * 0.015;
    }

    // Keep updating while device-FOCUSED too: the mesh is hidden then, but
    // player.update() is where WASD-to-release lives (#33 D0.3).
    if (this.isPlayerActive()) {
      this.player.update(deltaTime, inputManager);
    }

    // Animate networked peer replicas (issue #21 — fox avatars, not spheres)
    this.updateRemoteAvatars(deltaTime);

    // Advance door leaf slides (update-loop driven, completion-signalled)
    if (this.dockingSystem) {
      this.dockingSystem.update(deltaTime);
      // #51 camera-facing door fade: only while the ortho room camera is
      // live (zoom 2–4 — visually it only matters at 2), never during the
      // morph, first person (level 1) or a device-focus camera.
      const fadeEnabled =
        !this.isMorphing &&
        zoomLevel >= 2 &&
        zoomLevel <= 4 &&
        !deviceFocus.isActive();
      this.dockingSystem.updateFacingFade(
        deltaTime,
        fadeEnabled,
        this.player.getActiveDoorId(),
      );
    }

    // 🛑📐 #80 S1: drive the octagon hull's camera-facing wall transparency —
    // near faces (outside skin toward the camera) fade so the iso view sees
    // into the room; far faces stay glassy showing their inside surface. In
    // first person (zoom ≤ 1) every wall stays solid. Same camera-XZ math as
    // the #51 door fade above.
    if (this.octagonHull) {
      const yaw = getCameraYaw();
      const camX = (Math.cos(yaw) + Math.sin(yaw)) * Math.SQRT1_2;
      const camZ = (Math.cos(yaw) - Math.sin(yaw)) * Math.SQRT1_2;
      this.octagonHull.updateFacing(camX, camZ, zoomLevel <= 1);
    }

    // Advance trunk lid swings (TR2 — same update-loop-driven idiom)
    for (const lid of this.trunkLids.values()) lid.update(deltaTime);

    // Advance game-table top flips (#45 — same update-loop-driven idiom)
    for (const top of this.gameTableTops.values()) top.update(deltaTime);

    // 🧬 Advance clone-vat drain / door-spin cycles (same idiom)
    for (const vat of this.cloneVats.values()) vat.update(deltaTime);

    // 🤖 Service/croupier robots: each patrols/serves/docks; local ambience.
    const activePlayer = this.isPlayerActive() ? this.player : null;
    for (const bot of this.robots.values()) bot.update(deltaTime, activePlayer);

    // 🎰🤖 #77B: post the robot at the roulette wheel-head, narrate the calls
    // (all clients), and drive the betting timer (the elected operator only).
    this.updateCroupier();

    // #51 — paired-door vestibules: spawn/dispose from pairing state, drive
    // the proximity/transit opacity, honor zoom-hide (≥3) and the morph.
    // (Supersedes the old transitVestibule visibility line #45 sat next to.)
    this.updatePairedVestibules(deltaTime, zoomLevel);
    this.updateFirstPersonAutoDoors(zoomLevel);

    // Drive the device-focus camera eases + focused UI (#33 D0)
    deviceFocus.update(deltaTime);

    // Drive room-edit mode (E2 of #25): force-exit when the view leaves the
    // plain isometric room (zoom ≠ 2 / solar map) + selection-label tracking.
    roomEdit.update();

    // 🎰 Show the table standing-position rings only while room-editing, so the
    // owner can see where the stand slots land as they move a table (#76).
    this.updateStandMarkers();

    // 1 Hz idle status on wall-computer screens (M1 — the permanent home of
    // PR #36's dev-hook wiring; same live values, same cadence).
    if (this.wallScreens.size > 0) {
      this.screenStatusTimer += deltaTime;
      if (this.screenStatusTimer >= 1.0) {
        this.screenStatusTimer = 0;
        const status = readLiveRoomStatus();
        for (const screen of this.wallScreens.values()) {
          screen.updateStatus(status);
        }
      }
    }

    // Float dust motes upward, reset at ceiling
    if (this.particlePositions && this.particleGeo) {
      const n = this.particlePositions.length / 3;
      for (let i = 0; i < n; i++) {
        this.particlePositions[i * 3 + 1] += deltaTime * 0.09;
        if (this.particlePositions[i * 3 + 1] > 4.0) {
          this.particlePositions[i * 3 + 1] = 0.05;
          this.particlePositions[i * 3] = (Math.random() - 0.5) * 10.5;
          this.particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 10.5;
        }
      }
      (
        this.particleGeo.attributes.position as THREE.BufferAttribute
      ).needsUpdate = true;
    }

    // 💦 Advance/cull one-shot splash bursts
    this.updateSplashes(deltaTime);

    // Spin the orbital rings above the platform
    if (this.orbitRingOuter) this.orbitRingOuter.rotation.y += 0.004;
    if (this.orbitRingInner) this.orbitRingInner.rotation.y -= 0.006;

    // Spin the map table's holographic ring (M4) — the ring geometry is baked
    // flat (geometry rotateX), so a plain rotation.y increment spins it about
    // the world-up axis.
    for (const { mesh, speed } of this.holoSpinners) {
      mesh.rotation.y += speed * deltaTime;
    }
  }

  public remotePlayers: Map<string, RemoteAvatar> = new Map();

  /** Stable [0,1) hash of a peer id (FNV-1a) — drives the per-peer fur tint. */
  private static peerHue01(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) / 0x100000000;
  }

  /**
   * Recolor a freshly-built rig so each peer is visually distinct. Skips the
   * shared OUTLINE_MAT (one instance serves every rig — recoloring it would
   * repaint everyone's outlines) and dedupes materials, since one material is
   * reused by many meshes within a rig and offsetHSL is cumulative.
   */
  private applyPeerTint(rig: VoxelCharacter, id: string): void {
    const hueShift = World.peerHue01(id) * 0.9 - 0.45;
    const seen = new Set<THREE.Material>();
    rig.masterGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || seen.has(mat)) continue;
        seen.add(mat);
        const colored = mat as THREE.MeshToonMaterial;
        if (colored.color) colored.color.offsetHSL(hueShift, 0, 0);
        // Toon materials carry a matching emissive tint — shift it too so the
        // recolor holds up in dim light.
        if (colored.emissive) colored.emissive.offsetHSL(hueShift, 0, 0);
      }
    });
  }

  public updateRemotePlayer(
    id: string,
    x: number,
    z: number,
    moving: boolean = false,
    seated: boolean = false,
    facing: number = 0,
    lying: boolean = false,
    elevated: boolean = false,
    swimming: boolean = false,
    diving: boolean = false,
  ) {
    // 🏊/🛏️ The tick carries no y — derive the seat height locally: SEATS is
    // built from the SAME synced furniture doc on every client, so the seat
    // whose sit point matches the sender's position carries the authoritative
    // sitY (4.55 dive board, -0.20 pool water, 1.32 top bunk). The old
    // elevated/swim bits stay as fallbacks for a transiently out-of-sync
    // seat list (e.g. furniture doc still loading on this end).
    const seatHere = seated
      ? (SEATS.find((s) => Math.hypot(s.sit.x - x, s.sit.z - z) < 0.35) ?? null)
      : null;
    const elevY = seatHere
      ? seatHere.sitY
      : swimming
        ? POOL_SWIM_Y
        : elevated
          ? BUNK_TOP_Y
          : 0;
    const avatar = this.remotePlayers.get(id);
    if (!avatar) {
      console.log(`🤖 Spawning remote player fox avatar: ${id}`);
      // Parent the rig to the same scene the local player's rig lives in
      // (player.ts hands the raw scene to VoxelCharacter) so both share
      // identical transforms. Floor-anchored at y=0, like the local player.
      // 🏊‍♂️ A peer already mid-dive when we join gets no rising edge — it
      // replays a short low arc from y 0 and still splashes on the falling
      // edge. Accepted ~1 s degradation; no extra protocol.
      const rig = new VoxelCharacter(this.scene);
      rig.masterGroup.position.set(x, 0, z);
      this.applyPeerTint(rig, id);
      this.remotePlayers.set(id, {
        rig,
        targetX: x,
        targetZ: z,
        lastX: x,
        lastZ: z,
        moving,
        seated,
        facing,
        lying,
        elevY,
        heading: 0,
        swimming,
        diving,
        diveAge: diving ? 0 : null,
        diveStartY: 0,
      });
      return;
    }
    // 🏊‍♂️ bit5 rising edge: start the local arc replay from wherever the
    // replica currently is (≈ board top thanks to the seat-derived elevY).
    if (!avatar.diving && diving) {
      avatar.diveAge = 0;
      avatar.diveStartY = avatar.rig.masterGroup.position.y;
    }
    // 💦 bit5 falling edge = water entry (big splash); a swim rise WITHOUT a
    // preceding dive = deck slide-in (small splash).
    if (avatar.diving && !diving) {
      avatar.diveAge = null;
      this.spawnSplash(x, POOL_WATER_Y, z, true);
    } else if (!avatar.swimming && swimming && !avatar.diving) {
      this.spawnSplash(x, POOL_WATER_Y, z, false);
    }
    // Store the network target; per-frame interpolation happens in
    // updateRemoteAvatars (Task 3.4 interpolation, now frame-rate-safe).
    avatar.targetX = x;
    avatar.targetZ = z;
    avatar.moving = moving;
    avatar.seated = seated;
    avatar.facing = facing;
    avatar.lying = lying;
    avatar.elevY = elevY;
    avatar.swimming = swimming;
    avatar.diving = diving;
  }

  /**
   * Per-frame remote-avatar animation: lerp toward the network target, derive
   * an 8-way heading from actual motion, and drive the walk/idle rig states.
   */
  private updateRemoteAvatars(deltaTime: number): void {
    // Frame-rate-safe equivalent of the old fixed 0.28-per-frame lerp at 60fps.
    const factor = 1 - Math.pow(1 - 0.28, deltaTime * 60);
    for (const avatar of this.remotePlayers.values()) {
      const pos = avatar.rig.masterGroup.position;
      avatar.lastX = pos.x;
      avatar.lastZ = pos.z;
      pos.x = THREE.MathUtils.lerp(pos.x, avatar.targetX, factor);
      pos.z = THREE.MathUtils.lerp(pos.z, avatar.targetZ, factor);
      // 🛏️ Berth elevation: rises onto the top bunk while seated+elevated,
      // settles back to the floor otherwise — same lerp cadence as x/z, so the
      // replica's climb roughly shadows the sender's sit-down slide.
      // 🏊 A free-swimming peer (bit4 WITHOUT bit1) floats at POOL_SWIM_Y.
      // 🌉 A walking peer on the hot-tub footbridge arcs up the deck height,
      // derived locally from its xz — the movement tick carries no y.
      const groundY = bridgeDeckY(FURNITURE, pos.x, pos.z) ?? 0;
      pos.y = THREE.MathUtils.lerp(
        pos.y,
        avatar.seated ? avatar.elevY : avatar.swimming ? POOL_SWIM_Y : groundY,
        factor,
      );

      // 🏊‍♂️ Mid dive arc (flags bit5): x/z keep following the sender's 20 Hz
      // samples via the normal lerp above; y is replayed locally with the SAME
      // parabola constants as the sender (the tick carries no y). The yaw
      // field carries the arc heading while diving.
      if (avatar.diving) {
        avatar.diveAge = (avatar.diveAge ?? 0) + deltaTime;
        const t = Math.min(1, avatar.diveAge / DIVE_TIME);
        pos.y =
          avatar.diveStartY +
          (POOL_SWIM_Y - avatar.diveStartY) * t * t +
          DIVE_ARC_LIFT * 4 * t * (1 - t);
        avatar.rig.setState("dive", avatar.facing);
        avatar.rig.update();
        continue;
      }

      // Robust moving detection: trust the sender's flag OR the fact that we
      // are still visibly far from the target — animates even when the flag is
      // unreliable, and settles to idle on arrival.
      // #63: a seated peer renders the sit pose at the seat facing and skips the
      // motion-derived walk/idle path entirely (still lerps to the seat point).
      // 🛏️ A lying peer (flags bit2) renders the 'sleep' pose instead.
      // 🏊 A swimming peer (flags bit4) renders the 'swim' pose at POOL_SWIM_Y.
      if (avatar.seated) {
        avatar.rig.setState(
          avatar.swimming ? "swim" : avatar.lying ? "sleep" : "sit_chair",
          avatar.facing,
        );
        avatar.rig.update();
        continue;
      }

      const remaining = Math.hypot(
        avatar.targetX - pos.x,
        avatar.targetZ - pos.z,
      );
      const moving = avatar.moving || remaining > 0.05;

      const dx = pos.x - avatar.lastX;
      const dz = pos.z - avatar.lastZ;
      if (moving && Math.hypot(dx, dz) > 1e-4) {
        avatar.heading = snapTo8Ways(Math.atan2(dx, dz));
      }

      // 🏊 Free-swimming peers paddle in place / glide — never 'walk' on water.
      avatar.rig.setState(
        avatar.swimming ? "swim" : moving ? "walk" : "idle",
        avatar.heading,
      );
      avatar.rig.update(); // exactly once per frame per rig (per-instance clock)
    }
  }

  /** 🛰️ #65 boot flow: main.ts waits for the intro morph before presenting
   *  the exterior (the hull shell over a half-morphed platform looks wrong). */
  public isMorphActive(): boolean {
    return this.isMorphing;
  }

  /** 🛰️ Exterior view: the live paired-connector groups (raycast targets for
   *  the click-a-joint bend editor). */
  public getPairedVestibuleGroups(): Map<string, THREE.Group> {
    return new Map(this.pairedVestibules);
  }

  /** 💬 Chat bubbles: live snapshot of every remote avatar's rendered position
   *  (keyed by lane-derived peer id — the bubble anchor). */
  public getRemoteAvatarSnapshots(): Array<{
    id: string;
    x: number;
    z: number;
  }> {
    const out: Array<{ id: string; x: number; z: number }> = [];
    for (const [id, avatar] of this.remotePlayers) {
      const pos = avatar.rig.masterGroup.position;
      out.push({ id, x: pos.x, z: pos.z });
    }
    return out;
  }

  /** Despawn a remote player replica (peer left / stopped ticking — issue #22). */
  public removeRemotePlayer(id: string) {
    const avatar = this.remotePlayers.get(id);
    if (!avatar) return;
    console.log(`👋 Despawning remote player fox avatar: ${id}`);
    const root = avatar.rig.masterGroup;
    root.parent?.remove(root);
    // VoxelCharacter has no dispose(): free geometries/materials by hand.
    // Dedupe (outline shells share their host's geometry; one material serves
    // many meshes) and NEVER dispose the shared OUTLINE_MAT.
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || disposed.has(mat)) continue;
        disposed.add(mat);
        // Material.dispose() does NOT free textures. The face decal is a
        // per-instance 512x512 mipmapped CanvasTexture on .map — dispose it
        // or every despawn strands ~1.3MB of GPU memory. Dispose .map ONLY:
        // toon materials keep the module-shared GRAD DataTexture in
        // .gradientMap (a different slot) and their .map is null.
        const map = (mat as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        mat.dispose();
      }
    });
    this.remotePlayers.delete(id);
  }

  /**
   * World positions of every remote player replica (E3 of #25 — the plan's
   * "read remote positions through a World accessor" rule: #27 owns the
   * replica representation, so validity checks must not reach into it).
   */
  public getRemotePlayerPositions(): Array<{ x: number; z: number }> {
    const positions: Array<{ x: number; z: number }> = [];
    for (const avatar of this.remotePlayers.values()) {
      const pos = avatar.rig.masterGroup.position;
      positions.push({ x: pos.x, z: pos.z });
    }
    return positions;
  }

  /** Despawn every remote player replica (room re-bootstrap). */
  public clearRemotePlayers() {
    for (const id of [...this.remotePlayers.keys()]) {
      this.removeRemotePlayer(id);
    }
  }

  public getPlayer(): Player {
    return this.player;
  }

  public getClickPlane(): THREE.Mesh | null {
    return this.clickPlane;
  }

  public navigateTo(x: number, z: number) {
    if (this.isPlayerActive()) {
      // 🏊 Free swim: the player handles in-water routing itself (straight
      // swim vs climb-out) — seat routing would bounce the swimmer through
      // the stand-up machinery for what is just open water.
      if (this.player.isFreeSwimming()) {
        this.player.navigateTo(x, z);
        return;
      }
      // Clicks landing on a chair/sofa footprint become sit requests:
      // walk to the seat front, turn back-to-the-chair, and sit down.
      const seat = findSeatAt(x, z);
      if (seat) {
        this.player.navigateToSeat(seat);
      } else {
        this.player.navigateTo(x, z);
      }
    }
  }

  /**
   * Route a door-body click into the player's walk-through sequence, wiring
   * the (docking-system-agnostic) door hooks to this world's docking ports.
   */
  public requestDoorWalkthrough(doorId: string): void {
    const door = findDoor(doorId);
    if (!door || !this.isPlayerActive() || !this.dockingSystem) return;

    if (!door.enabled) {
      showHint("This port is blocked by the hearth.");
      return;
    }

    // #67 D1: passage policy — an owner-restricted door refuses non-owners
    // before any walk choreography starts.
    if (!this.dockingSystem.canPass(door.id)) {
      const pol = readDoorPolicy(door.id);
      showHint(
        pol.passage === "public" && pol.oneWay === "in"
          ? "ONE-WAY door — travelers may only come IN through it (the owner passes freely)."
          : "This door's passage is restricted by the room owner.",
      );
      return;
    }

    // 🚪 Blocked-front fix (owner's report: SMALL doors 'sometimes' ignore
    // clicks): the small doors' stand-points (0, ±4.5) sit in the
    // furniture-heavy centre column — when furniture covers the front cell,
    // findPath fails and the walk silently dies. Retarget to the nearest
    // WALKABLE cell within 1.5 m of the front (biased to stay on the door's
    // approach axis) instead of giving up. Large doors' wall-hugging fronts
    // rarely need this; now neither kind ever no-ops.
    const walkableDoor = ((): DoorTarget => {
      const r = worldToRow(door.front.z),
        c = worldToCol(door.front.x);
      if (walkable[r]?.[c]) return door;
      let best: { x: number; z: number; d: number } | null = null;
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          if (!walkable[r + dr]?.[c + dc]) continue;
          const wx = colToWorld(c + dc),
            wz = rowToWorld(r + dr);
          const d = Math.hypot(wx - door.front.x, wz - door.front.z);
          if (d <= 1.6 && (!best || d < best.d)) best = { x: wx, z: wz, d };
        }
      }
      if (!best) {
        showHint("The doorway is blocked by furniture.");
        return door; // let the old behavior stand as the final fallback
      }
      return { ...door, front: { x: best.x, z: best.z } };
    })();

    const ds = this.dockingSystem;
    /** A door offers transit when its pairing completed with a target seed,
     *  main.ts wired a swap driver (T1 of #30), and no swap is already in
     *  flight (review fix F4 — a busy driver would silently drop the request,
     *  leaking the vestibule; fall through to the peek round-trip instead). */
    const transitReady = () => {
      if (this.isTransitBusy && this.isTransitBusy()) return false;
      const state = ds.getDockingState(door.id);
      return (
        !!(state && state.pairedSuccessfully && state.connectedRoomAddress) &&
        this.onAdapterTransit !== null
      );
    };
    this.player.navigateToDoor(walkableDoor, {
      requestOpen: (onOpened) => {
        const state = ds.getDockingState(door.id);
        if (state && state.locked) {
          showHint("Docking port is LOCKED. Use the keypad.");
          return false;
        }
        ds.openDoor(door.id, onOpened);
        return true;
      },
      requestClose: () => ds.closeDoor(door.id),
      onThrough: () => {
        const state = ds.getDockingState(door.id);
        showHint(
          transitReady()
            ? `Dock seal engaged at ${door.id.toUpperCase()} — cycling airlock…`
            : state && state.pairedSuccessfully
              ? `Docked room detected at ${door.id.toUpperCase()} — transit coming soon.`
              : "No room docked at this port — heading back.",
        );
      },
      // ── T1 adapter transit branch (consulted at the THROUGH completion) ──
      beginTransit: () => {
        if (!transitReady()) return false;
        // A live device focus/edit surface must never survive a room swap.
        // (It cannot actually be active here — the door machine and the
        //  device machine are mutually exclusive — but the transit is a hard
        //  scene change, so force-release defensively.)
        deviceFocus.forceRelease();
        roomEdit.forceExit();
        this.spawnTransitVestibule(door.id);
        return true;
      },
      // Avatar reached the vestibule hold point — run the swap (main.ts).
      onAdapterHold: () => {
        const state = ds.getDockingState(door.id);
        const seed = state?.connectedRoomAddress ?? "";
        this.onAdapterTransit?.(seed, door.id);
      },
    });
  }

  // ── Adapter transit choreography (T1 of issue #30) ──────────────────────────

  /**
   * Light the departure door's gangway vestibule 'cycling' for the transit
   * (#51 unification: transit rides the persistent paired-door vestibule —
   * transit is only offered on paired doors, so it already exists; built
   * defensively if it somehow doesn't). Departure side only — the arrival
   * room could briefly show one outside the arrival door too, but it would
   * exist for well under a second behind the full-screen fade, so that
   * polish is deliberately skipped.
   */
  /** #62 P3: build the door's connector from its pairing RECORD — an
   *  assembled chain when segments exist, the legacy straight gangway
   *  otherwise. The geometry key on userData drives rebuild-on-diff. */
  private buildDoorConnector(doorId: DoorId): THREE.Group {
    const segments = this.dockingSystem?.getDockingState(doorId)?.segments;
    const group =
      segments && segments.length > 0
        ? buildConnectorChain(doorId, segments)
        : buildVestibule(doorId);
    group.userData.segmentsKey = JSON.stringify(segments ?? null);
    return group;
  }

  private spawnTransitVestibule(doorId: DoorId): void {
    this.endTransitVestibule();
    let vestibule = this.pairedVestibules.get(doorId);
    if (!vestibule) {
      vestibule = this.buildDoorConnector(doorId);
      this.platformGroup.add(vestibule);
      this.pairedVestibules.set(doorId, vestibule);
    }
    setVestibuleLightState(vestibule, "cycling");
    this.transitVestibuleDoorId = doorId;
  }

  /**
   * Transit over: revert the vestibule lights to 'idle' and release the
   * transit latch. The vestibule itself persists while its door stays paired
   * (#51); updatePairedVestibules disposes it on unpair.
   */
  private endTransitVestibule(): void {
    const doorId = this.transitVestibuleDoorId;
    this.transitVestibuleDoorId = null;
    if (!doorId) return;
    const vestibule = this.pairedVestibules.get(doorId);
    if (vestibule) setVestibuleLightState(vestibule, "idle");
  }

  /** Remove and dispose one paired-door vestibule (geometries + materials). */
  private disposeVestibule(doorId: DoorId): void {
    const vestibule = this.pairedVestibules.get(doorId);
    if (!vestibule) return;
    this.pairedVestibules.delete(doorId);
    if (this.transitVestibuleDoorId === doorId)
      this.transitVestibuleDoorId = null;
    vestibule.parent?.remove(vestibule);
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    vestibule.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (!mat || disposed.has(mat)) continue;
        disposed.add(mat);
        mat.dispose();
      }
    });
  }

  /**
   * #51 — persistent translucent vestibules on paired doors, driven per
   * frame from update():
   *  - a door whose pairing just completed grows a vestibule (fading up from
   *    0 to the resting translucency); an unpaired door's vestibule is
   *    disposed (a mid-transit unpair defers to the transit's end),
   *  - opacity rests at VESTIBULE_BASE_OPACITY and lerps to solid as the
   *    player nears the door's front stand-point (within FADE_RANGE), forced
   *    solid during this door's transit AND during any door sequence on it
   *    (mid-PEEK the avatar STANDS inside the gangway, past the front point —
   *    distance alone would leave the tube half-ghosted around them),
   *  - honors the interior zoom-hide convention (≥3 hides) and the morph.
   */
  // ── 🚶 First-person automatic doors (owner request) ────────────────────────
  /** Doors this system slid open on approach (closed again on retreat). */
  private fpAutoOpened = new Set<DoorId>();
  /** One transit per aperture entry — re-armed only after stepping clear. */
  private fpTransitArmed = true;
  /** Post-arrival grace: the player SPAWNS at the arrival door, inside its
   *  aperture — without this the return transit would fire instantly. */
  private fpArrivalCooldownUntil = 0;

  /**
   * In FIRST PERSON (zoom 1), walking up to a passable PAIRED door slides it
   * open automatically (station doors, as is right and proper), and pressing
   * into the open doorway carries you through — the same transit the click
   * path runs, minus the scripted avatar walk (you ARE the walk). Doors we
   * opened close behind us on retreat/exit. Unpaired doors stay shut (there
   * is nothing on the other side to open onto), and every gate the click
   * path enforces applies: enabled (hearth), passage policy (#67), lock,
   * transit-driver readiness, swap-in-flight.
   */
  private updateFirstPersonAutoDoors(zoomLevel: number): void {
    const ds = this.dockingSystem;
    if (zoomLevel !== 1 || !ds || this.isMorphing || !this.isPlayerActive()) {
      if (this.fpAutoOpened.size && ds) {
        for (const id of this.fpAutoOpened) ds.closeDoor(id);
      }
      this.fpAutoOpened.clear();
      this.fpTransitArmed = true;
      return;
    }
    const p = this.player.getPosition();
    const now = performance.now();
    let inAnyAperture = false;
    for (const door of DOORS) {
      // Aperture frame: lateral offset along the wall vs distance INTO it.
      const northSouth = door.id === "north" || door.id === "south";
      const lateral = Math.abs(
        northSouth ? p.x - door.front.x : p.z - door.front.z,
      );
      const wallCoord = Math.abs(northSouth ? p.z : p.x);
      const approachDist = Math.hypot(p.x - door.front.x, p.z - door.front.z);

      const state = ds.getDockingState(door.id);
      const paired = !!(
        state &&
        state.pairedSuccessfully &&
        state.connectedRoomAddress
      );
      const passable = door.enabled && !state?.locked && ds.canPass(door.id);

      // Slide open on approach; slide shut once the player retreats.
      if (
        paired &&
        passable &&
        approachDist < 2.2 &&
        !this.fpAutoOpened.has(door.id)
      ) {
        ds.openDoor(door.id);
        this.fpAutoOpened.add(door.id);
      } else if (this.fpAutoOpened.has(door.id) && approachDist > 3.0) {
        ds.closeDoor(door.id);
        this.fpAutoOpened.delete(door.id);
      }

      // Threshold: pressed into the open doorway (the manual-movement clamp
      // stops the body at the wall, so "as far in as possible" IS the cross).
      // Wall is at ±halfZ (n/s) or ±halfX (e/w); trip 0.85 m short of it.
      const { halfX, halfZ } = roomHalfExtents();
      const apThresh = (northSouth ? halfZ : halfX) - 0.85;
      const inAperture = lateral < 0.95 && wallCoord > apThresh;
      if (inAperture) inAnyAperture = true;
      if (
        inAperture &&
        paired &&
        passable &&
        this.fpTransitArmed &&
        now > this.fpArrivalCooldownUntil &&
        !(this.isTransitBusy && this.isTransitBusy()) &&
        this.onAdapterTransit !== null
      ) {
        this.fpTransitArmed = false; // step clear to re-arm
        deviceFocus.forceRelease();
        roomEdit.forceExit();
        this.spawnTransitVestibule(door.id);
        this.onAdapterTransit?.(state!.connectedRoomAddress, door.id);
      }
    }
    if (!inAnyAperture) this.fpTransitArmed = true;
  }

  private updatePairedVestibules(deltaTime: number, zoomLevel: number): void {
    const ds = this.dockingSystem;
    if (!ds) return;
    const playerPos = this.player.getPosition();
    const activeDoorId = this.player.getActiveDoorId();

    for (const door of DOORS) {
      const state = ds.getDockingState(door.id);
      const paired = state?.pairedSuccessfully === true;
      // #62 P4: an UNPAIRED door with an assembled chain renders it as a GHOST
      // (fixed light translucency) so the builder sees the connection curve
      // before pairing — the plan's live-preview affordance.
      const ghost = !paired && (state?.segments?.length ?? 0) > 0;
      let vestibule = this.pairedVestibules.get(door.id);

      if (!paired && !ghost) {
        // Defer disposal while EITHER a transit or a plain walk-through is on
        // this door — mid-PEEK the avatar physically stands in the gangway,
        // and an unpair must not pop the tube out around them (review L1;
        // mirrors the activeDoorId exemption in the opacity branch below).
        if (
          vestibule &&
          this.transitVestibuleDoorId !== door.id &&
          activeDoorId !== door.id
        ) {
          this.disposeVestibule(door.id);
        }
        continue;
      }

      // #62 P3 rebuild-on-diff: a chain edit changes the record's segments;
      // rebuild this door's connector to match — but never mid-transit or
      // mid-walk-through (same deferral rule as unpair; the next frame after
      // the door sequence ends picks the rebuild up).
      const wantKey = JSON.stringify(state?.segments ?? null);
      if (
        vestibule &&
        vestibule.userData.segmentsKey !== wantKey &&
        this.transitVestibuleDoorId !== door.id &&
        activeDoorId !== door.id
      ) {
        this.disposeVestibule(door.id);
        vestibule = undefined;
      }

      if (!vestibule) {
        vestibule = this.buildDoorConnector(door.id);
        setVestibuleOpacity(vestibule, 0); // fades up to the resting level
        this.platformGroup.add(vestibule);
        this.pairedVestibules.set(door.id, vestibule);
      }

      // 🛰️ Exterior view: chains STAY visible at level 3 (they are the station's
      // connective tissue from outside); levels 4+ (schematics) still hide them.
      vestibule.visible = zoomLevel < 4 && !this.isMorphing;
      if (!vestibule.visible) continue;

      let target: number;
      if (ghost) {
        target = 0.35; // #62 P4: armed-but-unpaired chain — fixed ghost preview
      } else if (
        this.transitVestibuleDoorId === door.id ||
        activeDoorId === door.id
      ) {
        target = 1.0; // transit / walk-through in progress — fully material
      } else {
        const dist = Math.hypot(
          playerPos.x - door.front.x,
          playerPos.z - door.front.z,
        );
        const t = THREE.MathUtils.clamp(
          1 - dist / World.VESTIBULE_FADE_RANGE,
          0,
          1,
        );
        target =
          World.VESTIBULE_BASE_OPACITY + t * (1 - World.VESTIBULE_BASE_OPACITY);
      }

      const current = (vestibule.userData.opacity as number) ?? 0;
      if (current === target) continue;
      let next = current + (target - current) * Math.min(1, 6 * deltaTime);
      if (Math.abs(next - target) < 0.005) next = target;
      setVestibuleOpacity(vestibule, next);
    }
  }

  /**
   * Arrival-door convention (T1): default is the OPPOSITE cardinal of the
   * departure door (east↔west, north↔south) — walk out one side, walk in the
   * other. The opposite must be `enabled`; the only disabled door is north
   * (fireplace), i.e. a SOUTH departure, and for that case the convention
   * falls back to EAST (the canonical large door). East/west departures can
   * never hit the fallback.
   */
  public resolveArrivalDoor(
    departureDoorId: DoorId,
    farDoor?: DoorId,
    fromRoomId?: string,
  ): DoorTarget {
    // 🔗 HIGHEST TRUTH (owner's octagon findings): the ARRIVAL room's own
    // records — the door whose pairing points BACK at the room we came from.
    // This survives every other keypad/vestibule change on either side: a
    // center hub with four spokes routes each arrival to ITS door, no matter
    // which cardinal you departed from or what farDoor a stale record names.
    // (Callable only after the arrival doc is bound — both call sites are.)
    if (fromRoomId) {
      const backs: DoorTarget[] = [];
      for (const [doorId, rec] of readAllDoors()) {
        if (!rec.paired || !rec.connectedRoomAddress) continue;
        if (roomIdFromSeed(rec.connectedRoomAddress) !== fromRoomId) continue;
        const d = findDoor(doorId);
        if (d && d.enabled) backs.push(d);
      }
      if (backs.length === 1) return backs[0];
      if (backs.length > 1) {
        // Same room docked twice — let the record's farDoor break the tie.
        const named = farDoor ? backs.find((b) => b.id === farDoor) : undefined;
        return named ?? backs[0];
      }
    }
    // #62 P2: an assembled connection knows exactly which far door it lands on
    // (the record's farDoor) — prefer it when enabled. The angled octagon links
    // routinely land on NON-opposite doors (e.g. depart east, arrive north).
    if (farDoor) {
      const preferred = findDoor(farDoor);
      if (preferred && preferred.enabled) return preferred;
    }
    const opposite: Record<DoorId, DoorId> = {
      north: "south",
      south: "north",
      east: "west",
      west: "east",
    };
    const candidate = findDoor(opposite[departureDoorId]);
    if (candidate && candidate.enabled) return candidate;
    // 🚪↔🛰️ #28 S3: don't assume a SPECIFIC cardinal exists once doors go free
    // (slice 4+). Keep today's canonical EAST fallback for the fireplace-blocked
    // south departure, but degrade to any enabled door / any door at all instead
    // of throwing when east is absent. DOORS is always non-empty (≥1 door).
    return findDoor("east") ?? DOORS.find((d) => d.enabled) ?? DOORS[0]!;
  }

  /**
   * Success half of the swap, called by main.ts while the transit fade is
   * fully opaque and the target room's session is live: end the transit
   * (vestibule back to 'idle' — it persists while its door stays paired,
   * #51) and script the walk-in through the arrival door.
   */
  public completeAdapterArrival(
    departureDoorId: DoorId,
    farDoor?: DoorId,
    fromRoomId?: string,
  ): void {
    this.endTransitVestibule();
    // 🚶 FP auto-doors: the player materializes AT the arrival door, inside
    // its aperture — grace period + disarm so the return leg needs a real,
    // deliberate re-entry (step clear, then walk back in).
    this.fpArrivalCooldownUntil = performance.now() + 1500;
    this.fpTransitArmed = false;
    this.fpAutoOpened.clear(); // departure-room door refs died with the swap
    // 🔗 The arrival room's own back-pointing record picks the door (see
    // resolveArrivalDoor); the record's farDoor and the opposite-cardinal
    // guess are fallbacks only.
    const arrival = this.resolveArrivalDoor(
      departureDoorId,
      farDoor,
      fromRoomId,
    );
    // 🚪↦ ONE-WAY turnstile (owner request): an OUT-only door refuses guest
    // arrivals — the traveler walks in, gets the hint, and is walked right
    // back out (the return departure is exactly what OUT permits). The
    // room doc is already synced here (#60 gate), so the policy read is the
    // arrival room's truth. One-shot guard: opposing one-way doors bounce a
    // traveler AT MOST once — never a ping-pong.
    const pol = readDoorPolicy(arrival.id);
    const bounce =
      pol.passage === "public" &&
      pol.oneWay === "out" &&
      !canEditRoom().ok &&
      !this.oneWayBounceGuard;
    this.oneWayBounceGuard = false;
    this.player.enterFromDoor(
      arrival,
      this._makeArrivalHooks(arrival, false, bounce ? arrival.id : undefined),
    );
  }

  /** 🚪↦ True while the CURRENT transit is a turnstile bounce — the arrival
   *  at the far end must not bounce again (opposing one-way misconfig). */
  private oneWayBounceGuard = false;

  /**
   * Arrival half of the ACCESS-app pass transport (#52, dev phase): no door
   * choreography at all — force-release any live device focus / edit session
   * (a hard scene change, same rule as startMorph and beginTransit), end any
   * in-flight transit on the vestibule (a pass can be used mid door-walk; the
   * interrupted leg must not leave 'cycling' lights or the forced-solid latch
   * behind — post-#51 the vestibule itself belongs to the door PAIRING and
   * survives the beam), and materialize the avatar at the room's default
   * spawn in MANUAL control. The transit curtain covers all of it.
   * FUTURE: retires with the dev phase once passes become map pins + access
   * permissions (see accessBeamTransport in main.ts).
   * NOTE: anything focused here that binds the room doc directly must follow
   * the per-join rebind seam (players/chat/games do) — focus survives to
   * arrival, and on a FAILED beam it survives a full leave+rejoin.
   */
  public completeAccessBeamIn(): void {
    deviceFocus.forceRelease();
    roomEdit.forceExit();
    this.endTransitVestibule();
    // 🧬 Owner request: pass arrivals decant from the room's vat when one
    // exists — performRoomSwap awaits the room-state gate before arrive(),
    // so the host's real furniture layout is already synced here. Vat-less
    // rooms keep the legacy mid-room beam.
    if (!this.respawnAtVat()) {
      this.player.beamTo(0, 1.5); // the Player constructor's spawn point
    }
  }

  /**
   * Failure half of the swap: the avatar still stands at the vestibule hold
   * point outside the departure door (the world is never rebuilt on transit).
   * Light the vestibule 'fault', walk back in through the departure door, and
   * end the transit (lights back to 'idle') once the door closes behind the
   * player — the vestibule persists, the door is still paired (#51).
   */
  public failAdapterTransit(departureDoorId: DoorId): void {
    const vestibule = this.pairedVestibules.get(departureDoorId);
    if (vestibule) setVestibuleLightState(vestibule, "fault");
    const door = findDoor(departureDoorId);
    if (!door) {
      this.endTransitVestibule();
      return;
    }
    this.player.enterFromDoor(
      door,
      this._makeArrivalHooks(door, /* endTransitOnClose */ true),
      /* spawnAtThrough */ false, // walk back from where the hold left us
    );
  }

  /**
   * Door hooks for the scripted arrival/return walk-in. Locks are ignored on
   * purpose: the walk-in is the only way back INTO a room — denying it would
   * strand the avatar outside the walls.
   */
  private _makeArrivalHooks(
    door: DoorTarget,
    endTransitOnClose = false,
    bounceOutDoorId?: string,
  ): DoorSequenceHooks {
    const ds = this.dockingSystem;
    return {
      requestOpen: (onOpened) => {
        if (!ds) {
          onOpened();
          return true;
        }
        ds.openDoor(door.id, onOpened);
        return true;
      },
      requestClose: () => {
        ds?.closeDoor(door.id);
        if (endTransitOnClose) this.endTransitVestibule();
        // 🚪↦ Turnstile: the guest is fully inside and the door just shut —
        // now shove them back out through it (a normal walkthrough; OUT-only
        // permits the departure). Deferred a beat so the arrival sequence
        // finishes cleanly before the reverse one starts.
        if (bounceOutDoorId) {
          showHint(
            "⛔ ONE-WAY door — guests may only travel OUT through it. Sending you back…",
            4000,
          );
          this.oneWayBounceGuard = true;
          setTimeout(() => this.requestDoorWalkthrough(bounceOutDoorId), 900);
        }
      },
      onThrough: () => {
        /* arrival leg never re-crosses outward */
      },
    };
  }

  /**
   * 🎰 #76: retarget a table's device focus to a free STANDING slot so the
   * avatar walks up to an OPEN position (auto-bumping past taken ones) facing
   * the table, then the game/betting UI opens — instead of everyone stacking on
   * the single fixed device front. The reserved wheel-head is never auto-picked
   * (it's the owner's croupier robot's spot); falls back to the device's own
   * front when every open slot is occupied. Occupancy is inferred from remote
   * avatar positions (Phase 1 — a synced claim map lands in a later slice).
   */
  private standTarget(device: DeviceTarget): DeviceTarget {
    const stand = this.pickFreeStand(device.id);
    return stand
      ? { ...device, front: stand.front, faceAngle: stand.faceAngle }
      : device;
  }

  /** Nearest open, REACHABLE (non-wheel-head) stand slot for the item, or null.
   *  "Taken" = a remote avatar within 0.7 m of the slot front. A slot must also
   *  be A*-reachable from the player — otherwise picking it would strand the
   *  avatar short of the table (worse than the legacy single front), so an
   *  unreachable slot is skipped and the caller falls back to the device front. */
  private pickFreeStand(itemId: string): StandSlot | null {
    const slots = standsForItem(itemId).filter((s) => s.role !== "wheelHead");
    if (slots.length === 0) return null;
    const others = this.getRemoteAvatarSnapshots();
    const me = this.player.getPosition();
    let mr = worldToRow(me.z);
    let mc = worldToCol(me.x);
    // The player can be standing ON a non-walkable cell (the clone-vat spawn
    // cell is one) — findPath from a non-walkable start returns spuriously empty,
    // which would drop EVERY slot to the fallback front. Snap the start to the
    // nearest walkable cell first so reachability is judged from solid ground.
    if (!walkable[mr]?.[mc]) {
      for (let rad = 1, done = false; rad <= 3 && !done; rad++) {
        for (let dr = -rad; dr <= rad && !done; dr++) {
          for (let dc = -rad; dc <= rad && !done; dc++) {
            if (walkable[mr + dr]?.[mc + dc]) {
              mr += dr;
              mc += dc;
              done = true;
            }
          }
        }
      }
    }
    const reachable = (s: StandSlot) =>
      Math.hypot(s.front.x - me.x, s.front.z - me.z) < 0.6 ||
      findPath(mr, mc, worldToRow(s.front.z), worldToCol(s.front.x)).length > 0;
    const free = slots.filter(
      (s) =>
        !others.some((a) => Math.hypot(a.x - s.front.x, a.z - s.front.z) < 0.7) &&
        reachable(s),
    );
    if (free.length === 0) return null;
    free.sort(
      (a, b) =>
        Math.hypot(a.front.x - me.x, a.front.z - me.z) -
        Math.hypot(b.front.x - me.x, b.front.z - me.z),
    );
    return free[0];
  }

  /**
   * 🎰🤖 #77 Phase B — the owner-robot croupier. Runs every frame:
   *  • ALL clients: post the robot at the first roulette table's wheel-head slot
   *    (or release it), and narrate the synced betting calls over that spot.
   *  • The ELECTED OPERATOR only (canRunCroupier — the room's deed holder): drive
   *    the betting timer for each table and refresh the liveness heartbeat.
   * The robot's walk/pose is local ambience; the game writes are single-writer.
   */
  /**
   * 🤖 #77C: bring the live robot SET in line with the room. ONE robot per
   * placed charging-dock (spawned at + returning to ITS dock); if the room has
   * NO dock but its theme still wants an ambient waiter, keep a single dockless
   * patroller (the pre-#77C behaviour). A patrol-route change (a transit) or a
   * roomless route rebuilds all robots; otherwise it just spawns/disposes the
   * delta, so it is cheap to call on every furniture change (add/remove a dock).
   */
  /** 🤖 Re-run the robot reconcile against the CURRENT furniture — the local
   *  add path (dev-menu spawn) needs this because the doc-echo furniture
   *  reconcile no-ops on a piece that's already been added locally, so a placed
   *  charging-dock would otherwise not spawn its robot. Idempotent + cheap. */
  public refreshRobots(): void {
    this.reconcileRobots(this.robotsPatrol);
  }

  private reconcileRobots(waiterPatrol: Array<[number, number]> | null): void {
    if (this.robotsPatrol !== waiterPatrol) {
      for (const bot of this.robots.values()) bot.dispose();
      this.robots.clear();
      this.robotsPatrol = waiterPatrol;
    }
    if (!waiterPatrol) {
      for (const bot of this.robots.values()) bot.dispose();
      this.robots.clear();
      return;
    }
    const docks = FURNITURE.filter((i) => i.kind === "charging-dock");
    // 🤖 Robots come ONLY from placed charging-docks (owner request) — one per
    // dock, and NONE when the room has no dock. (Previously a dockless room
    // showed a single ambient theme robot; that fallback is removed.)
    const wanted = docks.map((d) => d.id);
    // Dispose robots whose dock is gone.
    for (const [key, bot] of [...this.robots]) {
      if (!wanted.includes(key)) {
        bot.dispose();
        this.robots.delete(key);
      }
    }
    // Spawn missing robots (a dock robot starts AT its dock).
    for (const key of wanted) {
      if (this.robots.has(key)) continue;
      const dock = docks.find((d) => d.id === key);
      this.robots.set(
        key,
        new PoolWaiter(
          this.scene,
          waiterPatrol,
          dock ? { x: dock.pos.x, z: dock.pos.z } : undefined,
        ),
      );
    }
    // (Re)point each dock robot at ITS dock (a moved/rotated dock is reflected);
    // the ambient robot has no dock and simply patrols.
    for (const [key, bot] of this.robots) {
      const dock = docks.find((d) => d.id === key);
      bot.setDock(
        dock
          ? {
              x: dock.pos.x,
              z: dock.pos.z,
              faceAngle: Math.atan2(-dock.pos.x, -dock.pos.z),
            }
          : null,
      );
    }
    this.applyRobotRoutines();
  }

  /** 🤖 #77C s3: push each dock's owner-programmed routine to its robot (an
   *  unconfigured dock defaults to 'serve'). Cheap; also run on every robotDoc
   *  change so a console edit re-drives behaviour without a reconcile. */
  private applyRobotRoutines(): void {
    for (const [key, bot] of this.robots) {
      const cfg = readRobotConfig(key);
      bot.setRoutine(cfg?.routine ?? "serve");
      bot.setScript(cfg?.script ?? []);
      bot.setParked(cfg?.parked ?? false); // 🤖 STOP/START park override
      // 🤖 #77C s4: a custom-script 'say' step pops a bubble over the bot (one
      // per robot, replaced each line) — local, like the croupier's narration.
      bot.setSayHandler((text, x, z) =>
        spawnFixedBubble(`robotsay:${key}`, text, x, z),
      );
    }
  }

  private updateCroupier(): void {
    const tables = FURNITURE.filter((i) => i.kind === "roulette-table");

    // Auto-drive (the elected operator only): heartbeat + betting timer. Runs
    // FIRST so the operator's own fresh beat marks the table live this frame.
    // Throttle the heartbeat off wall-clock (not a dt accumulator — a single NaN
    // dt would wedge an accumulator forever while tickAutoCroupier kept running).
    if (tables.length && canRunCroupier()) {
      const now = Date.now();
      const beatNow = now - this.croupierLastBeatAt >= HEARTBEAT_MS;
      if (beatNow) this.croupierLastBeatAt = now;
      for (const t of tables) {
        if (beatNow) beatCroupier(t.id);
        tickAutoCroupier(t.id);
      }
    }

    // Robot post (all clients): assign the NEAREST robot to the live table's
    // wheel-head and release every other robot to serve/dock. Only when a
    // croupier is actually LIVE (a fresh heartbeat) — manual venture/legacy
    // rooms keep the robots serving instead of standing mute at the wheel.
    let post: { x: number; z: number; faceAngle: number } | null = null;
    if (tables.length && isCroupierLive(tables[0].id)) {
      const head = standsForItem(tables[0].id).find((s) => s.role === "wheelHead");
      if (head) {
        post = { x: head.front.x, z: head.front.z, faceAngle: head.faceAngle };
      }
    }
    // 🤖 #77C s3: routine-aware election. A dock robot programmed 'croupier' is
    // preferred; if none is, a non-'idle' (serve) robot fills in so a default
    // casino still gets a dealer; an 'idle' robot never croupiers.
    const routineOf = (key: string): RobotRoutine =>
      readRobotConfig(key)?.routine ?? "serve";
    const hasDedicated = [...this.robots.keys()].some(
      (k) => routineOf(k) === "croupier",
    );
    const eligible = (k: string): boolean =>
      this.robots.has(k) &&
      routineOf(k) !== "idle" &&
      routineOf(k) !== "custom" &&
      (!hasDedicated || routineOf(k) === "croupier");
    if (!post) {
      this.croupierRobotKey = null;
    } else if (!this.croupierRobotKey || !eligible(this.croupierRobotKey)) {
      // Pick the nearest eligible robot ONCE, then keep it (sticky) so the others
      // head straight to their docks instead of drifting toward the wheel.
      let bestKey: string | null = null;
      let best = Infinity;
      for (const [key, bot] of this.robots) {
        if (!eligible(key)) continue;
        const bp = bot.getPosition();
        const d = Math.hypot(bp.x - post.x, bp.z - post.z);
        if (d < best) {
          best = d;
          bestKey = key;
        }
      }
      this.croupierRobotKey = bestKey;
    }
    for (const [key, bot] of this.robots) {
      bot.setCroupierPost(key === this.croupierRobotKey ? post : null);
    }

    // Narration (all clients): edge-detect each table's synced phase beat and
    // pop one bubble over the wheel-head — only while a robot croupier is live.
    for (const t of tables) {
      if (!isCroupierLive(t.id)) {
        this.croupierNarrated.delete(t.id);
        continue;
      }
      const s = readTableState(t.id);
      if (!s) continue;
      const beat = croupierBeatLine(s);
      if (!beat || this.croupierNarrated.get(t.id) === beat.key) continue;
      this.croupierNarrated.set(t.id, beat.key);
      const head = standsForItem(t.id).find((x) => x.role === "wheelHead");
      if (head) {
        spawnFixedBubble(`croupier:${t.id}`, beat.text, head.front.x, head.front.z);
      }
    }
  }

  /**
   * Route a device click into the walk-to + first-person focus sequence
   * (#33 D0/M1 — mirrors requestDoorWalkthrough): find the DeviceTarget,
   * build the kind-appropriate focused UI, and hand both to the
   * DeviceFocusController, which wires its hooks into navigateToDevice.
   */
  public requestDeviceFocus(deviceId: string): void {
    const device = findDevice(deviceId);
    if (!device || !this.isPlayerActive()) return;

    if (device.kind === "roomTerminal") {
      const screen = this.wallScreens.get(deviceId) ?? null;
      const ui = createRoomTerminalUI({
        dockingSystem: this.dockingSystem,
        getPlayerPos: () => this.player.getPosition(),
        // Dim the in-world screen to "TERMINAL IN USE" while focused (D0.4).
        onEngagedChange: (engaged) => screen?.setEngaged(engaged),
        // EDIT ROOM entry (#33 M2 amendment of #25 E2): the button releases
        // the device focus FIRST, then enters edit mode once the release
        // completes (release-with-continuation, not nesting).
        editRoom: {
          permission: () => canEditRoom(),
          request: () => deviceFocus.releaseThen(() => roomEdit.enter(this)),
          // 🛰️ Same machinery, hull presentation — camera pulls back and the
          // walls drop so the OUTSIDE is visible and clickable.
          requestHull: () =>
            deviceFocus.releaseThen(() => roomEdit.enter(this, "hull")),
        },
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === "mapTable") {
      // M4: the solar map, diegetic — mounted inside the focus overlay.
      const ui = createMapTableUI({
        requestRelease: () => deviceFocus.release(),
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === "storageTrunk") {
      const ui = createStorageTrunkUI({
        itemId: deviceId,
        roomId: World.activeRoomId(),
        applyOutfit: (outfitId) => this.applyLocalOutfit(outfitId),
      });
      // Wire the lid choreography (plan §TR2: onArrived → openLid → ease →
      // UI; release: unmount → closeLid ∥ ease). Derived DeviceTargets are
      // plain registry data, so the per-item lid handle is bound here via a
      // shallow augmented copy — the shared DEVICES entry stays untouched.
      const lid = this.trunkLids.get(deviceId);
      const target: DeviceTarget = lid
        ? {
            ...device,
            prepare: (onReady) => lid.openLid(onReady),
            onRelease: () => lid.closeLid(),
          }
        : device;
      deviceFocus.beginFocus(this.player, target, ui);
      return;
    }

    if (device.kind === "gameTable") {
      // #45 v1: flippable surface + doc-synced checkers. The flip is a UI
      // affordance (button), not focus choreography — no prepare hook; the
      // top handle simply rides along so FLIP can drive the tween.
      const ui = createGameTableUI({
        itemId: deviceId,
        top: this.gameTableTops.get(deviceId) ?? null,
      });
      // 🎰 #76: walk to an open STANDING position at the table, then the UI opens.
      deviceFocus.beginFocus(this.player, this.standTarget(device), ui);
      return;
    }

    if (device.kind === "helm") {
      // 🚀 #30 SH1: ship-status readout (flight controls come with the
      // flight slices — the panel says so).
      deviceFocus.beginFocus(this.player, device, createHelmUI());
      return;
    }

    if (device.kind === "cloneVat") {
      // 🧬 The spawn-point picker: local preference per room (spawnPoint.ts).
      // The decant choreography itself stays with respawnAtVat — this panel
      // only decides WHICH tank it uses for me.
      const roomId = World.activeRoomId();
      const isMySpawn = () => preferredSpawnVat(roomId) === deviceId;
      const ui = createCloneVatUI({
        isMySpawn,
        isEffectiveSpawn: () => this.findSpawnVat()?.item.id === deviceId,
        setMySpawn: (on) => setPreferredSpawnVat(roomId, on ? deviceId : null),
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === "cashier" || device.kind === "roulette") {
      // 🎰 #69 G1/G2: the HOUSE side (cashier book, croupier spin) rides the
      // same owner-equivalent seam as room editing — canEditRoom funnels
      // main.ts's isLocalPlayerRoomOwner, so a venture-owned room makes every
      // shareholder the house (the #68 V1 rule, applied to the casino).
      const isHouse = () => canEditRoom().ok;
      const ui =
        device.kind === "cashier"
          ? createCashierUI({ isHouse })
          : createRouletteUI({ itemId: deviceId, isHouse });
      // 🎰 #76: the roulette table gathers players at its open standing slots
      // (the cashier is not a table — it keeps its single front).
      const target =
        device.kind === "roulette" ? this.standTarget(device) : device;
      deviceFocus.beginFocus(this.player, target, ui);
      return;
    }

    if (device.kind === "robotDock") {
      // 🤖 #77C s3: program the dock's robot. Owner-gated (only the room owner
      // may set the routine); anyone can open it to see the current program.
      const ui = createRobotDockUI({
        itemId: deviceId,
        canEdit: () => canEditRoom().ok,
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    // The desk computer UI arrives with M3.
    showHint("This device is not operational yet.");
  }

  /**
   * Stable room id for per-room local state (TR2 trunk stowage keys).
   * main.ts publishes the bootstrap roomId on join; before networking is up
   * (or when it fails) this falls back to the per-install default (getDefaultRoomId).
   */
  private static activeRoomId(): string {
    const id = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
    return typeof id === "string" && id.length > 0 ? id : getDefaultRoomId();
  }

  /**
   * TR3 equip path for the trunk UI (TR2 of #35): recolor the local rig +
   * attach the outfit's accessory and persist to 'ssf-outfit' — the exact
   * path main.ts's applyOutfitById/__setOutfit runs at boot. Delegates to
   * main.ts's window handle when present so extensions of the boot path
   * (e.g. S2's players-map outfitId mirror) apply here for free; falls back
   * to direct rig application otherwise.
   */
  private applyLocalOutfit(outfitId: string): boolean {
    const viaMain = (
      window as unknown as { __setOutfit?: (id: string) => boolean }
    ).__setOutfit;
    if (typeof viaMain === "function") return viaMain(outfitId);
    const outfit = getOutfitById(outfitId);
    if (!outfit) return false;
    // Player keeps its rig private; reach through for this cosmetic path
    // (same escape hatch main.ts uses — frozen player/character public API).
    (
      this.player as unknown as { character: { setOutfit(o: OutfitDef): void } }
    ).character.setOutfit(outfit);
    saveOutfitId(outfitId);
    return true;
  }

  /**
   * Room-edit mode visual switch (E2 of #25): shows/hides the 1 m platform
   * grid while the RoomEditController is active.
   */
  public setEditMode(on: boolean): void {
    if (this.platformGrid) this.platformGrid.visible = on;
  }

  // ── 🧬 Clone-vat spawn choreography (owner request) ─────────────────────────

  /** My preferred vat when saved (spawnPoint.ts — the vat panel's "wake up
   *  here"), else the first clone-vat item with a live handle, else null
   *  (vat-less room). */
  private findSpawnVat(): {
    item: FurnitureItem;
    handle: CloneVatHandle;
  } | null {
    const prefId = preferredSpawnVat(World.activeRoomId());
    if (prefId) {
      const item = FURNITURE.find(
        (i) => i.kind === "clone-vat" && i.id === prefId,
      );
      const handle = item ? this.cloneVats.get(item.id) : undefined;
      if (item && handle) return { item, handle };
      // Saved vat gone (removed/never synced) — fall through to first-found.
    }
    for (const item of FURNITURE) {
      if (item.kind !== "clone-vat") continue;
      const handle = this.cloneVats.get(item.id);
      if (handle) return { item, handle };
    }
    return null;
  }

  /**
   * Run the full spawn ceremony at the room's clone vat: the avatar is held
   * inside the tube, the nutrient bath drains, the glass door spins open,
   * and the clone walks out to the cell in front of the door — then the vat
   * seals and slowly refills behind them. Used at boot (deferred via
   * pendingVatSpawn), by the DEV RESPAWN button, and by any future death
   * flow. Returns false when the room has no vat (legacy spawn applies).
   */
  public respawnAtVat(): boolean {
    const found = this.findSpawnVat();
    if (!found || this.isMorphing) return false;
    const { item, handle } = found;
    // Exit = one tile out through the door face (local +z, rotated with the
    // item) — for the default NW-pocket vat that is the open (-3.5, -3.5).
    const exitOff = rotXZ(0, 1.0, item.rot);
    const exit = { x: item.pos.x + exitOff.x, z: item.pos.z + exitOff.z };
    this.player.beginVatSpawn(
      { x: item.pos.x, z: item.pos.z },
      item.rot * (Math.PI / 2),
    );
    handle.beginSpawnCycle(() => {
      this.player.walkOutOfVat(exit, () => handle.closeAndRefill());
    });
    return true;
  }

  isPlayerActive(): boolean {
    // Device-FOCUSED counts as active: the avatar mesh is hidden then, but
    // the player still stands in the room (ticks keep flowing to peers, and
    // deferred seat/door/dest requests must still be routable).
    // FIRST PERSON (#49) counts as active for the same reason: zoom level 1
    // hides the local mesh (so we don't render inside our own head), but the
    // player still stands in the room — WASD must keep walking (the
    // camera-relative branch in input.ts), collision/BOUND still apply in
    // player.update, and movement ticks must keep flowing to peers. Without
    // this the mesh-visibility gate silently disabled all first-person WASD.
    const zoomView = (window as any).multiScaleZoom;
    const firstPerson =
      !!zoomView &&
      typeof zoomView.getLevel === "function" &&
      zoomView.getLevel() === 1;
    return (
      (this.player.mesh.visible || deviceFocus.isActive() || firstPerson) &&
      !this.isMorphing
    );
  }

  private initializeDockingPorts() {
    this.dockingSystem = new DoorDockingPortSystem(this.platformGroup);
    this.dockingSystem.buildPorts();

    // Hook P2P sync routing events (Task: Room pairings over Yjs awareness)
    this.dockingSystem.onConnectionRequest((doorId, address) => {
      console.log(
        `[Docking Pipeline] Dispatching connection handshake: ${doorId} -> ${address}`,
      );
    });

    // #64: publish a completed local pairing to the shared `doors` doc so every
    // other user in the room reconciles it (sees the docked module + can enter).
    // completePairing is the sole setter of pairedSuccessfully, so this is the
    // single publish point; the reconcile path (applyRemotePairing) deliberately
    // does NOT fire this callback, so applying a remote pairing never re-publishes.
    this.dockingSystem.onPairingStatusChanged((doorId, status) => {
      if (status === "ACCEPTED") {
        const st = this.dockingSystem?.getDockingState(
          doorId as "north" | "south" | "east" | "west",
        );
        if (st?.connectedRoomAddress) {
          // #62 P2: an assembled chain publishes its geometry with the pairing
          // (absent on plain pairings — the legacy record shape, v0.30.x-safe).
          writeDoorPairing(doorId, st.connectedRoomAddress, {
            segments: st.segments,
            farDoor: st.farDoor,
            farYawDeg: st.farYawDeg,
            transient: st.transient, // #67 D2: guest berths carry the flag
          });
        }
      } else if (status === "REJECTED") {
        deleteDoorPairing(doorId);
      }
    });
  }
}
