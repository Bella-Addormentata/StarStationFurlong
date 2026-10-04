/**
 * 🗺️ Station atlas on the holotable (#192) — the drawing and the clicks.
 *
 * Opened from the solar plot's station card (VIEW STATION ATLAS), it covers
 * the plot with a top-down plan of that station: every module the atlas
 * knows (stationPlan.ts), a faint tile grid like the room editor's, the
 * gangways between modules, and docked ships at their gates. Clicking a
 * module shows its card — size, owner, connections, gates — and a ship's
 * card says where it is docked. The side panel lists the ships at or near
 * the station from the planet's shared summary.
 *
 * Editing reuses the door panels rather than copying them: in the room you
 * stand in, each door has an OPEN DOOR PANEL button, which steps back from
 * the table and opens that door's own panel (provision a new module, fit or
 * remove a vestibule, undock). Another module of the station you stand in
 * has a BEAM INTO button when this install holds a pass to it: the ACCESS
 * beam takes you in, where its own door panels do the editing (editAccess),
 * so the table reaches no room the ACCESS app couldn't. A module whose door
 * back no walk-through has paired yet waits for that first walk. 🔧 Taking
 * a module apart is a robot job set at a charging dock (disassembly.ts): the
 * plan shows each job's progress, and a module joined to your room says what
 * it would take.
 *
 * All text from the atlas and the summaries is peer-written: it reaches the
 * page through textContent only.
 */

import type { StationRecord } from './stations';
import type { AtlasEntry } from './stationAtlas';
import type { ShipSummary } from './planetSummary';
import type { PlanModule, StationPlan, VisitingShip } from './stationPlan';
import { editAccess, moduleCorners, planModuleAt, stationPlan, visitingShips } from './stationPlan';
import { TILE_SIZE } from './floorPlanDoc';
import { legacyOwnerMarker } from './roomOwner';
import type { DisassemblyCandidate, DisassemblyJob } from './disassembly';
import { jobFraction, jobStatusText, ownerIsMe } from './disassembly';

export interface StationPlanDeps {
  atlas: () => Record<string, AtlasEntry>;
  /** The room this client stands in. */
  currentRoomId: () => string;
  /** The local player's id (roomInfo.owner's vocabulary), to say "you". */
  playerId: () => string;
  /** The local identity key, which still says "you" for an owner back on a
   *  fresh player id (ownerIsMe). */
  identityPub: () => string;
  /** Every ship summary this client holds, retired ones included: a ship's
   *  own report anywhere (another planet, retired) can contradict a berth
   *  the atlas still draws here. visitingShips picks this station's. */
  ships: () => ShipSummary[];
  /** 🔧 The rooms taken apart (dismantledRoomIds), whose old ship summaries
   *  list no ship here. */
  dismantled?: () => ReadonlySet<string>;
  /** The current room's doors, for the edit buttons. */
  doors: () => Array<{ id: string; label: string }>;
  /** Step back from the table and open a door's own panel. */
  openDoorPanel: (doorId: string) => void;
  /** ✏️ Does this install hold a pass to that room (the ACCESS beam's)? */
  canBeamTo?: (roomId: string) => boolean;
  /** ✏️ Step back from the table and beam into that room, where its own
   *  door panels do the editing. */
  beamTo?: (roomId: string) => void;
  /** Leave the plan for the solar plot. */
  onBack: () => void;
  /** 🔧 The room you stand in: its disassembly jobs, and the modules joined
   *  to it that its robots could take apart. */
  disassembly?: () => { jobs: DisassemblyJob[]; candidates: DisassemblyCandidate[] };
}

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = 'rgba(212,168,75,0.5)';
const CYAN = '#00d4ff';
const SHIP = '#7fd7a8';
/** A full-width action button in the side panel. */
const ACTION_CSS = `margin-top:5px; width:100%; text-align:left; border-radius:6px; border:1px solid rgba(212,168,75,0.35); background:rgba(212,168,75,0.08); color:${GOLD}; padding:6px 8px; cursor:pointer; font-size:10px; font-family:inherit;`;

/** Short form of an owner id with no known name. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…` : id;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function heading(text: string): HTMLElement {
  return el('div', `font-size:10px; color:${DIM}; text-transform:uppercase; letter-spacing:1px; margin-top:10px;`, text);
}

function row(text: string, color = GOLD): HTMLElement {
  return el('div', `font-size:11px; color:${color}; line-height:1.5;`, text);
}

/** "in 3m" / "4m ago" for a summary time. */
function when(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  const span = Math.abs(s) < 90 ? `${Math.abs(s)}s`
    : Math.abs(s) < 5400 ? `${Math.round(Math.abs(s) / 60)}m`
      : `${Math.round(Math.abs(s) / 3600)}h`;
  return s >= 0 ? `in ${span}` : `${span} ago`;
}

/** How far from a module's centre a ray along (dx, dz) leaves its footprint. */
function exitDistance(m: PlanModule, dx: number, dz: number): number {
  const cos = Math.cos(m.rotY), sin = Math.sin(m.rotY);
  // Into the module's own frame (moduleContains' inverse rotation).
  const lx = Math.abs(dx * cos - dz * sin), lz = Math.abs(dx * sin + dz * cos);
  return Math.min(lx > 1e-9 ? m.halfX / lx : Infinity, lz > 1e-9 ? m.halfZ / lz : Infinity);
}

/** Where two connected modules meet: halfway across the gap between their
 *  facing walls, on the line joining their centres. */
function joinPoint(a: PlanModule, b: PlanModule): { x: number; z: number } {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return { x: a.x, z: a.z };
  const ux = dx / len, uz = dz / len;
  const ta = Math.min(exitDistance(a, ux, uz), len);
  const tb = Math.min(exitDistance(b, -ux, -uz), len - ta);
  const t = ta + (len - ta - tb) / 2;
  return { x: a.x + ux * t, z: a.z + uz * t };
}

export class StationPlanView {
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private title: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private shipList: HTMLElement | null = null;
  private moduleList: HTMLElement | null = null;
  /** What show() made inert, and where focus was before it. */
  private covered: HTMLElement[] = [];
  private returnFocus: HTMLElement | null = null;
  private station: StationRecord | null = null;
  private plan: StationPlan | null = null;
  private visiting: VisitingShip[] = [];
  /** 🔧 Open jobs by module, and what this room's robots could take apart. */
  private jobs = new Map<string, DisassemblyJob>();
  private candidates: DisassemblyCandidate[] = [];
  private selected: string | null = null;
  /** Plan → canvas: scale and the canvas point of the plan origin. */
  private view = { scale: 1, ox: 0, oy: 0 };

  constructor(private deps: StationPlanDeps) {}

  /** Build the overlay inside `host` (the holotable body), hidden. */
  mount(host: HTMLElement): void {
    if (this.root) {
      host.appendChild(this.root);
      return;
    }
    const root = el('div', `position:absolute; inset:0; display:none; flex-direction:row; background:rgba(3,6,18,0.97); color:${GOLD}; font-family:'SF Mono','Monaco','Consolas',monospace; z-index:2;`);
    root.id = 'station-plan-overlay';
    const area = el('div', 'flex:1; position:relative; overflow:hidden;');
    const canvas = el('canvas', 'display:block; width:100%; height:100%; cursor:pointer;');
    canvas.setAttribute('aria-hidden', 'true'); // the module list below carries the same choices
    area.appendChild(canvas);
    const hint = el('div', `position:absolute; bottom:18px; left:18px; font-size:10px; color:${DIM}; background:rgba(4,8,22,0.85); padding:5px 10px; border-radius:6px; border:1px solid rgba(212,168,75,0.18);`,
      'CLICK a module or ship for its card');
    area.appendChild(hint);

    const side = el('div', 'width:320px; height:100%; overflow-y:auto; padding:18px; box-sizing:border-box; border-left:2px solid rgba(212,168,75,0.18); background:rgba(4,8,22,0.9);');
    const top = el('div', 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:10px;');
    const title = el('span', `font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};`, '🗺 STATION ATLAS');
    const back = el('button', `background:rgba(212,168,75,0.1); color:${GOLD}; border:1px solid rgba(212,168,75,0.3); border-radius:6px; padding:4px 10px; cursor:pointer; font-size:11px;`, '◀ SYSTEM');
    back.id = 'station-plan-back';
    back.addEventListener('click', () => this.deps.onBack());
    top.append(title, back);
    const card = el('div', 'display:flex; flex-direction:column;');
    const shipList = el('div', 'display:flex; flex-direction:column;');
    // The canvas is the picture; this list is the same selection as buttons,
    // reachable by keyboard and named for screen readers.
    const moduleList = el('div', 'display:flex; flex-direction:column;');
    moduleList.setAttribute('role', 'group');
    moduleList.setAttribute('aria-label', 'Modules and ships on the plan');
    side.append(top, card, shipList, moduleList);
    root.append(area, side);
    host.appendChild(root);

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (!this.plan) return;
      const x = (px - this.view.ox) / this.view.scale;
      const z = (py - this.view.oy) / this.view.scale;
      this.selected = planModuleAt(this.plan, x, z)?.roomId ?? null;
      this.render();
    });
    window.addEventListener('resize', () => { if (this.isOpen()) this.render(); });

    this.root = root;
    this.canvas = canvas;
    this.title = title;
    this.card = card;
    this.shipList = shipList;
    this.moduleList = moduleList;
  }

  isOpen(): boolean {
    return !!this.root && this.root.style.display !== 'none';
  }

  /** Open on a station: its welcome room roots the plan. The plot under
   *  it goes inert (no tabbing onto its hidden buttons) and focus moves to
   *  the plan's own controls, coming back where it was on hide. */
  show(station: StationRecord): void {
    if (!this.root) return;
    if (this.station?.id !== station.id) this.selected = null;
    this.station = station;
    const opening = !this.isOpen();
    this.root.style.display = 'flex';
    this.refresh();
    if (opening) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.covered = [...(this.root.parentElement?.children ?? [])]
        .filter((c): c is HTMLElement => c !== this.root && c instanceof HTMLElement && !c.inert);
      for (const c of this.covered) c.inert = true;
      this.root.querySelector<HTMLElement>('#station-plan-back')?.focus();
    }
  }

  hide(): void {
    if (!this.root || !this.isOpen()) return;
    this.root.style.display = 'none';
    for (const c of this.covered) c.inert = false;
    this.covered = [];
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  /** Re-read the atlas and the ships (the atlas or a summary changed). */
  refresh(station: StationRecord | null = this.station): void {
    if (!station || !this.isOpen()) return;
    this.station = station;
    const here = this.deps.currentRoomId();
    this.plan = stationPlan(this.deps.atlas(), station.welcomeRoomId, here);
    this.visiting = visitingShips(this.plan, this.deps.ships(), station.welcomeRoomId, this.deps.dismantled?.());
    const dis = this.deps.disassembly?.() ?? { jobs: [], candidates: [] };
    this.jobs = new Map(dis.jobs.filter((j) => j.finishedAt === undefined).map((j) => [j.roomId, j]));
    this.candidates = dis.candidates;
    if (this.selected && !this.findModule(this.selected)) this.selected = null;
    this.render();
  }

  /** The station the plan is open on, or null when it is closed. */
  openStationId(): string | null {
    return this.isOpen() ? this.station?.id ?? null : null;
  }

  /** The plan currently drawn (tests and console poking). */
  currentPlan(): StationPlan | null {
    return this.plan;
  }

  private findModule(roomId: string): PlanModule | null {
    if (!this.plan) return null;
    return [...this.plan.modules, ...this.plan.ships].find((m) => m.roomId === roomId) ?? null;
  }

  private nameOf(roomId: string): string {
    return this.findModule(roomId)?.name ?? 'Module';
  }

  private render(): void {
    if (!this.title || !this.station) return;
    this.title.textContent = `🗺 ${this.station.name}`;
    // The side panel is rebuilt below: remember which of its buttons held
    // focus and give it back, so keyboard users keep their place.
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && this.root?.contains(active)
      ? (active.dataset.roomId !== undefined ? `[data-room-id="${CSS.escape(active.dataset.roomId)}"]`
        : active.dataset.doorId !== undefined ? `[data-door-id="${CSS.escape(active.dataset.doorId)}"]`
          : active.dataset.beamRoomId !== undefined ? `[data-beam-room-id="${CSS.escape(active.dataset.beamRoomId)}"]` : null)
      : null;
    this.drawCanvas();
    this.renderCard();
    this.renderShips();
    this.renderModuleList();
    if (keep) this.root?.querySelector<HTMLElement>(keep)?.focus();
  }

  private drawCanvas(): void {
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.fillStyle = '#020412';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const plan = this.plan;
    if (!plan || plan.modules.length === 0) {
      ctx.fillStyle = DIM;
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No layout known for this station yet.', canvas.width / 2, canvas.height / 2 - 8);
      ctx.fillText('Visit it, or dock at it, and its modules are mapped.', canvas.width / 2, canvas.height / 2 + 12);
      return;
    }

    // Fit the whole station with a margin.
    const pad = 40;
    const bw = Math.max(plan.bounds.maxX - plan.bounds.minX, 1);
    const bh = Math.max(plan.bounds.maxZ - plan.bounds.minZ, 1);
    const scale = Math.min((canvas.width - 2 * pad) / bw, (canvas.height - 2 * pad) / bh, 12);
    this.view = {
      scale,
      ox: canvas.width / 2 - ((plan.bounds.minX + plan.bounds.maxX) / 2) * scale,
      oy: canvas.height / 2 - ((plan.bounds.minZ + plan.bounds.maxZ) / 2) * scale,
    };
    const toPx = (x: number, z: number) => ({ x: this.view.ox + x * scale, y: this.view.oy + z * scale });

    // Connections first, under the modules: gangways solid, berths dashed.
    const centre = new Map([...plan.modules, ...plan.ships].map((m) => [m.roomId, m]));
    ctx.lineWidth = 3;
    for (const m of plan.modules) {
      for (const link of m.links) {
        const to = centre.get(link.toRoomId);
        if (!to) continue;
        const a = toPx(m.x, m.z), b = toPx(to.x, to.z);
        ctx.strokeStyle = link.berth ? 'rgba(127,215,168,0.6)' : 'rgba(212,168,75,0.45)';
        ctx.setLineDash(link.berth ? [6, 5] : []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Each connection's midpoint gets a marker over the modules, so flush
    // neighbours still show where they join.
    const joins: Array<{ x: number; y: number; berth: boolean }> = [];
    for (const m of plan.modules) {
      for (const link of m.links) {
        const to = centre.get(link.toRoomId);
        if (!to || (to.kind === 'module' && to.roomId < m.roomId)) continue; // once per gangway
        const j = joinPoint(m, to);
        joins.push({ ...toPx(j.x, j.z), berth: link.berth });
      }
    }

    // Ships whose own word still says docked here, at the berth drawn; any
    // other berth is stale.
    const listed = new Set(this.visiting.filter((s) => s.state === 'docked' && s.onPlan).map((s) => s.roomId));
    for (const m of [...plan.modules, ...plan.ships]) {
      const corners = moduleCorners(m).map((c) => toPx(c.x, c.z));
      const isShip = m.kind === 'ship';
      // A berth the ship itself says it left is drawn faint.
      const stale = isShip && !listed.has(m.roomId);
      const selected = m.roomId === this.selected;
      ctx.beginPath();
      corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.fillStyle = '#070b18'; // opaque under the tint: links pass beneath
      ctx.fill();
      ctx.fillStyle = isShip
        ? (stale ? 'rgba(127,215,168,0.05)' : 'rgba(127,215,168,0.16)')
        : m.here ? 'rgba(0,212,255,0.16)' : 'rgba(212,168,75,0.10)';
      ctx.fill();

      // The room editor's tile grid, faint, for modules whose size is known.
      if (m.dims && scale * TILE_SIZE >= 8) {
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(212,168,75,0.12)';
        ctx.lineWidth = 1;
        const cos = Math.cos(m.rotY), sin = Math.sin(m.rotY);
        const pt = (lx: number, lz: number) => toPx(m.x + lx * cos + lz * sin, m.z - lx * sin + lz * cos);
        for (let c = 1; c < m.dims.cols; c++) {
          const lx = -m.halfX + c * TILE_SIZE;
          const a = pt(lx, -m.halfZ), b = pt(lx, m.halfZ);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        for (let r = 1; r < m.dims.rows; r++) {
          const lz = -m.halfZ + r * TILE_SIZE;
          const a = pt(-m.halfX, lz), b = pt(m.halfX, lz);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.restore();
      }

      ctx.beginPath();
      corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.setLineDash(m.dims || isShip ? [] : [4, 3]); // dashed: size not known
      ctx.strokeStyle = selected ? GOLD_BRIGHT : isShip ? (stale ? 'rgba(127,215,168,0.35)' : SHIP) : m.here ? CYAN : GOLD;
      ctx.stroke();
      ctx.setLineDash([]);

      const c = toPx(m.x, m.z);
      // 🔧 Being taken apart: hatched, with how far the robots have got.
      const job = isShip ? undefined : this.jobs.get(m.roomId);
      if (job) {
        ctx.save();
        ctx.beginPath();
        corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,138,80,0.22)';
        ctx.lineWidth = 2;
        const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        for (let x = x0 - (y1 - y0); x < x1; x += 10) {
          ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x + (y1 - y0), y0); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = selected ? GOLD_BRIGHT : isShip ? SHIP : m.here ? CYAN : GOLD;
      ctx.font = `bold ${Math.max(9, Math.min(13, scale * 1.6))}px monospace`;
      ctx.fillText((isShip ? '🚀 ' : '') + m.name, c.x, c.y + 4);
      if (m.here) {
        ctx.font = '9px monospace';
        ctx.fillText('YOU ARE HERE', c.x, c.y + 18);
      }
      if (job) {
        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = '#ff8a50';
        ctx.fillText(`🔧 ${Math.floor(jobFraction(job, Date.now()) * 100)}%`, c.x, c.y + (m.here ? 32 : 18));
      }
    }
    for (const j of joins) {
      ctx.beginPath();
      ctx.arc(j.x, j.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = j.berth ? SHIP : GOLD;
      ctx.fill();
    }
  }

  private ownerText(m: PlanModule): string {
    if (m.owner === undefined) return 'Owner not known yet (someone must stand in it once).';
    // null, or the pre-S2 marker: no verifiable owner (roomOwner.ts).
    if (m.owner === null || legacyOwnerMarker(m.owner.id)) return 'No verified owner';
    if (ownerIsMe(m.owner, { playerId: this.deps.playerId(), identityPub: this.deps.identityPub() })) return 'You';
    return m.owner.name ?? shortId(m.owner.id);
  }

  private renderCard(): void {
    const card = this.card;
    if (!card || !this.plan || !this.station) return;
    card.replaceChildren();
    const m = this.selected ? this.findModule(this.selected) : null;
    if (!m) {
      const count = this.plan.modules.length;
      card.append(
        heading('Station'),
        row(count === 0
          ? 'This install has not mapped the station yet.'
          : `${count} module${count === 1 ? '' : 's'} known · ${this.plan.ships.length} docked ship${this.plan.ships.length === 1 ? '' : 's'} on the plan`),
        row('Click a module to see its owner, size, connections and gates.', DIM),
      );
      return;
    }
    const isShip = m.kind === 'ship';
    card.append(
      heading(isShip ? 'Visiting ship' : 'Module'),
      el('div', `font-size:14px; font-weight:800; color:${isShip ? SHIP : GOLD_BRIGHT};`, m.name),
      heading('Owner'),
      row(this.ownerText(m), CYAN),
      heading('Size'),
      row(m.dims ? `${m.dims.cols} × ${m.dims.rows} tiles` : 'Not known yet (drawn at the default 2 × 2)'),
    );
    if (isShip) {
      if (m.dockedAt) {
        const gate = m.dockedAt.gate !== undefined ? `gate ${m.dockedAt.gate}` : 'a berth';
        card.append(heading('Docked'), row(`At ${gate} of ${this.nameOf(m.dockedAt.roomId)}`));
      }
      const v = this.visiting.find((s) => s.roomId === m.roomId);
      if (!v) card.append(row('Its own last report puts it elsewhere; this berth is out of date.', DIM));
      else if (v.state === 'docked' && !v.onPlan) {
        card.append(row(`It reports it is docked at ${v.gate !== undefined ? `gate ${v.gate}` : 'another berth'}; this berth is out of date.`, DIM));
      } else if (v.state !== 'docked') {
        card.append(row(`It reports it is ${v.state}; this berth may be out of date.`, DIM));
      }
      // Aboard this ship: its doors (undock among them) are yours to work.
      if (m.here) this.renderDoorButtons(card, m);
      return;
    }

    this.renderDisassembly(card, m);
    const links = m.links.filter((l) => !l.berth);
    card.append(heading('Connections'));
    if (links.length === 0) card.append(row('None known', DIM));
    for (const l of links) card.append(row(`↔ ${this.nameOf(l.toRoomId)}`));
    if (m.gates.length > 0) {
      card.append(heading('Gates'));
      for (const g of m.gates) {
        const ship = m.links.find((l) => l.doorId === g.doorId && l.berth);
        card.append(row(`Gate ${g.gate}: ${ship ? `🚀 ${this.nameOf(ship.toRoomId)}` : 'free'}`, ship ? SHIP : GOLD));
      }
    }

    // ✏️ Editing: the door panels of the room you stand in; another module
    // of the station, by the ACCESS beam with a pass this install holds.
    card.append(heading('Build and edit'));
    const access = editAccess(this.plan, m.roomId, (id) => this.deps.canBeamTo?.(id) ?? false);
    if (access === 'here') {
      this.renderDoorButtons(card, m);
      return;
    }
    if (access === 'beam') {
      card.append(row('Beam into this module to work on its doors from inside, as the ACCESS beam enters a room you hold a pass to.', DIM));
      const btn = el('button', ACTION_CSS, `✨ BEAM INTO ${m.name}`);
      btn.dataset.beamRoomId = m.roomId;
      btn.addEventListener('click', () => this.deps.beamTo?.(m.roomId));
      card.append(btn);
      return;
    }
    card.append(row(access === 'walk-first'
      ? "Walk to this module through the station's doors first: its door back is paired on the first walk-through, which a beam skips."
      : access === 'walk'
        ? 'Walk to this module to work on its doors: this install holds no pass to beam into it.'
        : 'Edit a module from a holotable inside the station.', DIM));
  }

  /** 🔧 A module being taken apart says how far along; one joined to your
   *  room says what it would take. */
  private renderDisassembly(card: HTMLElement, m: PlanModule): void {
    const job = this.jobs.get(m.roomId);
    const candidate = this.candidates.find((c) => c.roomId === m.roomId);
    if (job) {
      card.append(heading('Being taken apart'), row(jobStatusText(job, Date.now(), candidate?.blocked ?? null), '#ff8a50'));
    } else if (candidate) {
      card.append(
        heading('Take apart'),
        candidate.blocked
          ? row(`${candidate.laborHours} labor hours, but not now: ${candidate.blocked}.`, DIM)
          : row(`${candidate.laborHours} labor hours. Set a robot to it at a charging dock in your room: 🔧 Disassemble module.`, DIM),
      );
    }
  }

  /** ✏️ OPEN DOOR PANEL for each door of the room you stand in. */
  private renderDoorButtons(card: HTMLElement, m: PlanModule): void {
    if (m.kind === 'ship') card.append(heading('Build and edit'));
    card.append(row('Each door\'s panel can provision a new module, fit or remove a vestibule, or undock.', DIM));
    const doors = this.deps.doors();
    if (doors.length === 0) card.append(row('No doors in this room.', DIM));
    for (const d of doors) {
      const btn = el('button', ACTION_CSS);
      const link = m.links.find((l) => l.doorId === d.id);
      btn.textContent = `🚪 ${d.label}${link ? ` → ${this.nameOf(link.toRoomId)}` : ' (free)'} · OPEN DOOR PANEL`;
      btn.dataset.doorId = d.id;
      btn.addEventListener('click', () => this.deps.openDoorPanel(d.id));
      card.append(btn);
    }
  }

  private renderModuleList(): void {
    const list = this.moduleList;
    if (!list || !this.plan) return;
    list.replaceChildren();
    const all = [...this.plan.modules, ...this.plan.ships];
    if (all.length === 0) return;
    list.append(heading('On the plan'));
    for (const m of all) {
      const selected = m.roomId === this.selected;
      const btn = el('button', `margin-top:4px; width:100%; text-align:left; border-radius:6px; border:1px solid ${selected ? GOLD_BRIGHT : 'rgba(212,168,75,0.25)'}; background:rgba(212,168,75,${selected ? '0.16' : '0.05'}); color:${m.kind === 'ship' ? SHIP : m.here ? CYAN : GOLD}; padding:5px 8px; cursor:pointer; font-size:10px; font-family:inherit;`,
        `${m.kind === 'ship' ? '🚀' : '▣'} ${m.name}${m.here ? ' (you are here)' : ''}${
          this.jobs.has(m.roomId) ? ` · being taken apart, ${Math.floor(jobFraction(this.jobs.get(m.roomId)!, Date.now()) * 100)}%` : ''}`);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.dataset.roomId = m.roomId;
      btn.addEventListener('click', () => {
        this.selected = selected ? null : m.roomId;
        this.render();
      });
      list.append(btn);
    }
  }

  private renderShips(): void {
    const list = this.shipList;
    if (!list) return;
    list.replaceChildren(heading('Ships at or near the station'));
    if (this.visiting.length === 0) {
      list.append(row('None known', DIM));
      return;
    }
    const now = Date.now();
    // A ship drawn on the plan is picked from the list too, its berth there
    // out of date or not (its card says which).
    const drawn = new Set(this.plan?.ships.map((m) => m.roomId) ?? []);
    for (const s of this.visiting) {
      const where = s.state === 'docked'
        ? (s.gate !== undefined ? `docked at gate ${s.gate}` : 'docked')
        : s.state === 'arriving'
          // Past its arrival time (late, or arrived and still docking): when it was due.
          ? `arriving${s.at !== undefined ? (s.at >= now ? ` ${when(s.at, now)}` : `, due ${when(s.at, now)}`) : ''}`
          : `leaving${s.at !== undefined ? ` (${when(s.at, now)})` : ''}`;
      const item = el('div', `font-size:11px; line-height:1.5; color:${s.state === 'docked' ? SHIP : GOLD}; cursor:${drawn.has(s.roomId) ? 'pointer' : 'default'};`,
        `🚀 ${s.name} · ${where}${s.routeStatus ? ` · ${s.routeStatus.toUpperCase()}` : ''}`);
      if (drawn.has(s.roomId)) {
        item.addEventListener('click', () => {
          this.selected = s.roomId;
          this.render();
        });
      }
      list.append(item);
    }
  }
}
