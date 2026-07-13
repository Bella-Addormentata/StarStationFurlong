/**
 * World/Room Management
 * Handles room creation and game world state with planet-to-platform morphing.
 * Includes a click-navigation plane for point-and-click pathfinding.
 */

import * as THREE from 'three';
import { Player } from './player';
import { InputManager } from './input';
import { findSeatAt } from './seats';
import { FURNITURE, buildItemGroup } from './furniture';
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
  /** One group per furniture item, keyed by item id (selection/movement — E2+). */
  public furnitureGroups: Map<string, THREE.Group> = new Map();
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
    for (const item of FURNITURE) {
      const group = buildItemGroup(item);
      this.platformGroup.add(group);
      this.furnitureGroups.set(item.id, group);
      group.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          this.furnitureMeshes.push(obj);
        } else if (obj instanceof THREE.PointLight) {
          this.furnitureLights.push({ light: obj, targetIntensity: (obj.userData.targetIntensity as number) ?? 0 });
        }
      });
    }
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
