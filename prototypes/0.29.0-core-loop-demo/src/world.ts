/**
 * World/Room Management
 * Handles room creation and game world state with planet-to-platform morphing.
 * Includes a click-navigation plane for point-and-click pathfinding.
 */

import * as THREE from 'three';
import { Player } from './player';
import { InputManager } from './input';
import { findSeatAt, rebuildSeats } from './seats';
import { getDefaultRoomId } from './identity';
import { FURNITURE, FURNITURE_DEFS, buildItemGroup, BUNK_TOP_Y, rotXZ } from './furniture';
import type { FurnitureItem } from './furniture';
import { northDoorUnlocked } from './stationParts';
import { rebuildObstacles } from './obstacles';
import { rebakeWalkableGrid, walkable, worldToRow, worldToCol, colToWorld, rowToWorld } from './pathfinding';
import { subscribeFurniture, readAllFurniture } from './furnitureDoc';
import { subscribeDoors, readAllDoors, writeDoorPairing, deleteDoorPairing, type DoorRecord } from './doorsDoc';
import { readDoorDeltas } from './floorPlanDoc';
import { applyDoorSlideDeltas } from './doors';
import { setDoorSlideDeltas } from './adapter';
import { roomIdFromSeed } from './stationAtlas';
import type { FurnitureRecord } from './furnitureDoc';
import { findDoor, DOORS } from './doors';
import type { DoorId, DoorTarget, DoorSequenceHooks } from './doors';
import { buildVestibule, buildConnectorChain, setVestibuleLightState, setVestibuleOpacity } from './adapter';
import { findDevice, rebuildDevices, createRoomTerminalUI, createMapTableUI, createStorageTrunkUI, createGameTableUI, createHelmUI, createCashierUI, createRouletteUI, readLiveRoomStatus } from './devices';
import type { WallScreenHandle, TrunkLidHandle, GameTableTopHandle, CloneVatHandle, DeviceTarget } from './devices';
import { subscribeGames, readGame } from './games/gamesDoc';
import { deviceFocus } from './deviceFocus';
import { roomEdit, canEditRoom } from './editMode';
import { showHint } from './hud';
import { DoorDockingPortSystem } from './docking';
import { VoxelCharacter, OUTLINE_MAT, snapTo8Ways } from './voxelCharacter';
import { getOutfitById, saveOutfitId } from './outfits';
import type { OutfitDef } from './outfits';

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
}

export class World {
  private scene: THREE.Scene;
  private player: Player;
  private platformGroup: THREE.Group;
  private stationPlanet: THREE.Mesh | null = null;
  private platformFloor: THREE.Mesh | null = null;
  private platformGrid: THREE.GridHelper | null = null;
  private platformElements: THREE.Object3D[] = [];
  private sideWalls: THREE.Mesh[] = [];
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
  // Active interactive docking doors subsystem
  public dockingSystem: DoorDockingPortSystem | null = null;
  // ── Adapter transit (T1 of issue #30) ───────────────────────────────────────
  /**
   * Room-swap driver, wired by main.ts (callback pattern — world must not
   * import main). Receives the paired door's seed string and the departure
   * door id when the avatar reaches the vestibule hold point (mid-HOLD).
   * Transit is only offered on paired doors when this is non-null.
   */
  public onAdapterTransit: ((seed: string, departureDoorId: DoorId) => void) | null = null;
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
  /** Resting opacity of a paired-door vestibule when the player is far. */
  private static readonly VESTIBULE_BASE_OPACITY = 0.25;
  /** Proximity fade range (m from the door's front stand-point). */
  private static readonly VESTIBULE_FADE_RANGE = 4.0;
  // Lobby furniture (fades in to full opacity)
  private furnitureMeshes: THREE.Mesh[] = [];
  private furnitureLights: Array<{ light: THREE.PointLight; targetIntensity: number }> = [];
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
  /** 🧬 Grace before the queued spawn may fire: the #65 exterior boot flips
   *  the zoom to level 3 a beat AFTER morph-complete, and the ceremony must
   *  not race it and play unseen (zoom reads 2 for the first few frames). */
  private pendingVatSpawnGrace = 0;
  /** Flippable game-table tops, keyed by item id (#45 — driven every frame). */
  private gameTableTops: Map<string, GameTableTopHandle> = new Map();
  // Atmosphere effects (animated each frame)
  private particleGeo: THREE.BufferGeometry | null = null;
  private particlePositions: Float32Array | null = null;
  private particleMat: THREE.PointsMaterial | null = null;
  /** Invisible plane covering the walkable floor — used as the raycast target. */
  private clickPlane: THREE.Mesh | null = null;
  
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

    console.log('✅ World initialized - Station planet ready');
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
      emissiveIntensity: 0.2
    });
    
    // Load Mars texture asynchronously
    textureLoader.load(
      '/assets/mars.png',
      (texture) => {
        // Nearest-neighbour keeps the texture crisp in the pixelated renderer.
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        planetMaterial.map = texture;
        planetMaterial.needsUpdate = true;
        console.log('✅ Mars texture loaded');
      },
      undefined,
      (_error) => {
        console.warn('⚠️ Mars texture not found, using fallback color');
        planetMaterial.color.setHex(0xd84315);
      }
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
      side: THREE.BackSide
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    this.stationPlanet.add(glow);
    
    // Add ring around planet (station orbit ring)
    const ringGeometry = new THREE.RingGeometry(2.5, 2.7, 64);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x1E88E5,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide
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
      new THREE.MeshBasicMaterial({ color: 0x00ffee, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide })
    );
    this.orbitRingOuter.rotation.x = Math.PI * 0.28; // tilted orbital plane
    this.stationPlanet.add(this.orbitRingOuter);

    this.orbitRingInner = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.16, 20, 80),
      new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide })
    );
    this.orbitRingInner.rotation.x = -Math.PI * 0.18;
    this.orbitRingInner.rotation.z = Math.PI * 0.12;
    this.stationPlanet.add(this.orbitRingInner);

    console.log('✅ Station planet created (Mars-style) - hanging on galaxy spiral');
  }
  
  /**
   * Create the full platform (called during morph)
   */
  private createPlatform() {
    const platformSize = 12;

    // Floor - warm light oak herringbone wood
    const floorGeometry = new THREE.PlaneGeometry(platformSize, platformSize);

    // Build a canvas herringbone wood texture
    const makeWoodTexture = (): THREE.CanvasTexture => {
      const CW = 512, CH = 512;
      const cv = document.createElement('canvas');
      cv.width = CW; cv.height = CH;
      const ctx = cv.getContext('2d')!;

      // plank tile: 96px wide × 32px tall
      const PW = 96, PH = 32, GAP = 2;
      // base fill
      ctx.fillStyle = '#D4A86A';
      ctx.fillRect(0, 0, CW, CH);

      const drawPlank = (x: number, y: number, w: number, h: number, seed: number) => {
        // base plank colour — vary slightly per plank for realism
        const v = (seed % 5) * 8;
        const r = 196 + v, g = 154 + v * 0.6 | 0, b = 88 + v * 0.3 | 0;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x + GAP, y + GAP, w - GAP, h - GAP);
        // grain lines
        ctx.strokeStyle = `rgba(0,0,0,0.07)`;
        ctx.lineWidth = 0.8;
        for (let i = 1; i < 4; i++) {
          const gx = x + GAP + (w - GAP) * (i / 4);
          ctx.beginPath(); ctx.moveTo(gx, y + GAP); ctx.lineTo(gx + 2, y + h); ctx.stroke();
        }
        // highlight top edge
        ctx.fillStyle = 'rgba(255,255,230,0.12)';
        ctx.fillRect(x + GAP, y + GAP, w - GAP, 3);
        // shadow bottom edge
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(x + GAP, y + h - 3, w - GAP, 3);
      };

      // Herringbone: alternating horizontal and vertical planks in 2×1 tiles
      const TW = PW, TH = PH; // horizontal plank size
      let seed = 0;
      for (let row = -1; row * TH < CH + TH; row++) {
        for (let col = -1; col * TW < CW + TW; col++) {
          const tx = col * TW, ty = row * TH;
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
      tex.repeat.set(3.5, 3.5);
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
      opacity: 0
    });
    this.platformFloor = new THREE.Mesh(floorGeometry, floorMaterial);
    this.platformFloor.rotation.x = -Math.PI / 2;
    this.platformGroup.add(this.platformFloor);

    // ── Click-navigation plane ────────────────────────────────────────────────
    // Invisible horizontal plane covering the walkable floor used as the
    // raycast hit target for point-and-click navigation.
    const clickGeo = new THREE.PlaneGeometry(platformSize, platformSize);
    clickGeo.rotateX(-Math.PI / 2);
    const clickMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this.clickPlane = new THREE.Mesh(clickGeo, clickMat);
    this.clickPlane.position.y = 0.005; // just above the floor
    this.clickPlane.userData = { isTile: true };
    this.platformGroup.add(this.clickPlane);

    // Grid helper
    this.platformGrid = new THREE.GridHelper(platformSize, 12, 0x1E88E5, 0x0A1E3A);
    this.platformGrid.position.y = 0.01;
    this.platformGrid.visible = false;
    this.platformGroup.add(this.platformGrid);

    // Add corner markers and edges
    this.addCornerMarkers();
    this.addPlatformEdgeLights();
    this.addSideWalls();
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
        new THREE.MeshStandardMaterial({ color: 0x2a5a8f, roughness: 0.9, metalness: 0.05, emissive: 0x0c2038, emissiveIntensity: 0.55 }),
      );
      ambient.name = 'ambientPlanet';
      ambient.position.set(-70, -10, -28);
      this.platformGroup.add(ambient);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(16.8, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.08, side: THREE.BackSide }),
      );
      glow.position.copy(ambient.position);
      this.platformGroup.add(glow);
    }

    // (orbital rings live on the Mars sphere — created in createStationPlanet)
  }

  /**
   * Add transparent side walls on the left (X=-6) and right (X=+6) sides.
   */
  private addSideWalls() {
    const wallDepth  = 12;
    const wallHeight = 4;
    const wallThick  = 0.35;
    const wallY = wallHeight / 2;

    // ── Brick canvas texture ─────────────────────────────────────────────────
    // Each brick is ~0.9u wide × 0.38u tall in world-space.
    // Canvas resolution: 512×170 px  → 1px ≈ 0.023u
    const makeBrickTexture = (): THREE.CanvasTexture => {
      const CW = 512, CH = 171;
      const cv = document.createElement('canvas');
      cv.width = CW; cv.height = CH;
      const ctx = cv.getContext('2d')!;

      // mortar background — dark charcoal-slate
      ctx.fillStyle = '#1A2835';
      ctx.fillRect(0, 0, CW, CH);

      const BW = 84;  // brick width px
      const BH = 38;  // brick height px
      const MO = 3;   // mortar thickness px

      for (let row = 0; row * (BH + MO) < CH + BH; row++) {
        const y = row * (BH + MO);
        const offset = (row % 2 === 0) ? 0 : (BW + MO) / 2;
        for (let col = -1; col * (BW + MO) < CW + BW; col++) {
          const x = col * (BW + MO) + offset;
          // Frontier station wall: pale blue-stone accents among slate blue panels
          const isLight = (row + col) % 4 === 0;
          ctx.fillStyle = isLight ? '#B0BEC8' : (((row * 7 + col * 3) % 5 === 0) ? '#2A3848' : '#3A4E62');
          ctx.fillRect(x + MO, y + MO, BW - MO, BH - MO);
          // highlight top-left edge (brick face relief)
          if (!isLight) {
            ctx.fillStyle = 'rgba(255,255,255,0.09)';
            ctx.fillRect(x + MO, y + MO, BW - MO, 3);
            ctx.fillRect(x + MO, y + MO, 3, BH - MO);
          }
          // shadow bottom-right edge
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(x + MO, y + BH - 4, BW - MO, 3);
          ctx.fillRect(x + BW - 4, y + MO, 3, BH - MO);
        }
      }

      const tex = new THREE.CanvasTexture(cv);
      // Repeat across 12-unit depth (≈ 13 bricks wide) and 4-unit height (≈ 10 rows)
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(12 / ((BW + MO) * 0.023), 4 / ((BH + MO) * 0.023));
      // Nearest-neighbour — keeps brick edges sharp in the pixelated renderer.
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      return tex;
    };

    const brickTex = makeBrickTexture();

    const makeMat = () => new THREE.MeshStandardMaterial({
      map: brickTex,
      roughness: 0.85,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });

    const wallGeo = new THREE.BoxGeometry(wallThick, wallHeight, wallDepth);

    const leftWall = new THREE.Mesh(wallGeo, makeMat());
    leftWall.position.set(-6, wallY, 0);
    this.platformGroup.add(leftWall);
    this.sideWalls.push(leftWall);

    // Subtle top-edge coping strip for left wall only
    const edgeGeo = new THREE.BoxGeometry(wallThick + 0.06, 0.10, wallDepth + 0.06);
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0xB8C8D8,
      roughness: 0.75,
      metalness: 0.05,
      transparent: true,
      opacity: 0,
    });
    const strip = new THREE.Mesh(edgeGeo, edgeMat.clone());
    strip.position.set(-6, wallHeight + 0.05, 0);
    this.platformGroup.add(strip);
    this.platformElements.push(strip);
  }

  /**
   * Add complete capsule outer structure (Roof + solid outer walls for Level 3 isometric view)
   */
  private addCapsuleOuterStructure() {
    // 1. Sleek metallic outer roof
    const roofGeo = new THREE.BoxGeometry(12.35, 0.28, 12.35);
    const outerMetallicMat = new THREE.MeshStandardMaterial({
      color: 0x2A3E52, // carbon structural blueprint slate
      roughness: 0.4,
      metalness: 0.8,
      transparent: true,
      opacity: 0, // starts completely hidden for internal levels <= 2
    });
    this.capsuleRoof = new THREE.Mesh(roofGeo, outerMetallicMat);
    this.capsuleRoof.position.set(0, 4.14, 0);
    this.platformGroup.add(this.capsuleRoof);

    // 2. Solid metallic outer front/back walls to block inner rendering during external views
    const wallGeoF = new THREE.BoxGeometry(12.35, 4.0, 0.35);
    const frontWall = new THREE.Mesh(wallGeoF, outerMetallicMat);
    frontWall.position.set(0, 2.0, 6.0);
    this.platformGroup.add(frontWall);
    this.capsuleOuterWalls.push(frontWall);

    const backWall = new THREE.Mesh(wallGeoF, outerMetallicMat);
    backWall.position.set(0, 2.0, -6.0);
    this.platformGroup.add(backWall);
    this.capsuleOuterWalls.push(backWall);
    
    // Also build a full solid left/right wall set with ports slots included
    const wallGeoLR = new THREE.BoxGeometry(0.35, 4.0, 12.35);
    const rightWall = new THREE.Mesh(wallGeoLR, outerMetallicMat);
    rightWall.position.set(6.0, 2.0, 0);
    this.platformGroup.add(rightWall);
    this.capsuleOuterWalls.push(rightWall);

    const leftWall = new THREE.Mesh(wallGeoLR, outerMetallicMat);
    leftWall.position.set(-6.0, 2.0, 0);
    this.platformGroup.add(leftWall);
    this.capsuleOuterWalls.push(leftWall);
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
          this.wallScreens.set(item.id, obj.userData.wallScreen as WallScreenHandle);
        }
        if (typeof obj.userData.holoSpin === 'number') {
          this.holoSpinners.push({ mesh: obj, speed: obj.userData.holoSpin });
        }
        if (obj.userData.trunkLid) {
          this.trunkLids.set(item.id, obj.userData.trunkLid as TrunkLidHandle);
        }
        if (obj.userData.gameTableTop) {
          this.gameTableTops.set(item.id, obj.userData.gameTableTop as GameTableTopHandle);
        }
        if (obj.userData.cloneVat) {
          this.cloneVats.set(item.id, obj.userData.cloneVat as CloneVatHandle);
        }
        if (reveal) {
          const mat = obj.material as THREE.Material & { opacity: number; userData: { baseOpacity?: number } };
          if ('opacity' in mat) mat.opacity = mat.userData.baseOpacity ?? 1;
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
    const doors: Array<'north' | 'south' | 'east' | 'west'> = ['north', 'south', 'east', 'west'];
    for (const doorId of doors) {
      const rec = records.get(doorId);
      if (rec && rec.paired && rec.connectedRoomAddress) {
        // #62 P2: geometry (sanitized by readAllDoors) rides along; the diff
        // inside applyRemotePairing catches chain edits on a same-address record.
        this.dockingSystem.applyRemotePairing(doorId, rec.connectedRoomAddress, {
          segments: rec.segments,
          farDoor: rec.farDoor,
          farYawDeg: rec.farYawDeg,
          transient: rec.transient, // #67 D2
        });
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
    this.sideWallCovered[0] = false;
    this.sideWallCovered[1] = false;
    for (const item of FURNITURE) {
      if (item.kind !== 'brick-wall' && item.kind !== 'window-wall') continue;
      if (item.pos.x < -5) this.sideWallCovered[0] = true;
      if (item.pos.x > 5) this.sideWallCovered[1] = true;
    }
    // addSideWalls order: [0] = left (x=-6). The zoom machinery consults the
    // flags too (it force-restores walls at interior levels otherwise).
    this.sideWalls.forEach((wall, i) => { wall.visible = !this.sideWallCovered[i]; });
  }

  /** Which built-in side walls are REPLACED by placed wall sections. */
  private sideWallCovered: boolean[] = [false, false];

  public updateNorthDoorForFireplace(): void {
    const north = findDoor('north');
    if (!north) return;
    // Approach zone in front of the north wall opening (opening ~1.4 wide at
    // z=-6; the zone reaches to the door's `front` stand-point at z=-4.5).
    // 🧱 #66 S1: the zone FOLLOWS the door — centred on its slid position
    // (front.x carries the slide delta), the plan §6.2 generalization seed.
    const cx = north.front.x;
    const zone = { x0: cx - 1.4, x1: cx + 1.4, z0: -6.2, z1: -4.4 };
    const blocked = FURNITURE.some((item) => {
      if (item.kind !== 'fireplace-wall') return false;
      const fp = FURNITURE_DEFS[item.kind].footprint;
      if (!fp) return false; // footprint-less def — nothing to block with
      const w = item.rot % 2 === 0 ? fp.w : fp.d;
      const d = item.rot % 2 === 0 ? fp.d : fp.w;
      const x0 = item.pos.x - w / 2, x1 = item.pos.x + w / 2;
      const z0 = item.pos.z - d / 2, z1 = item.pos.z + d / 2;
      return x0 < zone.x1 && x1 > zone.x0 && z0 < zone.z1 && z1 > zone.z0;
    });
    north.enabled = northDoorUnlocked() || !blocked;
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
        FURNITURE.push(item);
        this.registerFurnitureGroup(item, /* reveal */ true);
        changedIds.add(id);
      } else if (existing.pos.x !== rec.x || existing.pos.z !== rec.z || existing.rot !== rec.rot
        || existing.mountParent !== rec.mountParent) {
        this.evictAndDefocusForItem(id);
        existing.pos = { x: rec.x, z: rec.z };
        existing.rot = rec.rot;
        // A moved item sheds its hand-authored obstacle override (matches
        // commitCarry) — the derived footprint is now the honest obstacle.
        if (existing.footprintOverride !== undefined) delete existing.footprintOverride;
        const group = this.furnitureGroups.get(id);
        if (group) {
          group.position.set(rec.x, 0, rec.z);
          group.rotation.y = rec.rot * (Math.PI / 2);
        }
        changedIds.add(id);
      }
    }

    // Floor-plan work: run BEFORE the no-change early-return — the LOCAL
    // owner's own move self-echoes with an empty diff (see module header), and
    // their north door must still unblock. Cheap (one AABB test).
    this.updateNorthDoorForFireplace();
    this.updateSideWallCoverage(); // 🧱🪟 wall sections replace the built-in wall

    if (changedIds.size === 0) return;

    // Same order commitCarry/commitSpawn use: seats AND devices bake world-space
    // fronts/poses off the fresh walkable grid, then replan in-flight nav.
    rebuildObstacles();
    rebakeWalkableGrid();
    rebuildSeats();
    rebuildDevices();
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
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || disposed.has(mat)) continue;
        disposed.add(mat);
        const map = (mat as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        mat.dispose();
      }
    });
    this.furnitureMeshes = this.furnitureMeshes.filter((m) => !groupMeshes.has(m));
    this.furnitureLights = this.furnitureLights.filter(({ light }) => !groupLights.has(light));
    this.holoSpinners = this.holoSpinners.filter(({ mesh }) => !groupMeshes.has(mesh));
    return true;
  }

  /**
   * Add atmosphere effects: pendant lights, holographic display,
   * space-view windows, floating particles.
   */
  private addAtmosphereEffects() {
    const m = (color: number, rough = 0.72, metal = 0.06, em = 0x000000, emI = 0) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal,
        emissive: em, emissiveIntensity: emI, transparent: true, opacity: 0 });

    const place = (geo: THREE.BufferGeometry, mat: THREE.Material,
                   x: number, y: number, z: number, ry = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      this.platformGroup.add(mesh);
      this.furnitureMeshes.push(mesh);
      return mesh;
    };

    const addLight = (light: THREE.PointLight, x: number, y: number, z: number, ti: number) => {
      light.position.set(x, y, z);
      this.platformGroup.add(light);
      this.furnitureLights.push({ light, targetIntensity: ti });
    };

    // ── SPACE-VIEW WINDOWS on side walls ──────────────────────────────────────
    const makeStarTex = (top: string, bot: string): THREE.CanvasTexture => {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 192;
      const ctx = cv.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, 0, 192);
      g.addColorStop(0, top); g.addColorStop(1, bot);
      ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 192);
      for (let i = 0; i < 140; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * 256, Math.random() * 192, Math.random() * 1.3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.65})`; ctx.fill();
      }
      // Soft nebula bloom
      for (let i = 0; i < 2; i++) {
        const gr = ctx.createRadialGradient(Math.random()*256, Math.random()*192, 4, 128, 96, 70);
        gr.addColorStop(0, i === 0 ? 'rgba(80,170,255,0.20)' : 'rgba(255,150,70,0.14)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, 256, 192);
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
    winZs.forEach(wz => {
      // Left wall — cool cerulean tint
      const winL = new THREE.Mesh(winGeo.clone(),
        new THREE.MeshBasicMaterial({ map: makeStarTex('#010d22','#041530'),
          transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      winL.rotation.y = Math.PI / 2; winL.position.set(-5.81, 2.1, wz);
      this.platformGroup.add(winL); this.furnitureMeshes.push(winL);
      // Frame
      place(new THREE.BoxGeometry(0.06, 1.85, 2.42), m(0x8899AA, 0.48, 0.62), -5.84, 2.1, wz);
      addLight(new THREE.PointLight(0x3388FF, 0, 4.5), -5.5, 2.1, wz, 0.5);

      // Right wall removed — no paintings or frames on that side
    });

    // (Coloured throw cushions moved into the sofa builders — furniture.ts.)

    // ── AMBIENT WALL LIGHT STRIPS — glowing accents at ceiling edge ───────────
    // Thin emissive strips along the top of each side wall (z axis, y=3.9)
    const stripMat = (col: number) =>
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0 });
    place(new THREE.BoxGeometry(0.04, 0.06, 10.8), stripMat(0x2266CC), -5.76, 3.92, 0); // left  — blue
    addLight(new THREE.PointLight(0x1155BB, 0, 14), -5.5, 3.8,  0, 0.55);

    // ── FLOATING DUST MOTES ───────────────────────────────────────────────────
    const COUNT = 220;
    this.particlePositions = new Float32Array(COUNT * 3);
    const pCols = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.particlePositions[i*3]   = (Math.random() - 0.5) * 10.5;
      this.particlePositions[i*3+1] = Math.random() * 3.8 + 0.1;
      this.particlePositions[i*3+2] = (Math.random() - 0.5) * 10.5;
      const rc = Math.random();
      if      (rc < 0.38) { pCols[i*3]=0.92; pCols[i*3+1]=0.78; pCols[i*3+2]=0.38; } // gold
      else if (rc < 0.62) { pCols[i*3]=0.25; pCols[i*3+1]=0.62; pCols[i*3+2]=1.00; } // blue
      else if (rc < 0.80) { pCols[i*3]=0.92; pCols[i*3+1]=0.42; pCols[i*3+2]=0.35; } // rose
      else                { pCols[i*3]=1.00; pCols[i*3+1]=0.95; pCols[i*3+2]=0.85; } // warm white
    }
    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleGeo.setAttribute('color',    new THREE.BufferAttribute(pCols, 3));
    this.particleMat = new THREE.PointsMaterial({
      size: 1.8, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0, depthWrite: false
    });
    (this.particleMat as THREE.PointsMaterial & { fog: boolean }).fog = false;
    this.platformGroup.add(new THREE.Points(this.particleGeo, this.particleMat));

    console.log('✅ Atmosphere effects built');
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
    for (const doorId of [...this.pairedVestibules.keys()]) this.disposeVestibule(doorId);
    this.isMorphing = true;
    this.morphProgress = 0;
    this.createPlatform();
    console.log('🔄 Morphing station planet into platform...');
  }

  /**
   * Add glowing corner markers for sci-fi feel
   */
  private addCornerMarkers() {
    const markerGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8);
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: 0xFFAA22,
      emissive: 0xFFAA22,
      emissiveIntensity: 0.9,
      metalness: 0.8,
      roughness: 0.2,
      transparent: true,
      opacity: 0
    });

    const positions = [
      [-5.5, 0.2, -5.5],
      [5.5, 0.2, -5.5],
      [-5.5, 0.2, 5.5],
      [5.5, 0.2, 5.5]
    ];

    positions.forEach(([x, y, z]) => {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(x, y, z);
      this.platformGroup.add(marker);
      this.platformElements.push(marker);

      const cornerLight = new THREE.PointLight(0xFFAA22, 0, 5);
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
      color: 0x1E88E5,
      transparent: true,
      opacity: 0
    });

    const edgeGeometry = new THREE.BoxGeometry(12, 0.05, 0.1);

    const northEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    northEdge.position.set(0, 0.03, -6);
    this.platformGroup.add(northEdge);
    this.platformElements.push(northEdge);

    const southEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    southEdge.position.set(0, 0.03, 6);
    this.platformGroup.add(southEdge);
    this.platformElements.push(southEdge);

    const eastEdgeGeometry = new THREE.BoxGeometry(0.1, 0.05, 12);
    const westEdge = new THREE.Mesh(eastEdgeGeometry, edgeMaterial.clone());
    westEdge.position.set(-6, 0.03, 0);
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
      console.log('✅ Morph complete - Platform active');
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
        this.pendingVatSpawnGrace = 0.8; // outlast the exterior-boot flip (#65)
      }
    }

    const t = this.morphProgress;
    const eased = 1 - Math.pow(1 - t, 3);

    this.platformGroup.position.lerp(new THREE.Vector3(0, 0, 0), eased);

    // Shrink and fade planet
    if (this.stationPlanet) {
      const scale = 1 - eased;
      this.stationPlanet.scale.setScalar(scale);
      (this.stationPlanet.material as THREE.MeshStandardMaterial).opacity = scale;
      (this.stationPlanet.material as THREE.MeshStandardMaterial).transparent = true;
      if (this.morphProgress >= 1) {
        this.platformGroup.remove(this.stationPlanet);
        this.stationPlanet = null;
        this.orbitRingOuter = null;
        this.orbitRingInner = null;
      }
    }

    // Fade in platform floor
    if (this.platformFloor) {
      (this.platformFloor.material as THREE.MeshStandardMaterial).opacity = eased * 0.9;
    }

    // The platform grid is an EDIT-MODE affordance (E2 of #25) — it no
    // longer auto-shows during the morph; setEditMode() owns its visibility.
    // (It sat under the near-opaque wooden floor anyway.)

    // Fade in all platform elements
    this.platformElements.forEach(element => {
      if (element instanceof THREE.Mesh && element.material) {
        const material = element.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        if ('opacity' in material) {
          material.opacity = eased * 0.6;
        }
      } else if (element instanceof THREE.PointLight) {
        element.intensity = eased * 0.5;
      }
    });

    // Fade in side walls — semi-transparent glass feel
    this.sideWalls.forEach(wall => {
      (wall.material as THREE.MeshStandardMaterial).opacity = eased * 0.35;
    });

    // Fade in furniture to its design opacity — materials declaring a
    // userData.baseOpacity (the map table's translucent holo disc/ring, M4)
    // fade toward that instead of 1.0 (same contract as zoom.ts's avatar fade).
    this.furnitureMeshes.forEach(mesh => {
      const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
      if ('opacity' in mat) mat.opacity = eased * ((mat.userData.baseOpacity as number) ?? 1);
    });

    // Fade in lobby point lights
    this.furnitureLights.forEach(({ light, targetIntensity }) => {
      light.intensity = eased * targetIntensity;
    });

    // Fade in floating particles
    if (this.particleMat) this.particleMat.opacity = eased * 0.70;
  }

  /**
   * Update world state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    this.time += deltaTime;

    this.updateMorph(deltaTime);

    // Retrieve active zoom level to adjust interior vs exterior capsule visibility selectively (Level 3 optimization)
    const zoomView = (window as any).multiScaleZoom;
    const zoomLevel = zoomView ? (typeof zoomView.getLevel === 'function' ? zoomView.getLevel() : 2) : 2;

    // 🧬 Deferred boot spawn: run the vat reveal the first frame the player
    // actually sees the room interior (zoom ≤ 2) — queued at morph-complete.
    // The grace lets the #65 exterior boot flip the zoom to 3 first; without
    // it the ceremony fires on the same-frame default level 2 and plays
    // unseen behind the station-from-space view.
    if (this.pendingVatSpawn && !this.isMorphing) {
      this.pendingVatSpawnGrace -= deltaTime;
      if (this.pendingVatSpawnGrace <= 0 && zoomLevel <= 2) {
        this.pendingVatSpawn = false;
        this.respawnAtVat();
      }
    }

    if (zoomLevel >= 3) {
      // Hide interior furniture so it is not visible through walls or wastes render power
      this.furnitureMeshes.forEach(mesh => {
        mesh.visible = false;
      });
      // Hide side walls & flooring (which is cut off by the capsule envelope)
      if (this.platformFloor) this.platformFloor.visible = false;
      this.sideWalls.forEach(wall => {
        wall.visible = false;
      });

      if (zoomLevel === 4) {
        // Level 4 (Space Station) uses a simpler silhouette/solid representation of the capsules
        if (this.capsuleRoof) {
          this.capsuleRoof.visible = true;
          // Apply a matte structural slate gray style to represent a simplified silhouette unit
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).color.setHex(0x1B2835);
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).roughness = 0.9;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).metalness = 0.1;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).opacity = 1.0;
        }
        this.capsuleOuterWalls.forEach(wall => {
          wall.visible = true;
          (wall.material as THREE.MeshStandardMaterial).color.setHex(0x1B2835);
          (wall.material as THREE.MeshStandardMaterial).roughness = 0.9;
          (wall.material as THREE.MeshStandardMaterial).metalness = 0.1;
          (wall.material as THREE.MeshStandardMaterial).opacity = 1.0;
        });
      } else {
        // Level 3 (Outside Room) uses the high-fidelity metal capsule texture mapping
        if (this.capsuleRoof) {
          this.capsuleRoof.visible = true;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).color.setHex(0x2A3E52);
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).roughness = 0.4;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).metalness = 0.8;
          (this.capsuleRoof.material as THREE.MeshStandardMaterial).opacity = 1.0;
        }
        this.capsuleOuterWalls.forEach(wall => {
          wall.visible = true;
          (wall.material as THREE.MeshStandardMaterial).color.setHex(0x2A3E52);
          (wall.material as THREE.MeshStandardMaterial).roughness = 0.4;
          (wall.material as THREE.MeshStandardMaterial).metalness = 0.8;
          (wall.material as THREE.MeshStandardMaterial).opacity = 1.0;
        });
      }
    } else {
      // Restore interior rendering when playing inside levels <= 2 (Room / First-Person)
      this.furnitureMeshes.forEach(mesh => {
        mesh.visible = true;
      });
      if (this.platformFloor) this.platformFloor.visible = true;
      // 🧱🪟 Placed wall sections REPLACE a built-in side wall — the interior
      // restore must not resurrect a covered one.
      this.sideWalls.forEach((wall, i) => {
        wall.visible = !this.sideWallCovered[i];
      });

      // Completely clear and hide outer capsule roof and shielding so they don't block the camera!
      if (this.capsuleRoof) {
        this.capsuleRoof.visible = false;
      }
      this.capsuleOuterWalls.forEach(wall => {
        wall.visible = false;
      });
    }

    // Animate station planet (rotation + gentle floating)
    if (this.stationPlanet) {
      this.stationPlanet.rotation.y += deltaTime * 0.3;
      this.stationPlanet.rotation.x = Math.sin(this.time * 0.5) * 0.05;
      this.stationPlanet.position.y = Math.sin(this.time * 0.8) * 0.15;
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
        !this.isMorphing && zoomLevel >= 2 && zoomLevel <= 4 && !deviceFocus.isActive();
      this.dockingSystem.updateFacingFade(deltaTime, fadeEnabled, this.player.getActiveDoorId());
    }

    // Advance trunk lid swings (TR2 — same update-loop-driven idiom)
    for (const lid of this.trunkLids.values()) lid.update(deltaTime);

    // Advance game-table top flips (#45 — same update-loop-driven idiom)
    for (const top of this.gameTableTops.values()) top.update(deltaTime);

    // 🧬 Advance clone-vat drain / door-spin cycles (same idiom)
    for (const vat of this.cloneVats.values()) vat.update(deltaTime);

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
        this.particlePositions[i*3+1] += deltaTime * 0.09;
        if (this.particlePositions[i*3+1] > 4.0) {
          this.particlePositions[i*3+1] = 0.05;
          this.particlePositions[i*3]   = (Math.random() - 0.5) * 10.5;
          this.particlePositions[i*3+2] = (Math.random() - 0.5) * 10.5;
        }
      }
      (this.particleGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

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
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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
  ) {
    // 🛏️ The tick carries elevation as ONE bit (flags bit3): bunk berths are
    // the only elevated seats, so the bit maps straight to the top-mattress
    // height. A future variable-height seat would need a real y on the wire.
    const elevY = elevated ? BUNK_TOP_Y : 0;
    const avatar = this.remotePlayers.get(id);
    if (!avatar) {
      console.log(`🤖 Spawning remote player fox avatar: ${id}`);
      // Parent the rig to the same scene the local player's rig lives in
      // (player.ts hands the raw scene to VoxelCharacter) so both share
      // identical transforms. Floor-anchored at y=0, like the local player.
      const rig = new VoxelCharacter(this.scene);
      rig.masterGroup.position.set(x, 0, z);
      this.applyPeerTint(rig, id);
      this.remotePlayers.set(id, {
        rig,
        targetX: x, targetZ: z,
        lastX: x, lastZ: z,
        moving,
        seated,
        facing,
        lying,
        elevY,
        heading: 0,
      });
      return;
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
      pos.y = THREE.MathUtils.lerp(pos.y, avatar.seated ? avatar.elevY : 0, factor);

      // Robust moving detection: trust the sender's flag OR the fact that we
      // are still visibly far from the target — animates even when the flag is
      // unreliable, and settles to idle on arrival.
      // #63: a seated peer renders the sit pose at the seat facing and skips the
      // motion-derived walk/idle path entirely (still lerps to the seat point).
      // 🛏️ A lying peer (flags bit2) renders the 'sleep' pose instead.
      if (avatar.seated) {
        avatar.rig.setState(avatar.lying ? 'sleep' : 'sit_chair', avatar.facing);
        avatar.rig.update();
        continue;
      }

      const remaining = Math.hypot(avatar.targetX - pos.x, avatar.targetZ - pos.z);
      const moving = avatar.moving || remaining > 0.05;

      const dx = pos.x - avatar.lastX;
      const dz = pos.z - avatar.lastZ;
      if (moving && Math.hypot(dx, dz) > 1e-4) {
        avatar.heading = snapTo8Ways(Math.atan2(dx, dz));
      }

      avatar.rig.setState(moving ? 'walk' : 'idle', avatar.heading);
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
  public getRemoteAvatarSnapshots(): Array<{ id: string; x: number; z: number }> {
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
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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
      showHint('This port is blocked by the hearth.');
      return;
    }

    // #67 D1: passage policy — an owner-restricted door refuses non-owners
    // before any walk choreography starts.
    if (!this.dockingSystem.canPass(door.id)) {
      showHint('This door\'s passage is restricted by the room owner.');
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
      const r = worldToRow(door.front.z), c = worldToCol(door.front.x);
      if (walkable[r]?.[c]) return door;
      let best: { x: number; z: number; d: number } | null = null;
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          if (!walkable[r + dr]?.[c + dc]) continue;
          const wx = colToWorld(c + dc), wz = rowToWorld(r + dr);
          const d = Math.hypot(wx - door.front.x, wz - door.front.z);
          if (d <= 1.6 && (!best || d < best.d)) best = { x: wx, z: wz, d };
        }
      }
      if (!best) {
        showHint('The doorway is blocked by furniture.');
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
      return !!(state && state.pairedSuccessfully && state.connectedRoomAddress)
        && this.onAdapterTransit !== null;
    };
    this.player.navigateToDoor(walkableDoor, {
      requestOpen: (onOpened) => {
        const state = ds.getDockingState(door.id);
        if (state && state.locked) {
          showHint('Docking port is LOCKED. Use the keypad.');
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
              : 'No room docked at this port — heading back.',
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
        const seed = state?.connectedRoomAddress ?? '';
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
    const group = segments && segments.length > 0
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
    setVestibuleLightState(vestibule, 'cycling');
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
    if (vestibule) setVestibuleLightState(vestibule, 'idle');
  }

  /** Remove and dispose one paired-door vestibule (geometries + materials). */
  private disposeVestibule(doorId: DoorId): void {
    const vestibule = this.pairedVestibules.get(doorId);
    if (!vestibule) return;
    this.pairedVestibules.delete(doorId);
    if (this.transitVestibuleDoorId === doorId) this.transitVestibuleDoorId = null;
    vestibule.parent?.remove(vestibule);
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    vestibule.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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
      const northSouth = door.id === 'north' || door.id === 'south';
      const lateral = Math.abs(northSouth ? p.x - door.front.x : p.z - door.front.z);
      const wallCoord = Math.abs(northSouth ? p.z : p.x);
      const approachDist = Math.hypot(p.x - door.front.x, p.z - door.front.z);

      const state = ds.getDockingState(door.id);
      const paired = !!(state && state.pairedSuccessfully && state.connectedRoomAddress);
      const passable = door.enabled && !state?.locked && ds.canPass(door.id);

      // Slide open on approach; slide shut once the player retreats.
      if (paired && passable && approachDist < 2.2 && !this.fpAutoOpened.has(door.id)) {
        ds.openDoor(door.id);
        this.fpAutoOpened.add(door.id);
      } else if (this.fpAutoOpened.has(door.id) && approachDist > 3.0) {
        ds.closeDoor(door.id);
        this.fpAutoOpened.delete(door.id);
      }

      // Threshold: pressed into the open doorway (the manual-movement clamp
      // stops the body at the wall, so "as far in as possible" IS the cross).
      const inAperture = lateral < 0.95 && wallCoord > 5.15;
      if (inAperture) inAnyAperture = true;
      if (
        inAperture && paired && passable
        && this.fpTransitArmed
        && now > this.fpArrivalCooldownUntil
        && !(this.isTransitBusy && this.isTransitBusy())
        && this.onAdapterTransit !== null
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
        if (vestibule && this.transitVestibuleDoorId !== door.id && activeDoorId !== door.id) {
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
        vestibule && vestibule.userData.segmentsKey !== wantKey &&
        this.transitVestibuleDoorId !== door.id && activeDoorId !== door.id
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
      } else if (this.transitVestibuleDoorId === door.id || activeDoorId === door.id) {
        target = 1.0; // transit / walk-through in progress — fully material
      } else {
        const dist = Math.hypot(playerPos.x - door.front.x, playerPos.z - door.front.z);
        const t = THREE.MathUtils.clamp(1 - dist / World.VESTIBULE_FADE_RANGE, 0, 1);
        target = World.VESTIBULE_BASE_OPACITY + t * (1 - World.VESTIBULE_BASE_OPACITY);
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
  public resolveArrivalDoor(departureDoorId: DoorId, farDoor?: DoorId, fromRoomId?: string): DoorTarget {
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
      north: 'south', south: 'north', east: 'west', west: 'east',
    };
    const candidate = findDoor(opposite[departureDoorId]);
    if (candidate && candidate.enabled) return candidate;
    return findDoor('east')!; // north is the only disabled door; east always exists
  }

  /**
   * Success half of the swap, called by main.ts while the transit fade is
   * fully opaque and the target room's session is live: end the transit
   * (vestibule back to 'idle' — it persists while its door stays paired,
   * #51) and script the walk-in through the arrival door.
   */
  public completeAdapterArrival(departureDoorId: DoorId, farDoor?: DoorId, fromRoomId?: string): void {
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
    const arrival = this.resolveArrivalDoor(departureDoorId, farDoor, fromRoomId);
    this.player.enterFromDoor(arrival, this._makeArrivalHooks(arrival));
  }

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
    this.player.beamTo(0, 1.5); // the Player constructor's spawn point
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
    if (vestibule) setVestibuleLightState(vestibule, 'fault');
    const door = findDoor(departureDoorId);
    if (!door) { this.endTransitVestibule(); return; }
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
  private _makeArrivalHooks(door: DoorTarget, endTransitOnClose = false): DoorSequenceHooks {
    const ds = this.dockingSystem;
    return {
      requestOpen: (onOpened) => {
        if (!ds) { onOpened(); return true; }
        ds.openDoor(door.id, onOpened);
        return true;
      },
      requestClose: () => {
        ds?.closeDoor(door.id);
        if (endTransitOnClose) this.endTransitVestibule();
      },
      onThrough: () => { /* arrival leg never re-crosses outward */ },
    };
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

    if (device.kind === 'roomTerminal') {
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
        },
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === 'mapTable') {
      // M4: the solar map, diegetic — mounted inside the focus overlay.
      const ui = createMapTableUI({ requestRelease: () => deviceFocus.release() });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === 'storageTrunk') {
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

    if (device.kind === 'gameTable') {
      // #45 v1: flippable surface + doc-synced checkers. The flip is a UI
      // affordance (button), not focus choreography — no prepare hook; the
      // top handle simply rides along so FLIP can drive the tween.
      const ui = createGameTableUI({
        itemId: deviceId,
        top: this.gameTableTops.get(deviceId) ?? null,
      });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    if (device.kind === 'helm') {
      // 🚀 #30 SH1: ship-status readout (flight controls come with the
      // flight slices — the panel says so).
      deviceFocus.beginFocus(this.player, device, createHelmUI());
      return;
    }

    if (device.kind === 'cashier' || device.kind === 'roulette') {
      // 🎰 #69 G1/G2: the HOUSE side (cashier book, croupier spin) rides the
      // same owner-equivalent seam as room editing — canEditRoom funnels
      // main.ts's isLocalPlayerRoomOwner, so a venture-owned room makes every
      // shareholder the house (the #68 V1 rule, applied to the casino).
      const isHouse = () => canEditRoom().ok;
      const ui = device.kind === 'cashier'
        ? createCashierUI({ isHouse })
        : createRouletteUI({ itemId: deviceId, isHouse });
      deviceFocus.beginFocus(this.player, device, ui);
      return;
    }

    // The desk computer UI arrives with M3.
    showHint('This device is not operational yet.');
  }

  /**
   * Stable room id for per-room local state (TR2 trunk stowage keys).
   * main.ts publishes the bootstrap roomId on join; before networking is up
   * (or when it fails) this falls back to the per-install default (getDefaultRoomId).
   */
  private static activeRoomId(): string {
    const id = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
    return typeof id === 'string' && id.length > 0 ? id : getDefaultRoomId();
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
    const viaMain = (window as unknown as { __setOutfit?: (id: string) => boolean }).__setOutfit;
    if (typeof viaMain === 'function') return viaMain(outfitId);
    const outfit = getOutfitById(outfitId);
    if (!outfit) return false;
    // Player keeps its rig private; reach through for this cosmetic path
    // (same escape hatch main.ts uses — frozen player/character public API).
    (this.player as unknown as { character: { setOutfit(o: OutfitDef): void } })
      .character.setOutfit(outfit);
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

  /** First clone-vat item with a live handle, or null (vat-less room). */
  private findSpawnVat(): { item: FurnitureItem; handle: CloneVatHandle } | null {
    for (const item of FURNITURE) {
      if (item.kind !== 'clone-vat') continue;
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
      !!zoomView && typeof zoomView.getLevel === 'function' && zoomView.getLevel() === 1;
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
      console.log(`[Docking Pipeline] Dispatching connection handshake: ${doorId} -> ${address}`);
    });

    // #64: publish a completed local pairing to the shared `doors` doc so every
    // other user in the room reconciles it (sees the docked module + can enter).
    // completePairing is the sole setter of pairedSuccessfully, so this is the
    // single publish point; the reconcile path (applyRemotePairing) deliberately
    // does NOT fire this callback, so applying a remote pairing never re-publishes.
    this.dockingSystem.onPairingStatusChanged((doorId, status) => {
      if (status === 'ACCEPTED') {
        const st = this.dockingSystem?.getDockingState(doorId as 'north' | 'south' | 'east' | 'west');
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
      } else if (status === 'REJECTED') {
        deleteDoorPairing(doorId);
      }
    });
  }
}
