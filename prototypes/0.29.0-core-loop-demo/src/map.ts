/**
 * 🌠 Solar System Map - Phase 2 Core Feature 1 & 2
 *
 * Implements a lightweight, interactive 2D canvas overlay representing
 * the Solar System Map, showcasing Keplerian orbits, Lagrange points,
 * minable asteroid clusters, and a deterministic "derive-don't-tick"
 * long-distance travel system (v006 §8.2 / Phase 2 Feature 1 & 2).
 */

import { DEFAULT_STATION_ID, currentStation, listStations } from './stations';
import type { StationRecord } from './stations';
import { angleAt, realMsFor, stationOrbit } from './orbits';
import { AU_KM, planetSunOrbit, sunAngleAt } from './solarOrbits';
import { describeMove, moveTransitPointAt } from './stationMove';
import type { StationMove } from './stations';

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
  /** 🪐 When set, the body's true angle at a real time (orbits.ts) — replaces
   *  angle + orbitSpeed·tick, so every client draws it in the same place. */
  angleAt?: (nowMs: number) => number;
  /** 🚚 When set, the body's whole place at a real time — which body it goes
   *  round (none: the sun) and where. A station moving between planets
   *  (stationMove.ts) leaves its planet for the sun and joins another. */
  placeAt?: (nowMs: number) => { parentId?: string; angle: number; radius: number };
  description: string;
  resources?: { type: string; yield: number }[];
  lagrangePoint?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
}

/** Map radius of orbit slot 0 around a planet, and the step per slot. The
 *  holotable draws orbits SCHEMATICALLY (true to scale, every low station
 *  would sit on the planet's rim); the ANGLE is the true one. */
const STATION_ORBIT_BASE = 35;
const STATION_ORBIT_STEP = 9;

/**
 * Canvas offset of a body at `angle` on a circle of `radius`. The holotable
 * looks down from the NORTH, like the orbits.ts planet frame: +X to the
 * right, −Z up the screen — so every orbit goes round counter-clockwise.
 */
export function screenOffset(angle: number, radius: number): { dx: number; dy: number } {
  return { dx: Math.cos(angle) * radius, dy: -Math.sin(angle) * radius };
}

/** "1m 32s" / "3h 54m" — a real-time span for the holotable readout. */
function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * 🪐 One map body per station, on its circular orbit around its planet
 * (stations.ts for the slot, orbits.ts for the mechanics). The angle comes
 * from the shared orbital clock; slot 0 starts where the single hard-coded
 * Furlong body always stood.
 */
export function stationBodies(stations: StationRecord[], nowMs: number = Date.now()): MapBody[] {
  return stations.map((s) => {
    const orbit = stationOrbit(s);
    const readout = `${Math.round(orbit.altitudeKm).toLocaleString('en-US')} km up · ${orbit.speedKmS.toFixed(2)} km/s · `
      + `one orbit every ${formatSpan((orbit.periodS / 60) * 1000)}.`;
    const moving = s.move ? ` ${describeMove(s.move, nowMs)}` : '';
    return {
      id: s.id,
      name: s.name,
      type: 'station' as const,
      parentId: orbit.planet.id,
      orbitRadius: STATION_ORBIT_BASE + s.orbitSlot * STATION_ORBIT_STEP,
      orbitSpeed: 0,
      angle: orbit.phase0,
      angleAt: (nowMs: number) => angleAt(orbit, nowMs),
      ...(s.move ? { placeAt: movingPlace(s, s.move) } : {}),
      description: (s.id === DEFAULT_STATION_ID
        ? `Sovereign-serverless terminal, lounge, and trade hub for all clones. ${readout}`
        : `Station around ${orbit.planet.name}: ${readout}`) + moving,
    };
  });
}

/** Holotable radius of a sun-centred distance: the planets' schematic scale
 *  (Sovereign II, at 1 AU, is drawn at 180). */
const MAP_PER_AU = 180;

/** Where a moving station is drawn: around its old planet until the burn,
 *  on its course around the sun (the transfer ellipse, or a tug's straight
 *  torch run), then around its new planet. */
function movingPlace(s: StationRecord, move: StationMove): NonNullable<MapBody['placeAt']> {
  const from = stationOrbit({ planetId: move.fromPlanetId, orbitSlot: move.fromSlot });
  const to = stationOrbit({ planetId: move.toPlanetId, orbitSlot: move.toSlot });
  const slotRadius = (slot: number) => STATION_ORBIT_BASE + slot * STATION_ORBIT_STEP;
  return (nowMs: number) => {
    const p = moveTransitPointAt(move, nowMs);
    if (p) return { angle: p.angle, radius: (p.radiusKm / AU_KM) * MAP_PER_AU };
    if (nowMs >= move.arriveAt) return { parentId: to.planet.id, angle: angleAt(to, nowMs), radius: slotRadius(move.toSlot) };
    return { parentId: from.planet.id, angle: angleAt(from, nowMs), radius: slotRadius(s.orbitSlot) };
  };
}

/** ☀️ A planet's true angle around the sun on the shared clock
 *  (solarOrbits.ts). The holotable keeps its schematic distances. */
function planetAngleAt(planetId: string): (nowMs: number) => number {
  const orbit = planetSunOrbit(planetId);
  return (nowMs: number) => sunAngleAt(orbit, nowMs);
}

/** "One year every 6d 02h" — a planet's real-time year for the readout. */
function yearReadout(planetId: string): string {
  const ms = realMsFor(planetSunOrbit(planetId).periodS);
  const h = Math.round(ms / 3_600_000);
  return `One year every ${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h.`;
}

export class SolarSystemMap {
  private container: HTMLDivElement | null = null;
  private mapArea: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private bodies: MapBody[] = [];
  
  // Keplerian orbit / Sim Clock state
  private simTick = 0;
  /** Real clock for bodies with a true orbit (angleAt). */
  private clock: () => number = () => Date.now();
  
  // UI scaling / dragging offsets
  private scale = 1.0;
  private offsetX = 0;
  private offsetY = 0;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  
  // Selection / Travel tracking
  private selectedBody: MapBody | null = null;
  private playerLocationId = DEFAULT_STATION_ID;
  private travelDestination: MapBody | null = null;
  private departureTick = 0;
  private travelDurationTicks = 0; // calculated distance / speed ratio
  
  // Callbacks
  private onTravelCompleteCallback: ((destinationId: string) => void) | null = null;

  constructor() {
    this.initializeBodies();
  }

  private initializeBodies() {
    const sovereignAngle = planetAngleAt('planet-sovereign');
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
        orbitSpeed: 0,
        angle: 0.5,
        angleAt: planetAngleAt('planet-aris'),
        description: `Lava-rich dense inner planet. Rich in heavy iron ore pockets. ${yearReadout('planet-aris')}`,
        resources: [{ type: 'Iron Ore', yield: 800 }],
      },
      {
        id: 'planet-sovereign',
        name: 'SOVEREIGN II',
        type: 'planet',
        orbitRadius: 180,
        orbitSpeed: 0,
        angle: 1.2,
        angleAt: sovereignAngle,
        description: `Carbon-silica rich terra planet holding Furlong System main station. ${yearReadout('planet-sovereign')}`,
        resources: [{ type: 'Silica', yield: 1200 }],
      },
      ...stationBodies(listStations()),
      {
        id: 'lagrange-l4',
        name: 'SOVEREIGN L4 APEX',
        type: 'lagrange',
        orbitRadius: 180, // On Sovereign's orbit around the sun
        orbitSpeed: 0,
        angle: 1.2 + (Math.PI / 3.0), // 60 degrees ahead (stable Lagrange L4)
        angleAt: (nowMs: number) => sovereignAngle(nowMs) + Math.PI / 3,
        lagrangePoint: 'L4',
        description: 'Gravitationally stable Lagrange co-orbital pocket. Ideal for modular outposts.',
      },
      {
        id: 'lagrange-l5',
        name: 'SOVEREIGN L5 REFUGE',
        type: 'lagrange',
        orbitRadius: 180, // On Sovereign's orbit around the sun
        orbitSpeed: 0,
        angle: 1.2 - (Math.PI / 3.0), // 60 degrees behind (stable Lagrange L5)
        angleAt: (nowMs: number) => sovereignAngle(nowMs) - Math.PI / 3,
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
    // Re-mount into a new parent (M4: the map-table focused UI rebuilds its
    // panel per focus session but reuses ONE SolarSystemMap — moving the
    // container keeps canvas, listeners, selection and travel state intact).
    if (this.container) {
      parentEl.appendChild(this.container);
      return;
    }

    // 1. Create HTML Elements
    this.container = document.createElement('div');
    this.container.id = 'solarmap-overlay';
    // Fills its PARENT (#33 M4 re-parameterization): mounted into the map
    // table's focus panel it fills the panel body; mounted on document.body
    // (the pre-M4 standalone overlay path, kept mountable) it fills the view.
    this.container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(3, 6, 18, 0.95);
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
    this.mapArea = mapArea;

    this.canvas = document.createElement('canvas');
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

    // Resize responsive layout — re-measure the PARENT, not the window
    // (#33 M4: the canvas fills whatever host the map is mounted into).
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  /**
   * Size the canvas backing store from its parent map area (#33 M4). Only
   * meaningful while visible — a display:none container measures 0×0, so the
   * caller (show / window resize) is responsible for timing; zero dims are
   * skipped to avoid wiping a valid canvas.
   */
  private resizeCanvas() {
    if (!this.canvas || !this.mapArea) return;
    const w = this.mapArea.clientWidth;
    const h = this.mapArea.clientHeight;
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
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

    if (body.placeAt) {
      const place = body.placeAt(this.clock());
      const parent = place.parentId ? this.bodies.find((b) => b.id === place.parentId) : undefined;
      const origin = parent ? this.getBodyCoordinates(parent, centerX, centerY) : { x: centerX, y: centerY };
      const { dx, dy } = screenOffset(place.angle, place.radius * this.scale);
      return { x: origin.x + dx, y: origin.y + dy };
    }

    // Base orbit positions (derive-don't-tick, v006 §8.2 / Kepler orbits)
    let radius = body.orbitRadius * this.scale;
    let angle = body.angle;

    // Simulate orbital movement as a function of the simulation clock tick —
    // or, for planets, stations and Lagrange points, the true angle on the
    // shared orbital clock.
    angle = body.angleAt ? body.angleAt(this.clock()) : angle + body.orbitSpeed * this.simTick;

    if (body.parentId) {
      const parent = this.bodies.find(b => b.id === body.parentId);
      if (parent) {
        const parentCoords = this.getBodyCoordinates(parent, centerX, centerY);
        const { dx, dy } = screenOffset(angle, radius);
        return { x: parentCoords.x + dx, y: parentCoords.y + dy };
      }
    }

    // Elliptical adjustments if eccentricity is configured
    if (body.eccentricity && body.semiMajorAxis) {
      const a = body.semiMajorAxis * this.scale;
      const b = a * Math.sqrt(1.0 - Math.pow(body.eccentricity, 2.0));
      // Ellipse focuses on Sol Prime center
      return {
        x: centerX + Math.cos(angle) * a - (a * body.eccentricity),
        y: centerY - Math.sin(angle) * b, // north-up, as screenOffset
      };
    }

    const { dx, dy } = screenOffset(angle, radius);
    return { x: centerX + dx, y: centerY + dy };
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
      // Lagrange points ride Sovereign's own orbit: no ring of their own.
      if (body.type === 'star' || body.type === 'lagrange' || body.parentId) continue;

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

  /**
   * Re-read the station list (stations.ts) and mark the station the player is
   * standing in. Called each time the holotable opens, so stations learned
   * since the last look appear. A mock transit in progress keeps its own
   * location until it lands.
   */
  public refreshStations(
    stations: StationRecord[] = listStations(),
    current: StationRecord | null = currentStation(),
  ) {
    this.bodies = [...this.bodies.filter((b) => b.type !== 'station'), ...stationBodies(stations)];
    // A transit under way follows its destination's refreshed body, or is
    // called off when that station is gone (it could never land).
    if (this.travelDestination) {
      const dest = this.bodies.find((b) => b.id === this.travelDestination!.id);
      if (dest) {
        this.travelDestination = dest;
      } else {
        this.travelDestination = null;
        if (this.container) {
          const travelPanel = document.getElementById('map-traveling-panel');
          if (travelPanel) travelPanel.style.display = 'none';
        }
      }
    }
    // Location FIRST: the selection repaint below reads it for the travel
    // button ("YOU ARE HERE" belongs to the station we are in now). A room no
    // listed station holds (not in the atlas yet) is somewhere unknown, never
    // the last station shown or Furlong by default.
    if (!this.travelDestination) {
      this.playerLocationId = current?.id ?? '';
      if (this.container) {
        const playerLocEl = document.getElementById('map-player-loc');
        if (playerLocEl) playerLocEl.textContent = current?.name ?? 'UNKNOWN';
      }
    }
    // Rebind the selection to the refreshed body (a station may have been
    // renamed or moved since); drop it, and hide its details, when the
    // station is gone.
    const had = this.selectedBody;
    const fresh = had && this.bodies.find((b) => b.id === had.id);
    this.selectedBody = fresh || null;
    if (this.container) {
      if (fresh) {
        this.selectBody(fresh);
      } else if (had) {
        const panel = document.getElementById('map-selection-details');
        if (panel) panel.style.display = 'none';
      }
    }
  }

  /** The station bodies now on the map, planet by planet (test/debug view). */
  public stationIds(): string[] {
    return this.bodies.filter((b) => b.type === 'station').map((b) => b.id);
  }

  public getPlayerLocationId(): string {
    return this.playerLocationId;
  }

  public show() {
    if (this.container) {
      this.container.style.display = 'flex';
      // Measure AFTER display:flex — a hidden container has zero layout.
      this.resizeCanvas();
      this.render();
    }
  }

  /** True while the map is mounted and visible (gates tick — #33 M4). */
  public isOpen(): boolean {
    return !!this.container && this.container.style.display !== 'none';
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
