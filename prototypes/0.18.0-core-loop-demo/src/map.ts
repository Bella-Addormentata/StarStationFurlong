/**
 * 🌠 Solar System Map - Phase 2 Core Feature 1 & 2
 *
 * Implements a lightweight, interactive 2D canvas overlay representing
 * the Solar System Map, showcasing Keplerian orbits, Lagrange points,
 * minable asteroid clusters, and a deterministic "derive-don't-tick"
 * long-distance travel system (v006 §8.2 / Phase 2 Feature 1 & 2).
 */

export interface MapBody {
  id: string;
  name: string;
  type: 'star' | 'planet' | 'asteroid-field' | 'station' | 'lagrange';
  parentId?: string; // e.g. planet parent for orbiters / Lagrange points
  orbitRadius: number; // distance from center or parent
  orbitSpeed: number; // angle increment per frame (radians)
  semiMajorAxis?: number;
  eccentricity?: number; // 0 = circular, >0 = elliptical
  angle: number; // current angle in radians
  description: string;
  resources?: { type: string; yield: number }[];
  lagrangePoint?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
}

export class SolarSystemMap {
  private container: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private bodies: MapBody[] = [];
  
  // Keplerian orbit / Sim Clock state
  private simTick = 0;
  
  // UI scaling / dragging offsets
  private scale = 1.0;
  private offsetX = 0;
  private offsetY = 0;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  
  // Selection / Travel tracking
  private selectedBody: MapBody | null = null;
  private playerLocationId = 'furlong-station';
  private travelDestination: MapBody | null = null;
  private departureTick = 0;
  private travelDurationTicks = 0; // calculated distance / speed ratio
  
  // Callbacks
  private onTravelCompleteCallback: ((destinationId: string) => void) | null = null;

  constructor() {
    this.initializeBodies();
  }

  private initializeBodies() {
    this.bodies = [
      {
        id: 'star-sol',
        name: 'SOL PRIME',
        type: 'star',
        orbitRadius: 0,
        orbitSpeed: 0,
        angle: 0,
        description: 'Spectral class G2V star. Core fusion power source for Furlong Sector.',
      },
      {
        id: 'planet-aris',
        name: 'ARIS PRIME',
        type: 'planet',
        orbitRadius: 100,
        orbitSpeed: 0.002,
        angle: 0.5,
        description: 'Lava-rich dense inner planet. Rich in heavy iron ore pockets.',
        resources: [{ type: 'Iron Ore', yield: 800 }],
      },
      {
        id: 'planet-sovereign',
        name: 'SOVEREIGN II',
        type: 'planet',
        orbitRadius: 180,
        orbitSpeed: 0.0012,
        semiMajorAxis: 180,
        eccentricity: 0.15, // Elliptical Orbit
        angle: 1.2,
        description: 'Carbon-silica rich terra planet holding Furlong System main station.',
        resources: [{ type: 'Silica', yield: 1200 }],
      },
      {
        id: 'furlong-station',
        name: 'FURLONG LOBBY STATION',
        type: 'station',
        parentId: 'planet-sovereign',
        orbitRadius: 35, // Distance from parent Planet Sovereign
        orbitSpeed: 0.015,
        angle: 2.1,
        description: 'Sovereign-serverless terminal, lounge, and trade hub for all clones.',
      },
      {
        id: 'lagrange-l4',
        name: 'SOVEREIGN L4 APEX',
        type: 'lagrange',
        parentId: 'planet-sovereign',
        orbitRadius: 180,
        orbitSpeed: 0.0012, // Co-orbital with parent
        angle: 1.2 + (Math.PI / 3.0), // 60 degrees ahead (stable Lagrange L4)
        lagrangePoint: 'L4',
        description: 'Gravitationally stable Lagrange co-orbital pocket. Ideal for modular outposts.',
      },
      {
        id: 'lagrange-l5',
        name: 'SOVEREIGN L5 REFUGE',
        type: 'lagrange',
        parentId: 'planet-sovereign',
        orbitRadius: 180,
        orbitSpeed: 0.0012, // Co-orbital
        angle: 1.2 - (Math.PI / 3.0), // 60 degrees behind (stable Lagrange L5)
        lagrangePoint: 'L5',
        description: 'Stable Lagrange refuge pocket. Uncharted asteroid debris.',
        resources: [{ type: 'Rare Mineral', yield: 250 }],
      },
      {
        id: 'belt-ring',
        name: 'THE SILENT RING',
        type: 'asteroid-field',
        orbitRadius: 280,
        orbitSpeed: 0.0006,
        angle: 3.4,
        description: 'Massive dense debris ring populated with minable node clusters.',
        resources: [
          { type: 'Iron Ore', yield: 2500 },
          { type: 'Silica', yield: 1500 },
          { type: 'Rare Mineral', yield: 450 },
        ],
      },
    ];
  }

  public mount(parentEl: HTMLElement) {
    // 1. Create HTML Elements
    this.container = document.createElement('div');
    this.container.id = 'solarmap-overlay';
    this.container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(3, 6, 18, 0.95);
      z-index: 4000;
      display: none;
      flex-direction: row;
      color: #d4a84b;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      box-sizing: border-box;
      user-select: none;
    `;

    const mapArea = document.createElement('div');
    mapArea.style.cssText = `
      flex: 1;
      height: 100%;
      position: relative;
      overflow: hidden;
      cursor: grab;
    `;

    this.canvas = document.createElement('canvas');
    this.canvas.width = window.innerWidth * 0.70;
    this.canvas.height = window.innerHeight;
    this.canvas.style.display = 'block';
    mapArea.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Dragging instruction bar
    const hint = document.createElement('div');
    hint.textContent = '🖱 DRAG to pan · 🎡 SCROLL to zoom · CLICK body to select';
    hint.style.cssText = `
      position: absolute;
      bottom: 24px;
      left: 24px;
      font-size: 11px;
      color: rgba(212, 168, 75, 0.55);
      background: rgba(4, 8, 22, 0.85);
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid rgba(212, 168, 75, 0.18);
    `;
    mapArea.appendChild(hint);

    // 2. Info Sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'solarmap-sidebar';
    sidebar.style.cssText = `
      width: 320px;
      height: 100%;
      background: rgba(4, 8, 22, 0.90);
      border-left: 2px solid rgba(212, 168, 75, 0.18);
      padding: 24px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      backdrop-filter: blur(20px);
    `;

    sidebar.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(212, 168, 75, 0.18); padding-bottom: 14px; margin-bottom: 20px;">
        <span style="font-size: 14px; font-weight: 800; letter-spacing: 1px; color: #F0C060;">🌌 ORBITAL COOMMS</span>
        <button id="solarmap-close-btn" style="background: rgba(212,168,75,0.1); color: #d4a84b; border: 1px solid rgba(212,168,75,0.3); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size:11px;">CLOSE</button>
      </div>

      <div style="flex: 1; display: flex; flex-direction: column; gap: 16px;">
        <!-- Player Coordinates -->
        <div>
          <span style="font-size: 10px; color: rgba(212,168,75,0.5); display:block; text-transform:uppercase;">Player Location</span>
          <span id="map-player-loc" style="font-size: 13px; font-weight: bold; color: #00d4ff;">Furlong Lobby Station</span>
        </div>

        <div id="map-selection-details" style="display:none; flex-direction: column; gap: 14px; border-top: 1px solid rgba(212, 168, 75, 0.12); padding-top: 14px;">
          <div>
            <span style="font-size: 10px; color: rgba(212,168,75,0.5); display:block; text-transform:uppercase;">Selected Space</span>
            <span id="map-selected-name" style="font-size: 15px; font-weight: bold; color: #F0C060;">--</span>
          </div>
          <div>
            <span style="font-size: 10px; color: rgba(212,168,75,0.5); display:block; text-transform:uppercase;">Classification</span>
            <span id="map-selected-type" style="font-size: 11px; color: #00d4ff;">--</span>
          </div>
          <div>
            <p id="map-selected-desc" style="font-size: 11px; line-height: 1.4; color: rgba(212,168,75,0.8); margin: 0;"></p>
          </div>
          <div id="map-selected-resources-box" style="display:none;">
            <span style="font-size: 10px; color: rgba(212,168,75,0.5); display:block; text-transform:uppercase; margin-bottom: 4px;">Minable Node Clusters</span>
            <div id="map-selected-resources-list" style="font-size: 11px; display:flex; flex-direction:column; gap:3px;"></div>
          </div>
          
          <!-- Launch Travel Trigger -->
          <button id="map-travel-btn" style="width: 100%; border-radius: 8px; border: 1px solid #1e88e5; background: rgba(30,136,229,0.15); color: #90caf9; font-weight: bold; padding: 10px; cursor: pointer; text-transform: uppercase; font-size:11px; transition: background 0.2s;">Initiate Travel</button>
        </div>
      </div>

      <!-- Traveling Status Tracker overlay -->
      <div id="map-traveling-panel" style="display:none; flex-direction: column; gap:10px; border-top: 1px solid rgba(212, 168, 75, 0.18); padding-top: 14px;">
        <span style="font-size: 11px; color: #00e676; font-weight:800; animation: pulse 2s infinite;">🛸 CLONE FREIGHT TRANSIT ACTIVE</span>
        <div style="background: rgba(0,0,0,0.4); border-radius:6px; height: 18px; width: 100%; overflow:hidden; border: 1px solid rgba(212,168,75,0.18); position:relative; box-sizing:border-box;">
          <div id="map-travel-progressbar" style="background:#00e676; height:100%; width:0%; transition: width 0.1s linear;"></div>
          <span id="map-travel-percent" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:10px; color:#fff; font-weight:bold;">0%</span>
        </div>
        <span id="map-transit-details" style="font-size:10px; color:rgba(212,168,75,0.6);">Cruising speed: 1.4 AU/tick</span>
      </div>
    `;

    this.container.appendChild(mapArea);
    this.container.appendChild(sidebar);
    parentEl.appendChild(this.container);

    // Bind event listeners
    this.setupListeners();
  }

  private setupListeners() {
    if (!this.canvas || !this.container) return;

    // Pan & zoom handlers
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX - this.offsetX;
      this.dragStartY = e.clientY - this.offsetY;
      this.canvas!.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.offsetX = e.clientX - this.dragStartX;
      this.offsetY = e.clientY - this.dragStartY;
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      if (this.canvas) this.canvas.style.cursor = 'grab';
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = 1.05;
      if (e.deltaY < 0) {
        this.scale = Math.min(this.scale * zoomFactor, 3.0);
      } else {
        this.scale = Math.max(this.scale / zoomFactor, 0.4);
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas!.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      this.handleCanvasClick(clickX, clickY);
    });

    // Close Button binding
    const closeBtn = document.getElementById('solarmap-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // Travel Button trigger
    const travelBtn = document.getElementById('map-travel-btn');
    if (travelBtn) {
      travelBtn.addEventListener('click', () => this.initiateLongDistanceTravel());
    }

    // Keyboard support: resize responsive layout
    window.addEventListener('resize', () => {
      if (this.canvas) {
        this.canvas.width = window.innerWidth * 0.70;
        this.canvas.height = window.innerHeight;
      }
    });
  }

  private handleCanvasClick(clickX: number, clickY: number) {
    if (!this.canvas) return;

    const centerX = this.canvas.width / 2 + this.offsetX;
    const centerY = this.canvas.height / 2 + this.offsetY;

    // Detect clickable target bodies
    for (const body of this.bodies) {
      const coords = this.getBodyCoordinates(body, centerX, centerY);
      
      const dist = Math.hypot(coords.x - clickX, coords.y - clickY);
      // Let's afford a tolerant 15-pixel clickable target bounds
      if (dist <= 15 * this.scale) {
        this.selectBody(body);
        return;
      }
    }
  }

  private getBodyCoordinates(body: MapBody, centerX: number, centerY: number): { x: number; y: number } {
    if (body.type === 'star') {
      return { x: centerX, y: centerY };
    }

    // Base orbit positions (derive-don't-tick, v006 §8.2 / Kepler orbits)
    let radius = body.orbitRadius * this.scale;
    let angle = body.angle;

    // Simulate orbital movement as a function of the simulation clock tick
    angle += body.orbitSpeed * this.simTick;

    if (body.parentId) {
      const parent = this.bodies.find(b => b.id === body.parentId);
      if (parent) {
        const parentCoords = this.getBodyCoordinates(parent, centerX, centerY);
        return {
          x: parentCoords.x + Math.cos(angle) * radius,
          y: parentCoords.y + Math.sin(angle) * radius,
        };
      }
    }

    // Elliptical adjustments if eccentricity is configured
    if (body.eccentricity && body.semiMajorAxis) {
      const a = body.semiMajorAxis * this.scale;
      const b = a * Math.sqrt(1.0 - Math.pow(body.eccentricity, 2.0));
      // Ellipse focuses on Sol Prime center
      return {
        x: centerX + Math.cos(angle) * a - (a * body.eccentricity),
        y: centerY + Math.sin(angle) * b,
      };
    }

    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  }

  private selectBody(body: MapBody) {
    this.selectedBody = body;

    const panel = document.getElementById('map-selection-details');
    const nameEl = document.getElementById('map-selected-name');
    const typeEl = document.getElementById('map-selected-type');
    const descEl = document.getElementById('map-selected-desc');
    const resBox = document.getElementById('map-selected-resources-box');
    const resList = document.getElementById('map-selected-resources-list');
    const travelBtn = document.getElementById('map-travel-btn');

    if (panel && nameEl && typeEl && descEl && resBox && resList && travelBtn) {
      panel.style.display = 'flex';
      nameEl.textContent = body.name;
      typeEl.textContent = body.type.toUpperCase();
      descEl.textContent = body.description;

      // Handle resource listings
      if (body.resources && body.resources.length > 0) {
        resBox.style.display = 'block';
        resList.innerHTML = body.resources.map(r => `
          <div style="display:flex; justify-content:space-between; background:rgba(212,168,75,0.05); padding: 4px 8px; border-radius:4px; border: 1px solid rgba(212,168,75,0.1);">
            <span style="color:rgba(212,168,75,0.85);">${r.type}</span>
            <span style="color:#00e676; font-weight:800;">${r.yield} TN</span>
          </div>
        `).join('');
      } else {
        resBox.style.display = 'none';
      }

      // Configure Travel actions
      if (body.id === this.playerLocationId) {
        travelBtn.textContent = 'YOU ARE HERE';
        (travelBtn as HTMLButtonElement).disabled = true;
        travelBtn.style.borderColor = 'rgba(212,168,75,0.3)';
        travelBtn.style.background = 'rgba(212,168,75,0.05)';
        travelBtn.style.color = 'rgba(212,168,75,0.3)';
      } else if (this.travelDestination) {
        travelBtn.textContent = 'IN TRANSIT...';
        (travelBtn as HTMLButtonElement).disabled = true;
        travelBtn.style.borderColor = 'rgba(230,0,118,0.3)';
        travelBtn.style.background = 'rgba(230,0,118,0.05)';
        travelBtn.style.color = 'rgba(230,0,118,0.3)';
      } else {
        travelBtn.textContent = `TRAVEL TO ${body.name}`;
        (travelBtn as HTMLButtonElement).disabled = false;
        travelBtn.style.borderColor = '#1e88e5';
        travelBtn.style.background = 'rgba(30,136,229,0.15)';
        travelBtn.style.color = '#90caf9';
      }
    }
  }

  private initiateLongDistanceTravel() {
    if (!this.selectedBody || this.selectedBody.id === this.playerLocationId || this.travelDestination) return;

    this.travelDestination = this.selectedBody;
    this.departureTick = this.simTick;

    // Compute travel duration based on direct orbital distance (Determine progress, v006 §8.2)
    const travelBtn = document.getElementById('map-travel-btn');
    if (travelBtn) {
      travelBtn.textContent = 'IN TRANSIT...';
      (travelBtn as HTMLButtonElement).disabled = true;
    }

    // Mock progress ratio: longer distances = longer duration, scaled deterministically
    const currentLoc = this.bodies.find(b => b.id === this.playerLocationId);
    let dist = 100;
    if (currentLoc) {
      dist = Math.abs(currentLoc.orbitRadius - this.travelDestination.orbitRadius) + 40;
    }
    this.travelDurationTicks = Math.max(Math.round(dist / 3.0), 30); // minimum 30 ticks for transit

    const travelPanel = document.getElementById('map-traveling-panel');
    if (travelPanel) {
      travelPanel.style.display = 'flex';
    }

    this.logToHUD(`Transit initiated: Travel to ${this.travelDestination.name} launched...`);
  }

  public tick() {
    this.simTick++;
    this.render();
    this.updateTravelProgress();
  }

  private updateTravelProgress() {
    if (!this.travelDestination) return;

    const ticksElapsed = this.simTick - this.departureTick;
    const progress = Math.min((ticksElapsed / this.travelDurationTicks) * 100, 100);

    const bar = document.getElementById('map-travel-progressbar');
    const percent = document.getElementById('map-travel-percent');
    
    if (bar) bar.style.width = `${progress}%`;
    if (percent) percent.textContent = `${Math.round(progress)}%`;

    if (ticksElapsed >= this.travelDurationTicks) {
      const destinationId = this.travelDestination.id;
      const destinationName = this.travelDestination.name;

      this.playerLocationId = destinationId;
      this.travelDestination = null;

      const playerLocEl = document.getElementById('map-player-loc');
      if (playerLocEl) playerLocEl.textContent = destinationName;

      const travelPanel = document.getElementById('map-traveling-panel');
      if (travelPanel) travelPanel.style.display = 'none';

      this.logToHUD(`🛰️ Arrival: Clone freight successfully dropped in orbit of ${destinationName}!`);

      if (this.selectedBody) {
        this.selectBody(this.selectedBody);
      }

      if (this.onTravelCompleteCallback) {
        this.onTravelCompleteCallback(destinationId);
      }
    }
  }

  private render() {
    if (!this.canvas || !this.ctx) return;

    const canvas = this.canvas;
    const ctx = this.ctx;

    // Clear background
    ctx.fillStyle = '#020412';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2 + this.offsetX;
    const centerY = canvas.height / 2 + this.offsetY;

    // Draw solar grid/stars background
    ctx.strokeStyle = 'rgba(212, 168, 75, 0.03)';
    ctx.lineWidth = 1;
    const gridSpacing = 50 * this.scale;
    for (let x = centerX % gridSpacing; x < canvas.width; x += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = centerY % gridSpacing; y < canvas.height; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // 1. Draw Kepler orbits
    for (const body of this.bodies) {
      if (body.type === 'star' || body.parentId) continue;

      ctx.beginPath();
      ctx.strokeStyle = body.id === 'belt-ring' ? 'rgba(212, 168, 75, 0.1)' : 'rgba(212, 168, 75, 0.08)';
      ctx.setLineDash(body.id === 'belt-ring' ? [2, 5] : [4, 4]);
      ctx.lineWidth = body.id === 'belt-ring' ? 2 * this.scale : 1;

      if (body.eccentricity && body.semiMajorAxis) {
        // Draw ellipse
        const a = body.semiMajorAxis * this.scale;
        const b = a * Math.sqrt(1.0 - Math.pow(body.eccentricity, 2.0));
        ctx.ellipse(centerX - (a * body.eccentricity), centerY, a, b, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(centerX, centerY, body.orbitRadius * this.scale, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw connecting travel line if transit is active
    if (this.travelDestination) {
      const currentLoc = this.bodies.find(b => b.id === this.playerLocationId);
      if (currentLoc) {
        const coordsFrom = this.getBodyCoordinates(currentLoc, centerX, centerY);
        const coordsTo = this.getBodyCoordinates(this.travelDestination, centerX, centerY);

        ctx.beginPath();
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.moveTo(coordsFrom.x, coordsFrom.y);
        ctx.lineTo(coordsTo.x, coordsTo.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 2. Render astronomical bodies
    for (const body of this.bodies) {
      const coords = this.getBodyCoordinates(body, centerX, centerY);

      // Handle click feedback rings
      if (this.selectedBody && this.selectedBody.id === body.id) {
        ctx.beginPath();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 1.5;
        ctx.arc(coords.x, coords.y, (12 + Math.sin(this.simTick * 0.08) * 2) * this.scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Draw standard nodes
      ctx.beginPath();
      matchBodyStyle(body, ctx, coords, this.scale);
      
      // Node Labels
      if (this.scale >= 0.70 || body.type === 'planet' || body.type === 'star') {
        const textYOffset = body.type === 'star' ? 24 : 16;
        ctx.fillStyle = this.playerLocationId === body.id ? '#00e676' : 'rgba(212, 168, 75, 0.75)';
        ctx.font = '9px "SF Mono", monospace';
        ctx.textAlign = 'center';
        
        const labelText = this.playerLocationId === body.id ? `🛸 [${body.name}]` : body.name;
        ctx.fillText(labelText, coords.x, coords.y + textYOffset * this.scale);
      }
    }
  }

  private logToHUD(msg: string) {
    const feedback = document.getElementById('network-link-feedback');
    if (feedback) {
      feedback.textContent = msg;
    }
    console.log(msg);
  }

  public getBootRecord(): any {
    const net = (window as any).networkProvider;
    return net ? net.getBootRecord() : null;
  }

  public getIrohNodeId(): string | undefined {
    const boot = this.getBootRecord();
    return boot ? boot.irohNodeId : undefined;
  }

  public show() {
    if (this.container) {
      this.container.style.display = 'flex';
      this.render();
    }
  }

  public hide() {
    if (this.container) {
      this.container.style.display = 'none';
    }
  }

  public onTravelComplete(cb: (destinationId: string) => void) {
    this.onTravelCompleteCallback = cb;
  }
}

function matchBodyStyle(body: MapBody, ctx: CanvasRenderingContext2D, coords: { x: number; y: number }, scale: number) {
  switch (body.type) {
    case 'star':
      ctx.fillStyle = '#ffb300';
      ctx.shadowColor = '#ffe082';
      ctx.shadowBlur = 40;
      ctx.arc(coords.x, coords.y, 16 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0; // reset shadow glows
      break;
    case 'planet':
      ctx.fillStyle = body.id === 'planet-aris' ? '#d84315' : '#0d47a1';
      ctx.arc(coords.x, coords.y, 8 * scale, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'station':
      ctx.fillStyle = '#00d4ff';
      ctx.arc(coords.x, coords.y, 4 * scale, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'lagrange':
      ctx.fillStyle = 'rgba(0, 230, 118, 0.25)';
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 1;
      ctx.arc(coords.x, coords.y, 4 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      break;
    case 'asteroid-field':
      ctx.fillStyle = '#4e342e';
      ctx.arc(coords.x, coords.y, 6 * scale, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
}
