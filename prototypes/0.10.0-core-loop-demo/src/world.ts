/**
 * World/Room Management
 * Handles room creation and game world state with planet-to-platform morphing.
 * Includes a click-navigation plane for point-and-click pathfinding.
 */

import * as THREE from 'three';
import { Player } from './player';
import { InputManager } from './input';
import { findSeatAt } from './seats';
import { DoorDockingPortSystem } from './docking';

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
  // Lobby furniture (fades in to full opacity)
  private furnitureMeshes: THREE.Mesh[] = [];
  private furnitureLights: Array<{ light: THREE.PointLight; targetIntensity: number }> = [];
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
  }

  /**
   * Add lobby furniture — sofas, coffee table, side tables, cabinets, fireplace.
   * All pieces start at opacity 0 and are stored in furnitureMeshes for morph fade-in.
   */
  private addLobbyFurniture() {
    // ── Warm frontier colour palette ────────────────────────────────────────
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

    const m = (color: number, rough = 0.72, metal = 0.06, em = 0x000000, emI = 0) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: em, emissiveIntensity: emI, transparent: true, opacity: 0 });
    const flat = (color: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });

    const place = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      this.platformGroup.add(mesh);
      this.furnitureMeshes.push(mesh);
      return mesh;
    };

    const addLight = (light: THREE.PointLight, x: number, y: number, z: number, targetIntensity: number) => {
      light.position.set(x, y, z);
      this.platformGroup.add(light);
      this.furnitureLights.push({ light, targetIntensity });
    };

    // ── RUGS — back fireplace zone + front entrance lounge ────────────────────
    place(new THREE.BoxGeometry(8.0, 0.018, 6.0), m(RUG_A,    0.98, 0.0), 0, 0.009, -2.0);
    place(new THREE.BoxGeometry(7.6, 0.020, 5.6), m(RUG_B,    0.98, 0.0), 0, 0.011, -2.0);
    place(new THREE.BoxGeometry(7.2, 0.022, 5.2), m(0xE8A878,  0.98, 0.0), 0, 0.013, -2.0);
    place(new THREE.BoxGeometry(6.0, 0.018, 4.0), m(0xD4B090,  0.98, 0.0), 0, 0.009, +3.0);
    place(new THREE.BoxGeometry(5.6, 0.020, 3.6), m(0xBC9878,  0.98, 0.0), 0, 0.011, +3.0);
    place(new THREE.BoxGeometry(5.2, 0.022, 3.2), m(0xE0C8A8,  0.98, 0.0), 0, 0.013, +3.0);

    // ── INTEGRATED FIREPLACE + BOOKCASE WALL ──────────────────────────────────
    // Layout: [bookcase SW=2.90] [stone pillar PW=0.52] [opening FW=2.60] [pillar] [bookcase]
    // Total unit ≈ 9.62 wide, centered at x=0, front face at z=FZ
    const FZ   = -5.55;
    const UH   = 2.65;  // body height
    const UD   = 0.46;  // depth
    const FW   = 2.60;  // opening interior width
    const FH   = 1.82;  // opening interior height
    const PW   = 0.52;  // stone pillar width
    const SW   = 2.90;  // bookcase panel width each side
    const BX   = FW / 2 + PW + SW / 2;        // bookcase centre x ≈ 3.27
    const CW   = (BX + SW / 2) * 2 + 0.18;   // cornice full width ≈ 9.62
    const MT   = UH + 0.26;                    // mantle shelf top surface y ≈ 2.91
    const OMH  = UH - FH - 0.28;              // overmantel height ≈ 0.55

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
    addLight(new THREE.PointLight(0xFF7A30, 0, 14),  0,    1.2,      FZ + 1.0, 2.8);
    addLight(new THREE.PointLight(0xFFCC66, 0,  5), -1.35, MT + 0.50, FZ + 0.4, 0.6);
    addLight(new THREE.PointLight(0xFFCC66, 0,  5),  1.35, MT + 0.50, FZ + 0.4, 0.6);

    // ── SEATING HELPERS ───────────────────────────────────────────────────────
    // Wall armchair — backDir: -1 backrest toward x=-6, +1 toward x=+6
    const makeArmchair = (cx: number, cz: number, backDir: number) => {
      place(new THREE.BoxGeometry(0.92, 0.24, 0.92), m(CREAM, 0.82, 0.05), cx,                  0.22, cz);
      place(new THREE.BoxGeometry(0.22, 0.66, 0.92), m(CREAM, 0.82, 0.05), cx + backDir * 0.46, 0.71, cz);
      place(new THREE.BoxGeometry(0.92, 0.46, 0.22), m(BEIGE, 0.78, 0.06), cx, 0.45, cz - 0.46);
      place(new THREE.BoxGeometry(0.92, 0.46, 0.22), m(BEIGE, 0.78, 0.06), cx, 0.45, cz + 0.46);
      place(new THREE.BoxGeometry(0.76, 0.13, 0.76), m(LINEN, 0.85, 0.04), cx,                  0.39, cz);
      place(new THREE.BoxGeometry(0.13, 0.44, 0.76), m(LINEN, 0.85, 0.04), cx + backDir * 0.39, 0.64, cz);
      ([[0.34, -0.35], [0.34, 0.35], [-0.34, -0.35], [-0.34, 0.35]] as [number, number][]).forEach(([dx, dz]) =>
        place(new THREE.CylinderGeometry(0.038, 0.038, 0.15, 8), m(WOOD, 0.45, 0.25), cx + dx, 0.075, cz + dz));
    };
    // 3-seater sofa facing z — faceZ: -1 faces fireplace, +1 faces entrance
    const makeSofa3 = (sx: number, sz: number, faceZ: number) => {
      place(new THREE.BoxGeometry(2.4, 0.24, 0.96),  m(CREAM, 0.82, 0.05), sx, 0.22, sz);
      place(new THREE.BoxGeometry(2.4, 0.66, 0.22),  m(CREAM, 0.82, 0.05), sx, 0.71, sz + faceZ * 0.46); // backrest
      place(new THREE.BoxGeometry(0.24, 0.46, 0.96), m(BEIGE, 0.78, 0.06), sx - 1.2, 0.45, sz);
      place(new THREE.BoxGeometry(0.24, 0.46, 0.96), m(BEIGE, 0.78, 0.06), sx + 1.2, 0.45, sz);
      ([-0.74, 0, 0.74] as number[]).forEach(dx =>
        place(new THREE.BoxGeometry(0.72, 0.13, 0.82), m(LINEN, 0.85, 0.04), sx + dx, 0.39, sz));
      ([-0.74, 0, 0.74] as number[]).forEach(dx =>
        place(new THREE.BoxGeometry(0.68, 0.44, 0.22), m(LINEN, 0.85, 0.04), sx + dx, 0.64, sz + faceZ * 0.39));
      ([[1.06, 0.39], [1.06, -0.39], [-1.06, 0.39], [-1.06, -0.39]] as [number, number][]).forEach(([dx, dz]) =>
        place(new THREE.CylinderGeometry(0.042, 0.042, 0.15, 8), m(WOOD, 0.45, 0.25), sx + dx, 0.075, sz + dz));
    };

    // ── LEFT WALL ARMCHAIRS (x=-4.5, facing +x) ──────────────────────
    makeArmchair(-4.5, -3.5, -1);
    makeArmchair(-4.5, -1.5, -1);
    makeArmchair(-4.5,  0.5, -1);
    makeArmchair(-4.5,  2.5, -1);

    // ── RIGHT WALL ARMCHAIRS (x=+4.5, facing -x) ─────────────────────
    makeArmchair( 4.5, -3.5,  1);
    makeArmchair( 4.5, -1.5,  1);
    makeArmchair( 4.5,  0.5,  1);
    makeArmchair( 4.5,  2.5,  1);

    // ── BACK FIREPLACE CONVERSATION GROUP — sofa + coffee table only ────────────
    // 3-seater sofa back toward entrance, seat facing fireplace
    makeSofa3(0, -1.5, -1);
    // (flanking armchairs moved to side walls)
    // Coffee table between sofa and fireplace: 2x1 tiles
    place(new THREE.BoxGeometry(2.0, 0.06, 1.0), m(WOOD, 0.40, 0.22), 0, 0.37, -3.5);
    ([[0.90, 0.38], [0.90, -0.38], [-0.90, 0.38], [-0.90, -0.38]] as [number, number][]).forEach(([lx, lz]) =>
      place(new THREE.BoxGeometry(0.06, 0.32, 0.06), m(WOOD, 0.45, 0.20), lx, 0.16, lz - 3.5));
    place(new THREE.CylinderGeometry(0.06, 0.048, 0.08, 12), m(TERRA, 0.85, 0.08), -0.40, 0.44, -3.5);
    place(new THREE.SphereGeometry(0.09, 10, 10), m(PK1, 0.88, 0.02), -0.40, 0.56, -3.5);
    place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0xD09060, 0.8, 0.05),  0.35, 0.41, -3.5);
    place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0x6A9468, 0.8, 0.05),  0.35, 0.443, -3.5);

    // ── FRONT ENTRANCE LOUNGE — sofa + coffee table only ─────────────────────
    // 3-seater sofa
    makeSofa3(0, 3.5, -1);
    // Coffee table: 2x1 tiles
    place(new THREE.BoxGeometry(2.0, 0.06, 1.0), m(WOOD, 0.40, 0.22), 0, 0.37, 1.5);
    ([[0.90, 0.38], [0.90, -0.38], [-0.90, 0.38], [-0.90, -0.38]] as [number, number][]).forEach(([lx, lz]) =>
      place(new THREE.BoxGeometry(0.06, 0.32, 0.06), m(WOOD, 0.45, 0.20), lx, 0.16, lz + 1.5));
    place(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 12), m(TERRA, 0.85, 0.08), -0.30, 0.44, 1.5);
    place(new THREE.SphereGeometry(0.08, 10, 10), m(PK2, 0.88, 0.02), -0.30, 0.54, 1.5);
    place(new THREE.BoxGeometry(0.18, 0.032, 0.12), m(0xA09060, 0.8, 0.05),  0.30, 0.41, 1.5);
    place(new THREE.BoxGeometry(0.16, 0.032, 0.12), m(0x5A90A8, 0.8, 0.05),  0.30, 0.442, 1.5);

    // ── LAMP TABLES — 4 total (back zone + front zone) ────────────────────────
    const makeSideTable = (tx: number, tz: number) => {
      place(new THREE.CylinderGeometry(0.28, 0.24, 0.048, 18), m(WOOD,   0.40, 0.22), tx, 0.54, tz);
      place(new THREE.CylinderGeometry(0.038, 0.038, 0.50, 8), m(DKWOOD, 0.55, 0.18), tx, 0.27, tz);
      place(new THREE.CylinderGeometry(0.17,  0.17,  0.04, 14),m(DKWOOD, 0.55, 0.18), tx, 0.02, tz);
      place(new THREE.CylinderGeometry(0.055, 0.075, 0.20, 10),m(DKWOOD, 0.50, 0.20), tx, 0.72, tz);
      place(new THREE.CylinderGeometry(0.18,  0.12,  0.28, 14),m(0xF8E8C0, 0.88, 0.02, 0xFFD080, 0.55), tx, 0.96, tz);
    };
    // Back zone lamp tables (1x1 corners)
    makeSideTable(-4.5, -4.5);
    makeSideTable( 4.5, -4.5);
    addLight(new THREE.PointLight(0xFFD080, 0, 7), -4.5, 1.1, -4.5, 1.0);
    addLight(new THREE.PointLight(0xFFD080, 0, 7),  4.5, 1.1, -4.5, 1.0);
    // Front zone lamp tables (1x1 corners)
    makeSideTable(-4.5, 3.5);
    makeSideTable( 4.5, 3.5);
    addLight(new THREE.PointLight(0xFFD080, 0, 7), -4.5, 1.1, 3.5, 1.0);
    addLight(new THREE.PointLight(0xFFD080, 0, 7),  4.5, 1.1, 3.5, 1.0);

    // (Bookshelves merged into integrated fireplace wall above)

    // ── TALL CHERRY BLOSSOM TREES (four corners) ─────────────────────────────
    const makeTallPlant = (px: number, pz: number) => {
      place(new THREE.CylinderGeometry(0.22, 0.17, 0.40, 14),   m(TERRA,    0.85, 0.07), px,        0.20, pz);
      place(new THREE.CylinderGeometry(0.235, 0.225, 0.048, 14), m(0xC06840, 0.80, 0.05), px,       0.43, pz);
      place(new THREE.CylinderGeometry(0.058, 0.082, 1.22, 8),   m(0x4A2A18, 0.85, 0.05), px,       1.04, pz);
      place(new THREE.SphereGeometry(0.44, 12, 12), m(PK1, 0.88, 0.02), px,         1.88, pz);
      place(new THREE.SphereGeometry(0.36, 12, 12), m(PK2, 0.86, 0.02), px - 0.34,  1.66, pz + 0.18);
      place(new THREE.SphereGeometry(0.34, 12, 12), m(PK2, 0.86, 0.02), px + 0.34,  1.66, pz - 0.16);
      place(new THREE.SphereGeometry(0.28, 12, 12), m(PK3, 0.84, 0.02), px - 0.12,  2.20, pz);
      place(new THREE.SphereGeometry(0.22, 12, 12), m(PK1, 0.88, 0.02), px + 0.28,  2.00, pz + 0.20);
    };
    makeTallPlant(-5.0,  4.5);
    makeTallPlant(-5.0,  3.0); // moved — bar occupies right-front corner
    makeTallPlant(-4.9, -5.0);
    makeTallPlant( 4.9, -5.0);

    // ── SMALL CHERRY BLOSSOM ACCENTS on lamp tables ───────────────────────────
    const makeRoundPlant = (px: number, py: number, pz: number) => {
      place(new THREE.CylinderGeometry(0.11, 0.08, 0.17, 12), m(TERRA, 0.85, 0.07), px, py + 0.085, pz);
      place(new THREE.SphereGeometry(0.16, 10, 10), m(PK1, 0.88, 0.02), px,        py + 0.27, pz);
      place(new THREE.SphereGeometry(0.12, 10, 10), m(PK3, 0.84, 0.02), px + 0.10, py + 0.23, pz + 0.05);
    };
    makeRoundPlant(-4.3, 0.56, -4.7);
    makeRoundPlant( 4.3, 0.56, -4.7);
    makeRoundPlant(-3.8, 0.56, +3.2);
    makeRoundPlant( 3.8, 0.56, +3.2);

    // ── BAR CORNER (right-front, hugging x=+6 wall) ───────────────────────────────
    const BAR_X = 5.24;  // bar body centre x (depth 0.58, back face at +5.53)
    const BAR_Z = 3.10;  // bar centre z
    const BAR_L = 2.80;  // bar length (z direction)  z range: 1.70 → 4.50
    const BAR_H = 1.08;  // counter height

    // Cabinet body
    place(new THREE.BoxGeometry(0.58, BAR_H, BAR_L), m(DKWOOD, 0.78, 0.06), BAR_X, BAR_H / 2, BAR_Z);
    // Counter top (white, slight overhang toward room)
    place(new THREE.BoxGeometry(0.76, 0.072, BAR_L + 0.18), m(0xFAFAFA, 0.45, 0.14), BAR_X - 0.07, BAR_H + 0.036, BAR_Z);
    // Counter edge trim
    place(new THREE.BoxGeometry(0.76, 0.036, BAR_L + 0.18), m(WOOD, 0.40, 0.28), BAR_X - 0.07, BAR_H + 0.090, BAR_Z);
    // Footrest rail (box)
    place(new THREE.BoxGeometry(0.044, 0.038, BAR_L - 0.24), m(WOOD, 0.40, 0.30), BAR_X - 0.22, 0.25, BAR_Z);

    // Back panel (flat against x=+6 wall)
    place(new THREE.BoxGeometry(0.055, 1.88, BAR_L + 0.10), m(0xF5F5F5, 0.88, 0.02), 5.97, 0.94, BAR_Z);
    // Three shelves on back wall
    ([0.52, 1.00, 1.50] as number[]).forEach(sy =>
      place(new THREE.BoxGeometry(0.28, 0.036, BAR_L + 0.04), m(0xE8E8E8, 0.72, 0.04), 5.84, sy, BAR_Z));

    // Bottles (cylinder body + neck + cap)
    const makeBottle = (bz: number, sy: number, col: number) => {
      place(new THREE.CylinderGeometry(0.040, 0.048, 0.22, 8), m(col, 0.22, 0.58), 5.84, sy + 0.11, bz);
      place(new THREE.CylinderGeometry(0.017, 0.028, 0.09, 8), m(col, 0.22, 0.58), 5.84, sy + 0.265, bz);
      place(new THREE.SphereGeometry(0.020, 6, 6),              m(0x888888, 0.40, 0.40), 5.84, sy + 0.315, bz);
    };
    const BCOLS = [0x3A7840, 0xA83020, 0xE8C030, 0x284890, 0xD07020, 0x60A050, 0x8848A0];
    const BOFFS = [-1.1, -0.55, 0, 0.55, 1.1];
    BOFFS.forEach((dz, i) => makeBottle(BAR_Z + dz, 0.52, BCOLS[i % BCOLS.length]));
    BOFFS.forEach((dz, i) => makeBottle(BAR_Z + dz, 1.00, BCOLS[(i + 2) % BCOLS.length]));
    BOFFS.forEach((dz, i) => makeBottle(BAR_Z + dz, 1.50, BCOLS[(i + 4) % BCOLS.length]));

    // Wine glasses on counter (very thin cylinder + stem + base)
    const makeGlass = (gz: number) => {
      place(new THREE.CylinderGeometry(0.042, 0.018, 0.15, 10), m(0xDDEEFF, 0.06, 0.12), BAR_X - 0.14, BAR_H + 0.147, gz);
      place(new THREE.CylinderGeometry(0.006, 0.006, 0.10,  8), m(0xDDEEFF, 0.06, 0.12), BAR_X - 0.14, BAR_H + 0.297, gz);
      place(new THREE.CylinderGeometry(0.028, 0.028, 0.012,10), m(0xDDEEFF, 0.06, 0.12), BAR_X - 0.14, BAR_H + 0.348, gz);
    };
    makeGlass(BAR_Z - 0.80);
    makeGlass(BAR_Z - 0.10);
    makeGlass(BAR_Z + 0.60);

    // Bar stools (3, facing bar / +x)
    const makeBarStool = (sz: number) => {
      place(new THREE.CylinderGeometry(0.21, 0.21, 0.052, 14), m(CREAM, 0.82, 0.04), BAR_X - 0.64, 0.71,  sz); // seat pad
      place(new THREE.CylinderGeometry(0.19, 0.19, 0.038, 14), m(LINEN, 0.85, 0.04), BAR_X - 0.64, 0.752, sz); // cushion
      place(new THREE.CylinderGeometry(0.034, 0.034, 0.65, 8), m(WOOD,  0.45, 0.25), BAR_X - 0.64, 0.37,  sz); // stem
      place(new THREE.CylinderGeometry(0.21, 0.21, 0.038, 14), m(WOOD,  0.45, 0.25), BAR_X - 0.64, 0.019, sz); // base
      // footrest cross
      place(new THREE.BoxGeometry(0.36, 0.028, 0.036), m(WOOD, 0.45, 0.25), BAR_X - 0.64, 0.35, sz);
      place(new THREE.BoxGeometry(0.036, 0.028, 0.36), m(WOOD, 0.45, 0.25), BAR_X - 0.64, 0.35, sz);
    };
    makeBarStool(BAR_Z - 0.95);
    makeBarStool(BAR_Z);
    makeBarStool(BAR_Z + 0.95);

    // Pendant light above bar
    place(new THREE.CylinderGeometry(0.13, 0.09, 0.17, 12), m(0x282828, 0.70, 0.10), BAR_X - 0.45, 2.14, BAR_Z); // shade
    addLight(new THREE.PointLight(0xFFE8A0, 0, 10), BAR_X - 0.45, 1.9, BAR_Z, 1.6);

    // Small blossom pot at bar end
    makeRoundPlant(BAR_X - 0.14, BAR_H + 0.072, BAR_Z - BAR_L / 2 + 0.22);
  }

  /**
   * Add atmosphere effects: pendant lights, holographic display,
   * space-view windows, colored cushions, floating particles.
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

    // ── COLORED THROW CUSHIONS ────────────────────────────────────────────────
    const cushGeo = new THREE.BoxGeometry(0.60, 0.09, 0.60);
    // Back sofa (z=-1.5)
    [ [-0.72, 0xC04060], [0, 0x3870C8], [0.72, 0xD89030] ].forEach(([dx, col]) =>
      place(cushGeo.clone(), m(col as number, 0.82, 0.02), dx as number, 0.47, -1.5));
    // Front sofa (z=+3.2)
    [ [-0.72, 0x50A870], [0, 0xC04060], [0.72, 0x3870C8] ].forEach(([dx, col]) =>
      place(cushGeo.clone(), m(col as number, 0.82, 0.02), dx as number, 0.47, +3.2));

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

    // Show grid
    if (this.platformGrid && eased > 0.5) {
      this.platformGrid.visible = true;
    }

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

    // Fade in furniture to full opacity
    this.furnitureMeshes.forEach(mesh => {
      const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
      if ('opacity' in mat) mat.opacity = eased;
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
      this.sideWalls.forEach(wall => {
        wall.visible = true;
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

    if (this.player.mesh.visible) {
      this.player.update(deltaTime, inputManager);
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
  }

  public remotePlayers: Map<string, THREE.Mesh> = new Map();

  public updateRemotePlayer(id: string, x: number, z: number) {
    let mesh = this.remotePlayers.get(id);
    if (!mesh) {
      console.log(`🤖 Spawning remote player node replica: ${id}`);
      // Create a cute red/amber orbital sphere representing a remote clone peer (Task 3.2 red vs green form)
      const geo = new THREE.SphereGeometry(0.8, 32, 32);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xff4433,
        roughness: 0.8,
        metalness: 0.1,
        emissive: 0x330502,
        emissiveIntensity: 0.3
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 1.0, z);
      this.platformGroup.add(mesh);
      this.remotePlayers.set(id, mesh);
    } else {
      // Smoothly lerp towards position (Task 3.4 interpolation)
      mesh.position.x = THREE.MathUtils.lerp(mesh.position.x, x, 0.28);
      mesh.position.z = THREE.MathUtils.lerp(mesh.position.z, z, 0.28);
      mesh.position.y = 1.0 + Math.sin(this.time * 2.2) * 0.015;
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

  isPlayerActive(): boolean {
    return this.player.mesh.visible && !this.isMorphing;
  }

  private initializeDockingPorts() {
    this.dockingSystem = new DoorDockingPortSystem(this.platformGroup);
    this.dockingSystem.buildPorts();

    // Hook P2P sync routing events (Task: Room pairings over Yjs awareness)
    this.dockingSystem.onConnectionRequest((doorId, address) => {
      console.log(`[Docking Pipeline] Dispatching connection handshake: ${doorId} -> ${address}`);
    });
  }
}
