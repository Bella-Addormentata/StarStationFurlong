/**
 * 🪐 Multi-Scale Zoom View and Context System - Phase 2
 *
 * Implements an interactive multi-scale system supporting keyboard manual view shifts
 * using standard "+" and "-" keys (or keyboard "= / -" triggers).
 *
 * Zoom levels / Views:
 *   1. FIRST PERSON — Zoomed inside the lobby platform.
 *   2. ROOM VIEW (DEFAULT) — Standard locked isometric 3D render of the platform.
 *   3. OUTSIDE ROOM — Outside grid of connected modules & node docking corridors.
 *   4. SPACE STATION — Grid structure of the entire H-shaped Space Station base.
 *   5. PLANET ORBIT — Lagrange orbits around Planet Sovereign, showcasing L1-L5 pockets.
 *   6. SOLAR SYSTEM — OpenTTD-style heliocentric grid of orbits and planets.
 *   7. GALAXY VIEW — Spiral starfield projection grid.
 *   8. UNIVERSE VIEW — Linked stellar nodes across deep expansion lines.
 *
 * Re-uses shared visual coordinate grids and projects 3D-shaded vectors on top.
 */

import * as THREE from 'three';

export interface ZoomScaleDef {
  level: number;
  name: string;
  gridColor: string;
  focusId: string;
  fuelCostMultiplier: number;
  description: string;
}

export const ZOOM_LEVELS: ZoomScaleDef[] = [
  {
    level: 1,
    name: 'FIRST-PERSON CLONE CAMERA',
    gridColor: 'rgba(0, 212, 255, 0.25)',
    focusId: 'lobby-interior',
    fuelCostMultiplier: 0,
    description: 'Direct first-person ocular perspective. Interacting with local seats and terminals.',
  },
  {
    level: 2,
    name: 'ROOM VIEW (BASE COZY LOBBY)',
    gridColor: 'rgba(212, 168, 75, 0.18)',
    focusId: 'lobby-room',
    fuelCostMultiplier: 0,
    description: 'Standard isometric parallel-projection of current lounge. Interactive seat maps active.',
  },
  {
    level: 3,
    name: 'OUTSIDE ROOM & MODULE EXPANSIONS',
    gridColor: 'rgba(212, 80, 75, 0.22)',
    focusId: 'module-structures',
    fuelCostMultiplier: 1,
    description: 'Visual grid wireframe of connected module expansions. View of local capsule docking tunnels.',
  },
  {
    level: 4,
    name: 'SPACE STATION ENTIRE ASSEMBLY',
    gridColor: 'rgba(0, 230, 118, 0.20)',
    focusId: 'h-station',
    fuelCostMultiplier: 2,
    description: 'H-Shaped Sovereign modular platform outline. Visualizing solar panels and thruster rigs.',
  },
  {
    level: 5,
    name: 'PLANET ORBITAL LAGRANGE REGIONS',
    gridColor: 'rgba(255, 179, 0, 0.20)',
    focusId: 'sovereign-orbit',
    fuelCostMultiplier: 4,
    description: 'orbital path of Sovereign II. Tracking co-orbital stable slots L4 and L5.',
  },
  {
    level: 6,
    name: 'SOLAR SYSTEM HELIOCENTRIC COOMMS',
    gridColor: 'rgba(156, 39, 176, 0.20)',
    focusId: 'sol-prime-system',
    fuelCostMultiplier: 8,
    description: 'OpenTTD-style map tracking orbits of inner bodies and asteroid fields around Sol.',
  },
  {
    level: 7,
    name: 'GALAXY SPIRAL CLUSTER',
    gridColor: 'rgba(233, 30, 99, 0.15)',
    focusId: 'orion-arm',
    fuelCostMultiplier: 16,
    description: 'Spiral starfield coordinate grid of Orion-Cygnus arm. Uncharted hyper-lanes active.',
  },
  {
    level: 8,
    name: 'UNIVERSE SEED LINKAGES',
    gridColor: 'rgba(121, 85, 72, 0.18)',
    focusId: 'infinite-seed',
    fuelCostMultiplier: 32,
    description: 'Infinite serverless seed networks connecting clusters in deep expanding paths.',
  }
];

// 🪐 Mouse-Look / Free Look states for First Person Level 1
let yaw = 0;   // Left-Right rotation (radians)
let pitch = 0; // Up-Down rotation (radians)
let initializedMouseLookOffset = false;
let perspectiveCamera: THREE.PerspectiveCamera | null = null;
let orthographicCamera: THREE.OrthographicCamera | null = null;

// 🟢 Transition / Animation states
let isTransitioningFirstPerson = false;
let transitionProgress = 0.0; // 0.0 to 1.0
let transitionStartPos = new THREE.Vector3();
let transitionTargetPos = new THREE.Vector3();

// Eyelid Blink state (for zooming out)
let isBlinking = false;
let blinkProgress = 0.0; // 0.0 to 1.0 (0=open, 0.5=fully closed, 1.0=fully open again)
let pendingZoomOutAction = false;

export class MultiScaleZoomView {
  private overlay: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private currentLevel = 2; // Default Room View
  private starsSeed: Array<{ x: number; y: number; size: number }> = [];
  
  // Custom interactive worlds for selection details in upper views
  private sectorBodies: Array<{ id: string; name: string; type: string; ext: string; fuel: number; eta: number; x: number; y: number }> = [];
  private selectedSectorBody: any = null;

  constructor() {
    this.generateStars();
    this.generateSectorBodies();
  }

  private generateStars() {
    for (let i = 0; i < 150; i++) {
      this.starsSeed.push({
        x: Math.random(),
        y: Math.random(),
        size: Math.random() * 1.5 + 0.5
      });
    }
  }

  private generateSectorBodies() {
    this.sectorBodies = [
      { id: 'world-aris', name: 'ARIS SECTOR', type: 'Volcanic Core', ext: 'Mineral Rich', fuel: 15, eta: 45, x: 200, y: 150 },
      { id: 'world-sovereign', name: 'SOVEREIGN CLUSTER', type: 'Terra World', ext: 'Atmosphere Pockets', fuel: 24, eta: 72, x: 450, y: 300 },
      { id: 'world-silent', name: 'THE SILENT BELT', type: 'Asteroid Field', ext: 'Debris Ore', fuel: 35, eta: 105, x: 300, y: 480 },
      { id: 'world-deep', name: 'OUTER REFUGE L5', type: 'Lagrange Anchor', ext: 'Uncharted', fuel: 50, eta: 150, x: 600, y: 220 }
    ];
  }

  public mount(parentEl: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.id = 'multiscale-zoom-overlay';
    this.overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: transparent;
      z-index: 3500;
      pointer-events: none; /* Let clicks pass through to 3D when Zoom level <=2 */
      color: #d4a84b;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      box-sizing: border-box;
      user-select: none;
    `;

    // Visual Canvas UI
    this.canvas = document.createElement('canvas');
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 10;
      pointer-events: none;
    `;
    this.overlay.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Overlay Header Indicator
    const indicator = document.createElement('div');
    indicator.id = 'zoom-hud-indicator';
    indicator.style.cssText = `
      position: absolute;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(4, 8, 22, 0.90);
      padding: 10px 24px;
      border-radius: 20px;
      border: 1px solid rgba(212, 168, 75, 0.28);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 1.5px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.8);
      z-index: 100;
      text-align: center;
      transition: all 0.3s;
    `;
    indicator.innerHTML = `LEVEL 2: ROOM VIEW (DEFAULT) <span style="font-size:9px; color:rgba(212,168,75,0.5); display:block; margin-top:2px;">PRESS [-] TO OUT / [+] TO IN</span>`;
    this.overlay.appendChild(indicator);

    // Context Sidebar details for upper views (levels >= 3)
    const sidebar = document.createElement('div');
    sidebar.id = 'zoom-sidebar';
    sidebar.style.cssText = `
      position: absolute;
      top: 100px;
      right: 24px;
      width: 320px;
      background: rgba(4, 8, 22, 0.92);
      border: 1px solid rgba(212, 168, 75, 0.22);
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.85);
      z-index: 100;
      display: none;
      flex-direction: column;
      gap: 12px;
      pointer-events: auto; /* Allow interactions on details cards */
    `;
    this.overlay.appendChild(sidebar);

    parentEl.appendChild(this.overlay);

    // Listeners for keyboard "+" and "-" zoom adjustments
    this.setupListeners();
  }

  private setupListeners() {
    // Free mouse-look handler inside Level 1 (First Person Perspective)
    window.addEventListener('mousemove', (e) => {
      if (this.currentLevel !== 1) return;
      
      // Accumulate rotation deltas based on mouse movement relative offsets
      const sensitivity = 0.003;
      
      // If pointer is locked use movement values, otherwise use mouse client delta
      const deltaX = document.pointerLockElement ? e.movementX : (e.clientX - window.innerWidth / 2) * 0.08;
      const deltaY = document.pointerLockElement ? e.movementY : (e.clientY - window.innerHeight / 2) * 0.08;

      yaw -= deltaX * sensitivity;
      pitch -= deltaY * sensitivity;

      // Constrain vertical look so the player cannot flip upside down
      const maxPitch = Math.PI * 0.45;
      pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
    });

    // Request pointer lock when clicking on canvas in Level 1 first-person view
    window.addEventListener('mousedown', () => {
      if (this.currentLevel === 1 && window.gameRenderer?.renderer?.domElement) {
        window.gameRenderer.renderer.domElement.requestPointerLock?.();
      }
    });

    window.addEventListener('keydown', (e) => {
      // Ignore toggling when focused in inputs
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.key === '-' || e.key === 'Subtract') {
        this.zoomOut();
      } else if (e.key === '+' || e.key === '=' || e.key === 'Add') {
        this.zoomIn();
      }
    });

    window.addEventListener('resize', () => {
      if (this.canvas) {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
      }
    });

    // Custom Canvas Click routing for upper views
    window.addEventListener('click', (e) => {
      if (this.currentLevel <= 2 || !this.canvas) return;
      
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Handle interactive targets for levels >= 6 (Solar / Galaxy scale)
      if (this.currentLevel >= 6) {
        for (const item of this.sectorBodies) {
          const distance = Math.hypot(item.x - clickX, item.y - clickY);
          if (distance <= 20) {
            this.selectSectorBody(item);
            return;
          }
        }
      }
    });
  }

  public getLevel(): number {
    return this.currentLevel;
  }

  private zoomIn() {
    if (this.currentLevel > 1) {
      if (this.currentLevel === 2) {
        // Trigger smooth trajectory transition to Level 1 (First Person) from current camera position
        const { camera } = window.gameRenderer;
        if (camera) {
          isTransitioningFirstPerson = true;
          transitionProgress = 0.0;
          transitionStartPos.copy(camera.position);

          const playerPos = (window as any).world?.getPlayer()?.getPosition() || new THREE.Vector3(0, 0, 1.5);
          // Target is behind the head looking into the central room (we look toward origin slightly)
          transitionTargetPos.set(playerPos.x, playerPos.y + 1.25, playerPos.z);
        }
      }
      this.currentLevel--;
      this.updateViewContext();
    }
  }

  private zoomOut() {
    if (this.currentLevel < 8) {
      if (this.currentLevel === 1) {
        // Trigger eyelid blink before returning to standard room view (Level 2)
        isBlinking = true;
        blinkProgress = 0.0;
        pendingZoomOutAction = true;
        return; // Pause zooming out until eyelids are fully closed at 0.5 progress
      }
      this.currentLevel++;
      this.updateViewContext();
    }
  }

  private updateViewContext() {
    const def = ZOOM_LEVELS[this.currentLevel - 1];
    
    // Update indicator HUD
    const ind = document.getElementById('zoom-hud-indicator');
    if (ind) {
      ind.innerHTML = `
        <span style="color:#00d4ff;">LEVEL ${def.level}: ${def.name}</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5); display:block; margin-top:2px;">PRESS [-] TO OUT / [+] TO IN</span>
      `;
    }

    // Adjust global 3D Three.js camera zooms dynamically
    const { camera, renderer } = window.gameRenderer;
    if (camera) {
      if (!orthographicCamera && camera instanceof THREE.OrthographicCamera) {
        orthographicCamera = camera;
      }

      if (this.currentLevel === 1) {
        // — FIRST PERSON perspective camera —
        if (!perspectiveCamera) {
          const aspect = window.innerWidth / window.innerHeight;
          perspectiveCamera = new THREE.PerspectiveCamera(65, aspect, 0.1, 1000);
          
          window.addEventListener('resize', () => {
            if (perspectiveCamera) {
              perspectiveCamera.aspect = window.innerWidth / window.innerHeight;
              perspectiveCamera.updateProjectionMatrix();
            }
          });
        }

        // Re-assign active camera in global renderer
        window.gameRenderer.camera = perspectiveCamera as any;

        // Query the player's active position dynamically so we look FROM the player's head instead of at them.
        const playerPos = (window as any).world?.getPlayer()?.getPosition() || new THREE.Vector3(0, 0, 1.5);
        
        // Hide local character mesh so we don't look inside our own head bounds!
        const playerChar = (window as any).world?.getPlayer();
        if (playerChar && playerChar.mesh) {
          playerChar.mesh.visible = false;
          initializedMouseLookOffset = true;
        }

        // Camera position is directly on top of the player's eye height (Y=1.25)
        if (isTransitioningFirstPerson) {
          // LERP trajectory from start layout up to target back-of-head
          const ratio = transitionProgress;
          const currentPos = new THREE.Vector3().lerpVectors(transitionStartPos, transitionTargetPos, ratio);
          perspectiveCamera.position.copy(currentPos);

          // Render dynamic avatar mesh fading (opacity reduces as we approach)
          const playerChar = (window as any).world?.getPlayer();
          if (playerChar && playerChar.mesh) {
            playerChar.mesh.visible = true; // keep visible during transition
            const opacity = Math.max(0.0, 1.0 - ratio);
            playerChar.mesh.traverse((child: any) => {
              if (child instanceof THREE.Mesh && child.material) {
                child.material.transparent = true;
                child.material.opacity = opacity;
                child.material.needsUpdate = true;
              }
            });
          }

          perspectiveCamera.lookAt(playerPos.x, playerPos.y + 1.25, playerPos.z);
        } else {
          perspectiveCamera.position.set(playerPos.x, playerPos.y + 1.25, playerPos.z);
          
          // Calculate target looking point based on yaw and pitch
          const targetX = playerPos.x + Math.sin(yaw) * Math.cos(pitch);
          const targetY = playerPos.y + 1.25 + Math.sin(pitch);
          const targetZ = playerPos.z + Math.cos(yaw) * Math.cos(pitch);

          perspectiveCamera.lookAt(targetX, targetY, targetZ);
        }
      } else {
        // Exiting First Person — re-assign OrthographicCamera
        if (orthographicCamera) {
          window.gameRenderer.camera = orthographicCamera;
        }

        // Exit Pointer Lock if active
        if (document.pointerLockElement === renderer.domElement) {
          document.exitPointerLock?.();
        }

        // Restore character mesh visibility when zooming back out
        if (initializedMouseLookOffset) {
          const playerChar = (window as any).world?.getPlayer();
          if (playerChar && playerChar.mesh) {
            playerChar.mesh.visible = true;
            // Fully restore opacity
            playerChar.mesh.traverse((child: any) => {
              if (child instanceof THREE.Mesh && child.material) {
                child.material.opacity = 1.0;
                child.material.needsUpdate = true;
              }
            });
          }
          initializedMouseLookOffset = false;
        }

        // Restore locked cinematic isometric elevated three-quarter view
        if (orthographicCamera) {
          orthographicCamera.position.set(22, 26, 22);
          orthographicCamera.lookAt(0, 0, 0);
          orthographicCamera.left = -7;
          orthographicCamera.right = 7;
          orthographicCamera.top = 7;
          orthographicCamera.bottom = -7;
        }
      }
      if (window.gameRenderer.camera) {
        window.gameRenderer.camera.updateProjectionMatrix();
      }
    }

    // Toggle pointer events and canvas overlays based on view layers
    if (this.overlay) {
      if (this.currentLevel > 2) {
        this.overlay.style.pointerEvents = 'auto'; // intercept clicks
        if (this.canvas) {
          this.canvas.style.pointerEvents = 'auto';
          this.canvas.style.display = 'block'; // Ensure canvas is visible for levels > 2
        }
        this.showSidebar(def);
      } else {
        this.overlay.style.pointerEvents = 'none'; // allow clicks to 3D world
        if (this.canvas) {
          this.canvas.style.pointerEvents = 'none';
          // Keep canvas displayed but transparent if blinking, otherwise hide / transparent
          if (!isBlinking) {
            this.canvas.style.display = 'none'; // Hide canvas of zoom layers when in room/FP (level <= 2)
          } else {
            this.canvas.style.display = 'block';
          }
        }
        const side = document.getElementById('zoom-sidebar');
        if (side) side.style.display = 'none';
      }
    }
  }

  private showSidebar(def: ZoomScaleDef) {
    const side = document.getElementById('zoom-sidebar');
    if (!side) return;

    side.style.display = 'flex';
    side.innerHTML = `
      <div>
        <span style="font-size:10px; color:rgba(212,168,75,0.5); text-transform:uppercase; display:block;">Active Level</span>
        <span style="font-size:14px; font-weight:800; color:#F0C060;">${def.name}</span>
      </div>
      <div>
        <p style="font-size:11px; line-height:1.4; color:rgba(212,168,75,0.8); margin:0;">${def.description}</p>
      </div>

      <div style="border-top: 1px solid rgba(212,168,75,0.12); padding-top:10px; margin-top:5px; font-size:11px;">
        <span style="font-size:10px; color:rgba(212,168,75,0.5); text-transform:uppercase; margin-bottom:4px; display:block;">Multiplier Specifications</span>
        <div style="display:flex; justify-content:space-between; background:rgba(0,212,255,0.05); padding:6px 10px; border-radius:4px;">
          <span>Hyperfuel Multiplier:</span>
          <span style="color:#00e676; font-weight:bold;">${def.fuelCostMultiplier}x</span>
        </div>
      </div>

      <div id="sector-details-box" style="display:none; border-top:1px solid rgba(212,168,75,0.18); padding-top:10px; display:flex; flex-direction:column; gap:6px;">
        <span style="font-size:10px; color:rgba(212,168,75,0.5); text-transform:uppercase;">Space-Scan Details</span>
        <div style="background:rgba(212,168,75,0.05); border:1px solid rgba(212,168,75,0.1); border-radius:6px; padding:10px; display:flex; flex-direction:column; gap:4px;">
          <span id="target-body-name" style="font-size:13px; font-weight:bold; color:#00d4ff;">--</span>
          <span id="target-body-type" style="font-size:11px; color:#F0C060;">--</span>
          <div style="display:flex; justify-content:space-between; font-size:10px; border-top:1px solid rgba(212,168,75,0.1); padding-top:5px; margin-top:4px;">
            <span>Fuel Overhead:</span>
            <span id="target-body-fuel" style="color:#ff1744; font-weight:bold;">-- LY</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:10px;">
            <span>Estimated travel:</span>
            <span id="target-body-eta" style="color:#00e676;">-- ticks</span>
          </div>
        </div>
      </div>
    `;
    
    this.selectedSectorBody = null;
  }

  private selectSectorBody(item: any) {
    this.selectedSectorBody = item;
    const bodyBox = document.getElementById('sector-details-box');
    const nameEl = document.getElementById('target-body-name');
    const typeEl = document.getElementById('target-body-type');
    const fuelEl = document.getElementById('target-body-fuel');
    const etaEl = document.getElementById('target-body-eta');

    if (bodyBox && nameEl && typeEl && fuelEl && etaEl) {
      bodyBox.style.display = 'flex';
      nameEl.textContent = item.name;
      typeEl.textContent = `${item.type} · ${item.ext}`;
      fuelEl.textContent = `${item.fuel} Helium-3`;
      etaEl.textContent = `${item.eta} sim-ticks`;
    }
  }

  public tick() {
    // 1. Advance First-Person Camera Trajectory (Y=1.25)
    if (isTransitioningFirstPerson) {
      transitionProgress += 0.035; // smooth increment rate
      if (transitionProgress >= 1.0) {
        transitionProgress = 1.0;
        isTransitioningFirstPerson = false;
        
        // Final hide of local character mesh upon arrival
        const playerChar = (window as any).world?.getPlayer();
        if (playerChar && playerChar.mesh) {
          playerChar.mesh.visible = false;
        }
      }
      this.updateViewContext();
    } else if (this.currentLevel === 1) {
      // Force continuous rendering updates in first person so mouse look remains fluid
      this.updateViewContext();
    }

    // 2. Process Eyelid Blink Animation (on Zooming Out)
    if (isBlinking) {
      blinkProgress += 0.05; // blink speed
      if (blinkProgress >= 1.0) {
        isBlinking = false;
        blinkProgress = 0.0;
      } else if (blinkProgress >= 0.5 && pendingZoomOutAction) {
        // At mid-blink (eyes fully closed), execute the actual camera swap zoom out instantly!
        pendingZoomOutAction = false;
        this.currentLevel++;
        this.updateViewContext();
      }
      this.renderBlinkOverlay();
    }

    if (this.currentLevel <= 2 || !this.canvas || !this.ctx) return;
    this.render();
  }

  private renderBlinkOverlay() {
    // We render the eyelid blink using a dedicated absolute canvas covering the screen fully
    if (!this.canvas || !this.ctx) return;
    const canvas = this.canvas;
    const ctx = this.ctx;

    // Use a temporary overlay style update if we are on Level 1 or 2 (which normally pass-through pointer-events)
    if (this.overlay) {
      this.overlay.style.pointerEvents = 'none';
      if (this.canvas) this.canvas.style.pointerEvents = 'none';
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate vertical height of top and bottom eyelids based on blink progress
    // Eyelids fully meet at center (y = height/2) when progress = 0.5
    const halfH = canvas.height / 2;
    let multiplier = 0.0;

    if (blinkProgress <= 0.5) {
      // Closing: 0.0 -> 1.0 multiplier
      multiplier = blinkProgress / 0.5;
    } else {
      // Opening: 1.0 -> 0.0 multiplier
      multiplier = 1.0 - ((blinkProgress - 0.5) / 0.5);
    }

    const eyelidHeight = halfH * multiplier;

    ctx.fillStyle = '#01020a'; // warm space void tone black
    
    // Top eyelid
    ctx.fillRect(0, 0, canvas.width, eyelidHeight);
    
    // Bottom eyelid
    ctx.fillRect(0, canvas.height - eyelidHeight, canvas.width, eyelidHeight);

    // Subtle blur border highlight of the eyelids (Organic eye skin warm shadow)
    ctx.fillStyle = 'rgba(212, 168, 75, 0.05)';
    ctx.fillRect(0, eyelidHeight, canvas.width, 2);
    ctx.fillRect(0, canvas.height - eyelidHeight - 2, canvas.width, 2);
  }

  private render() {
    const canvas = this.canvas!;
    const ctx = this.ctx!;
    const def = ZOOM_LEVELS[this.currentLevel - 1];

    // Clear opaque grey background for scan interface
    ctx.fillStyle = 'rgba(7, 11, 28, 0.95)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw deep stars seed background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    for (const s of this.starsSeed) {
      ctx.beginPath();
      ctx.arc(s.x * canvas.width, s.y * canvas.height, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Grid representation (Lightly rendered coordinated grid layout) ──
    ctx.strokeStyle = def.gridColor;
    ctx.lineWidth = 1;
    const spacing = 40;
    for (let x = 0; x < canvas.width; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += spacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Draw circular scanner lines
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.strokeStyle = def.gridColor;
    ctx.setLineDash([5, 5]);
    for (let r = 80; r < canvas.width; r += 120) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Draw level-specific 3D-shaded vector structures
    this.drawLeveledStructures(ctx, cx, cy);
  }

  private drawLeveledStructures(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    switch (this.currentLevel) {
      case 3: // OUTSIDE ROOM (Module expansions & Docking corridors)
        ctx.strokeStyle = '#d84315';
        ctx.fillStyle = 'rgba(216, 67, 21, 0.15)';
        ctx.lineWidth = 2;
        
        // Draw square Lobby capsule
        ctx.strokeRect(cx - 50, cy - 50, 100, 100);
        ctx.fillRect(cx - 50, cy - 50, 100, 100);
        
        // Connected module pipelines
        ctx.beginPath();
        ctx.moveTo(cx - 50, cy); ctx.lineTo(cx - 110, cy);
        ctx.moveTo(cx + 50, cy); ctx.lineTo(cx + 110, cy);
        ctx.moveTo(cx, cy - 50); ctx.lineTo(cx, cy - 110);
        ctx.stroke();
        
        // Connected nodes
        ctx.beginPath();
        ctx.arc(cx - 120, cy, 10, 0, Math.PI * 2);
        ctx.arc(cx + 120, cy, 10, 0, Math.PI * 2);
        ctx.arc(cx, cy - 120, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();

        ctx.fillStyle = '#ff3d00';
        ctx.font = '10px monospace';
        ctx.fillText('LOBBY CAPSULE', cx, cy - 5);
        ctx.fillText('SOLAR MODULE', cx, cy - 138);
        break;

      case 4: // H-SHAPED SPACE STATION
        ctx.strokeStyle = '#00e676';
        ctx.fillStyle = 'rgba(0, 230, 118, 0.12)';
        ctx.lineWidth = 2;

        // Draw H-shape frame
        ctx.beginPath();
        // Left Verticle Module line
        ctx.moveTo(cx - 80, cy - 100); ctx.lineTo(cx - 80, cy + 100);
        // Right Verticle Module line
        ctx.moveTo(cx + 80, cy - 100); ctx.lineTo(cx + 80, cy + 100);
        // Central connecting corridor
        ctx.moveTo(cx - 80, cy); ctx.lineTo(cx + 80, cy);
        ctx.stroke();

        // Draw modular nodes
        const nodes = [
          {x: cx - 80, y: cy - 100}, {x: cx - 80, y: cy + 100},
          {x: cx + 80, y: cy - 100}, {x: cx + 80, y: cy + 100},
          {x: cx, y: cy} // center lobby
        ];
        for (const n of nodes) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fill();
        }

        // Draw solar panels
        ctx.fillStyle = 'rgba(0, 212, 255, 0.4)';
        ctx.fillRect(cx - 150, cy - 80, 50, 20);
        ctx.fillRect(cx + 100, cy - 80, 50, 20);

        ctx.fillStyle = '#00e676';
        ctx.font = '10px monospace';
        ctx.fillText('FUEL DECK', cx - 110, cy + 120);
        ctx.fillText('HABITATION DECK', cx + 110, cy + 120);
        break;

      case 5: // PLANET ORBITAL
        ctx.strokeStyle = '#ffb300';
        ctx.fillStyle = 'rgba(255, 179, 0, 0.1)';
        ctx.lineWidth = 1;

        // Draw Planet Sovereign at screen center
        ctx.beginPath();
        ctx.arc(cx, cy, 60, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(13, 71, 161, 0.4)';
        ctx.fill();

        // Lagrange Points
        const pts = [
          { name: 'L4 APEX', x: cx + 140, y: cy - 80 },
          { name: 'L5 REFUGE', x: cx - 140, y: cy + 80 },
          { name: 'L1 DECK', x: cx, y: cy - 100 }
        ];

        for (const p of pts) {
          ctx.beginPath();
          ctx.strokeStyle = '#00e676';
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(0, 230, 118, 0.1)';
          ctx.fill();

          ctx.fillStyle = '#ffb300';
          ctx.font = '9px "SF Mono"';
          ctx.fillText(p.name, p.x, p.y + 18);
        }
        break;

      case 6: // SOLAR SYSTEM (OpenTTD-style)
      case 7: // GALAXY ARM
      case 8: // UNIVERSE VIEW
        // Draw interactive sector bodies
        for (const item of this.sectorBodies) {
          // Highlight selected
          if (this.selectedSectorBody && this.selectedSectorBody.id === item.id) {
            ctx.beginPath();
            ctx.strokeStyle = '#00d4ff';
            ctx.arc(item.x, item.y, 16, 0, Math.PI * 2);
            ctx.stroke();
          }

          ctx.beginPath();
          ctx.fillStyle = item.id === 'world-sovereign' ? '#0d47a1' : '#d84315';
          ctx.arc(item.x, item.y, 10, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#ffe082';
          ctx.stroke();

          ctx.fillStyle = '#ffe082';
          ctx.font = '9px monospace';
          ctx.fillText(item.name, item.x, item.y + 22);
        }
        break;
    }
  }
}
