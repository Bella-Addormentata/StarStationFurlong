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

  private zoomIn() {
    if (this.currentLevel > 1) {
      this.currentLevel--;
      this.updateViewContext();
    }
  }

  private zoomOut() {
    if (this.currentLevel < 8) {
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
    const { camera } = window.gameRenderer;
    if (camera) {
      if (this.currentLevel === 1) {
        // First Person: push orthographic bounds much tighter
        camera.left = -3.5;
        camera.right = 3.5;
        camera.top = 3;
        camera.bottom = -3;
      } else {
        // Standard room zoom levels
        camera.left = -7;
        camera.right = 7;
        camera.top = 7;
        camera.bottom = -7;
      }
      camera.updateProjectionMatrix();
    }

    // Toggle pointer events and canvas overlays based on view layers
    if (this.overlay) {
      if (this.currentLevel > 2) {
        this.overlay.style.pointerEvents = 'auto'; // intercept clicks
        if (this.canvas) this.canvas.style.pointerEvents = 'auto';
        this.showSidebar(def);
      } else {
        this.overlay.style.pointerEvents = 'none'; // allow clicks to 3D world
        if (this.canvas) this.canvas.style.pointerEvents = 'none';
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
    if (this.currentLevel <= 2 || !this.canvas || !this.ctx) return;
    this.render();
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
