/**
 * 🛰️ The helm's STATION KEEPING face (owner request, 2026-09-27) — what a
 * helm console shows in a module bolted into a station
 * (stationKeeping.isBoltedIntoStation). A ship's helm flies the ship; this
 * one flies the station, with a small TRIM STICK for fine orbital
 * maintenance:
 *
 *   ▲ RAISE / ▼ LOWER — one burn moves the orbit TRIM_STEP_KM,
 *   ◀ BACK / AHEAD ▶  — one burn slides the station PHASE_STEP_DEG along it.
 *
 * Flick the stick (drag the knob past its ring and let go), press a button,
 * or focus the stick and use the arrow keys. Each is ONE discrete burn
 * (stationKeeping.planTrim); everything else on the dashboard is derived
 * from the room's burns and the clock.
 *
 * The STATION KEEPING BOX draws the station against its slot: the crosshair
 * is where the slot's orbit puts it, across is along the orbit (behind /
 * ahead) and up is altitude. A lower orbit is a faster one, so the marker
 * slides; the ghost ring shows where it will be in ten minutes.
 *
 * Thrusters and propellant are the ship parts the module already carries:
 * ENGINE BLOCKs fire the burns and FUEL TANKs feed them (the shipDoc fuel
 * gauge). The FUEL & DOCKING tab is the ship helm face itself (devices.ts
 * createHelmUI), whose REFUEL and DOCKING COMPUTER serve a station module as
 * well — nothing the helm did before is lost.
 *
 * MOVE TO ANOTHER PLANET (stationMove.ts) sits under the stick: for each other
 * planet, the next launch window, the flight time and the propellant both
 * burns take; MOVE schedules the whole transfer in one write. While a move is
 * scheduled or under way the stick holds still.
 */

import type { DeviceUI } from './devices';
import { subscribeDoors } from './doorsDoc';
import { FURNITURE, FURNITURE_DEFS } from './furniture';
import { subscribeFurniture } from './furnitureDoc';
import { realMsFor } from './orbits';
import type { CircularOrbit } from './orbits';
import { TANK_CAPACITY, clampFuelToCapacity, fuelDrawDeficit, readFuelLevel, subscribeShip } from './shipDoc';
import { subscribePlanetSummary } from './planetSummary';
import type { StationRecord } from './stations';
import {
  MAX_TRIM_KM,
  PHASE_STEP_DEG,
  TRIM_DIRECTIONS,
  TRIM_FUEL,
  TRIM_STEP_KM,
  describeDrift,
  describeOffset,
  describeRefusal,
  describeTrimStatus,
  isBurnLogFull,
  planTrim,
  readBurnFiring,
  readOrbitTrim,
  slotDriftPerHour,
  slotOffsetAt,
  slotOrbit,
  subscribeStationKeeping,
  trimFor,
  trimmedOrbit,
  writeTrimBurn,
} from './stationKeeping';
import type { FiredBurn, OrbitTrim, TrimContext, TrimDirection, TrimRefusal } from './stationKeeping';
import { atlasComponent, readAtlas } from './stationAtlas';
import {
  describeMove,
  describeMoveRefusal,
  formatLongSpan,
  isMoveActive,
  otherPlanets,
  planStationMove,
  quoteMove,
  readMoveFuelDrawn,
  subscribeStationMove,
  writeStationMove,
} from './stationMove';
import type { MoveContext } from './stationMove';
import { listStations, planetById } from './stations';

const DEG = Math.PI / 180;

// ── Commander seam (main.ts funnels the room-owner predicate in) ─────────────

let commanderCheck: (() => boolean) | null = null;

/** Who may fly the station from this helm: the same room-owner predicate the
 *  ship helm uses (main.ts isHelmCommander). Unset ⇒ nobody — the stick
 *  fails closed. */
export function setStationHelmCommanderCheck(cb: (() => boolean) | null): void {
  commanderCheck = cb;
}

function isCommander(): boolean {
  return commanderCheck?.() === true;
}

function countFunction(tag: string): number {
  return FURNITURE.filter((i) => FURNITURE_DEFS[i.kind]?.functions?.includes(tag)).length;
}

// ── Shared look (the ship helm's palette) ────────────────────────────────────

const GOLD = '#d4a84b';
const GOLD_DIM = 'rgba(212,168,75,0.75)';
const AMBER = '#FFB300';
const GREEN = '#00E676';
const WARN = '#FFB74D';

/** The refusals that disable the whole stick (as opposed to one direction). */
const STICK_REFUSALS: readonly TrimRefusal[] = ['not-bolted', 'no-station', 'not-commander', 'no-thrusters', 'no-fuel', 'log-full'];

/** "1m 32s" / "3h 54m" — a real-time span. */
function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── The station keeping box (canvas) ─────────────────────────────────────────

/** Canvas pixels per CSS pixel (the box is drawn at 2× for sharp text). */
const CANVAS_SCALE = 2;
/** The box spans this far along the orbit either side of the slot. */
const BOX_PHASE_DEG = 5;
/** The ghost ring: where the drift puts the station this far ahead. */
const GHOST_MINUTES = 10;

const PUSH: Record<TrimDirection, { x: number; y: number }> = {
  raise: { x: 0, y: -1 },
  lower: { x: 0, y: 1 },
  ahead: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
};

function drawKeepingBox(
  canvas: HTMLCanvasElement,
  view: { base: CircularOrbit; trim: OrbitTrim | null; planet: string } | null,
  now: number,
  firing: FiredBurn | null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const s = CANVAS_SCALE;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#030A10';
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2 - 4 * s;
  const halfW = W / 2 - 16 * s;
  const halfH = H / 2 - 22 * s;
  const xOf = (deg: number) => cx + (deg / BOX_PHASE_DEG) * halfW;
  const yOf = (km: number) => cy - (km / MAX_TRIM_KM) * halfH;

  // Grid: a line per degree along the orbit, per 5 km of altitude.
  ctx.lineWidth = 1 * s;
  ctx.strokeStyle = 'rgba(30,136,168,0.18)';
  ctx.beginPath();
  for (let d = -BOX_PHASE_DEG; d <= BOX_PHASE_DEG; d++) {
    ctx.moveTo(xOf(d), yOf(MAX_TRIM_KM));
    ctx.lineTo(xOf(d), yOf(-MAX_TRIM_KM));
  }
  for (let km = -MAX_TRIM_KM; km <= MAX_TRIM_KM; km += 5) {
    ctx.moveTo(xOf(-BOX_PHASE_DEG), yOf(km));
    ctx.lineTo(xOf(BOX_PHASE_DEG), yOf(km));
  }
  ctx.stroke();
  // The slot: the crosshair every burn is measured from.
  ctx.strokeStyle = 'rgba(0,229,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(xOf(-BOX_PHASE_DEG), cy);
  ctx.lineTo(xOf(BOX_PHASE_DEG), cy);
  ctx.moveTo(cx, yOf(MAX_TRIM_KM));
  ctx.lineTo(cx, yOf(-MAX_TRIM_KM));
  ctx.stroke();

  ctx.font = `${8 * s}px monospace`;
  ctx.fillStyle = 'rgba(212,168,75,0.6)';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillText(`HIGHER +${MAX_TRIM_KM} km`, cx, 3 * s);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`▼ ${view?.planet ?? 'PLANET'} · LOWER`, cx, H - 3 * s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('◀', 3 * s, cy);
  ctx.textAlign = 'right';
  ctx.fillText('▶', W - 3 * s, cy);
  ctx.fillStyle = 'rgba(0,229,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('SLOT', cx + 3 * s, cy + 2 * s);

  if (!view) return;
  const offsetDeg = slotOffsetAt(view.base, view.trim, now) / DEG;
  const dR = view.trim?.dRadiusKm ?? 0;
  const clampX = (deg: number) => Math.max(xOf(-BOX_PHASE_DEG), Math.min(xOf(BOX_PHASE_DEG), xOf(deg)));
  const px = clampX(offsetDeg);
  const py = yOf(dR);

  // Where the drift carries the station in the next ten minutes.
  const driftDeg = (slotDriftPerHour(view.base, view.trim) / DEG) * (GHOST_MINUTES / 60);
  if (Math.abs(driftDeg) > 0.01) {
    const gx = clampX(offsetDeg + driftDeg);
    ctx.strokeStyle = 'rgba(255,179,0,0.55)';
    ctx.setLineDash([3 * s, 3 * s]);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(gx, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(gx, py, 4 * s, 0, Math.PI * 2);
    ctx.stroke();
  }

  // A burn's exhaust, opposite the push.
  if (firing) {
    const push = PUSH[firing.dir];
    const flicker = 0.7 + 0.3 * Math.sin(now / 45);
    ctx.fillStyle = `rgba(255,138,64,${0.75 * flicker})`;
    ctx.beginPath();
    ctx.moveTo(px - push.x * 7 * s - push.y * 4 * s, py - push.y * 7 * s + push.x * 4 * s);
    ctx.lineTo(px - push.x * (18 + 6 * flicker) * s, py - push.y * (18 + 6 * flicker) * s);
    ctx.lineTo(px - push.x * 7 * s + push.y * 4 * s, py - push.y * 7 * s - push.x * 4 * s);
    ctx.closePath();
    ctx.fill();
  }

  // The station: a hull with two panel wings.
  ctx.fillStyle = AMBER;
  ctx.fillRect(px - 4 * s, py - 4 * s, 8 * s, 8 * s);
  ctx.fillStyle = 'rgba(100,181,246,0.9)';
  ctx.fillRect(px - 13 * s, py - 2 * s, 7 * s, 4 * s);
  ctx.fillRect(px + 6 * s, py - 2 * s, 7 * s, 4 * s);

  // Off the box: say how far, at the edge it went out of.
  if (Math.abs(offsetDeg) > BOX_PHASE_DEG) {
    ctx.fillStyle = WARN;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = offsetDeg > 0 ? 'right' : 'left';
    ctx.fillText(`${Math.abs(offsetDeg).toFixed(1)}° ${offsetDeg > 0 ? 'AHEAD ▶' : '◀ BEHIND'}`, offsetDeg > 0 ? W - 14 * s : 14 * s, py - 7 * s);
  }
}

// ── The face ─────────────────────────────────────────────────────────────────

export interface StationHelmDeps {
  /** Is the module still bolted into a station — read at every refresh and
   *  every burn, since a peer can take the gangway down while this is open
   *  (stationKeeping.isBoltedIntoStation over the live door records). */
  bolted: () => boolean;
  /** The station this module belongs to (stations.currentStation). */
  station: () => StationRecord | null;
  /** The ship helm face, mounted by the FUEL & DOCKING tab. */
  shipFace: () => DeviceUI;
}

/** How far the knob travels in its well (CSS px), and how far a flick must
 *  go to fire. */
const KNOB_TRAVEL = 24;
const FLICK_AT = 0.55;
/** A refusal the stick just met stays on the status line this long. */
const FLASH_MS = 2_500;
/** Text rows refresh at this rate while mounted (the drift moves slowly). */
const TEXT_REFRESH_S = 0.5;

const ARROW_KEYS: Record<string, TrimDirection> = {
  ArrowUp: 'raise',
  ArrowDown: 'lower',
  ArrowRight: 'ahead',
  ArrowLeft: 'back',
};

/** Which way a flick of (dx, dy) screen px points — the longer axis wins. */
function flickDirection(dx: number, dy: number): TrimDirection | null {
  if (Math.hypot(dx, dy) < KNOB_TRAVEL * FLICK_AT) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'ahead' : 'back';
  return dy < 0 ? 'raise' : 'lower';
}

export function createStationHelmUI(deps: StationHelmDeps): DeviceUI {
  let host: HTMLElement | null = null;
  let panel: HTMLDivElement | null = null;
  let face: 'keep' | 'ship' = 'keep';
  let ship: DeviceUI | null = null;
  let back: HTMLButtonElement | null = null;
  const unsubs: Array<() => void> = [];

  // What the dashboard last read (refresh), and what the box draws each frame.
  let view: { station: StationRecord; base: CircularOrbit; trim: OrbitTrim | null; planet: string } | null = null;
  let flash: { text: string; until: number } | null = null;
  let moveFlash: { text: string; until: number } | null = null;
  let sinceText = 0;
  let drag: { id: number; cx: number; cy: number; dx: number; dy: number } | null = null;

  const q = <T extends HTMLElement>(sel: string): T | null => panel?.querySelector<T>(sel) ?? null;
  const setText = (sel: string, html: string) => {
    const el = q(sel);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  const check = (ok: boolean) => ok ? `<span style="color:${GREEN};">✔</span>` : '<span style="color:#FF8A80;">✗</span>';

  /** Everything a burn decision reads, fresh. */
  const readContext = (): TrimContext & { station: StationRecord | null; tanks: number; capacity: number } => {
    const tanks = countFunction('fuelTank');
    const capacity = tanks * TANK_CAPACITY;
    const now = Date.now();
    const station = deps.station();
    return {
      bolted: deps.bolted(),
      station,
      trim: readOrbitTrim(),
      commander: isCommander(),
      engines: countFunction('engine'),
      fuel: clampFuelToCapacity(readFuelLevel(capacity), capacity),
      now,
      firing: readBurnFiring(now, station),
      logFull: isBurnLogFull(),
      tanks,
      capacity,
    };
  };

  /** Everything a move decision reads, fresh, on top of the burn's. */
  const readMoveContext = (c: ReturnType<typeof readContext>): MoveContext => ({
    bolted: c.bolted,
    station: c.station,
    stations: listStations(),
    commander: c.commander,
    engines: c.engines,
    fuel: c.fuel,
    drawn: readMoveFuelDrawn(),
    deficit: fuelDrawDeficit('stationMove'),
    // 0 (refused, no quote) until this install's atlas holds the station.
    modules: c.station ? atlasComponent(readAtlas(), c.station.welcomeRoomId).size : 0,
    now: c.now,
  });

  /** The MOVE TO ANOTHER PLANET block: the move under way, or a quote per
   *  planet with its MOVE button. */
  const refreshMove = (c: ReturnType<typeof readContext>): void => {
    const mc = readMoveContext(c);
    const station = mc.station;
    const move = station?.move;
    let rows = '';
    let note = '';
    if (!station) {
      note = describeMoveRefusal('no-station', null, mc.fuel);
    } else if (move && isMoveActive(move, mc.now)) {
      note = describeMove(move, mc.now);
    } else if (mc.modules < 1) {
      note = describeMoveRefusal('unknown-layout', null, mc.fuel);
    } else {
      for (const planetId of otherPlanets(station)) {
        const quote = quoteMove(station, mc.stations, planetId, mc.modules, mc.now);
        const name = esc(planetById(planetId).name);
        if (!quote) {
          rows += `<div style="padding:5px 0; font-size:10px; color:${GOLD_DIM};">${name} · no free orbit</div>`;
          continue;
        }
        const plan = planStationMove(mc, planetId);
        const ready = plan.ok;
        rows += `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid rgba(212,168,75,0.10); font-size:10px; line-height:1.45;">
            <span><b style="color:#F0C060;">${name}</b> · slot ${quote.toSlot}<br>
              <span style="color:${GOLD_DIM};">window in ${formatLongSpan(quote.plan.waitMs)} · ${formatLongSpan(quote.plan.transferMs)} flight · ${quote.plan.deltaVKmS.toFixed(2)} km/s</span><br>
              ${check(mc.fuel >= quote.fuel)} ${quote.fuel} fuel <span style="color:${GOLD_DIM};">(${mc.modules} module${mc.modules === 1 ? '' : 's'})</span></span>
            <button type="button" data-sk-move="${esc(planetId)}" title="${esc(ready ? `Leave for ${planetById(planetId).name} at the next launch window` : describeMoveRefusal(plan.refusal, plan.quote, mc.fuel))}" style="padding:5px 10px; border-radius:6px; border:1px solid rgba(255,179,0,0.45); background:rgba(255,179,0,0.10); color:${AMBER}; font-family:inherit; font-size:10px; font-weight:800; letter-spacing:0.5px; opacity:${ready ? '1' : '0.45'}; cursor:pointer;">MOVE</button>
          </div>`;
      }
    }
    setText('#sk-move', rows);
    const msg = q<HTMLElement>('#sk-move-msg');
    if (msg) {
      const text = moveFlash && mc.now < moveFlash.until ? moveFlash.text : note;
      if (msg.textContent !== text) msg.textContent = text;
      msg.style.display = text ? 'block' : 'none';
      msg.style.color = moveFlash && mc.now < moveFlash.until ? WARN : GOLD;
    }
  };

  /** Schedule the move to `planetId` — the block's only write. */
  const startMove = (planetId: string): void => {
    const c = readContext();
    const plan = planStationMove(readMoveContext(c), planetId);
    if (!plan.ok) {
      moveFlash = { text: describeMoveRefusal(plan.refusal, plan.quote, c.fuel), until: c.now + FLASH_MS * 2 };
    } else {
      moveFlash = null;
      writeStationMove(plan.move);
    }
    refresh();
  };

  /** The room's burn firing now, on the orbit the dashboard shows. */
  const firingNow = (now: number): FiredBurn | null => (view ? readBurnFiring(now, view.station) : null);

  const refresh = (): void => {
    if (!panel) return;
    sinceText = 0;
    const c = readContext();
    const station = c.station;
    const trim = trimFor(station, c.trim);
    const base = station ? slotOrbit(station) : null;
    view = station && base ? { station, base, trim, planet: base.planet.name } : null;

    if (view && base) {
      const orbit = trimmedOrbit(base, trim);
      const dR = trim?.dRadiusKm ?? 0;
      setText('#sk-station', esc(view.station.name));
      setText('#sk-orbit', `${esc(view.planet)} · slot ${view.station.orbitSlot}`);
      setText('#sk-alt', `${orbit.altitudeKm.toFixed(1)} km <span style="color:${GOLD_DIM};">· slot ${base.altitudeKm.toFixed(1)} km${
        Math.abs(dR) > 1e-9 ? ` (${dR > 0 ? '+' : '−'}${Math.abs(dR).toFixed(1)})` : ''}</span>`);
      setText('#sk-speed', `${orbit.speedKmS.toFixed(3)} km/s <span style="color:${GOLD_DIM};">· ${formatSpan(realMsFor(orbit.periodS))} per orbit</span>`);
      setText('#sk-pos', describeOffset(slotOffsetAt(base, trim, c.now)));
      setText('#sk-drift', describeDrift(slotDriftPerHour(base, trim)));
    } else {
      for (const sel of ['#sk-station', '#sk-orbit', '#sk-alt', '#sk-speed', '#sk-pos', '#sk-drift']) {
        setText(sel, '<span style="color:rgba(212,168,75,0.45);">—</span>');
      }
    }
    setText('#sk-thrusters', c.engines >= 1
      ? `${check(true)} ${c.engines} engine block${c.engines === 1 ? '' : 's'}`
      : `${check(false)} none`);
    setText('#sk-fuel', c.capacity > 0
      ? `${check(c.fuel >= TRIM_FUEL)} ${c.fuel} / ${c.capacity} <span style="color:${GOLD_DIM};">· ${TRIM_FUEL} per burn</span>`
      : `${check(false)} no fuel tank`);

    // A refusal that holds for every direction (no station, not the owner,
    // no thrusters, no fuel) greys the whole stick and is said on the status
    // line. One that holds for a single push (a burn still firing, the trim
    // band's edge) leaves the control live: pressing it says why instead.
    const plan = planTrim(c, 'raise');
    const stickRefusal = !plan.ok && STICK_REFUSALS.includes(plan.refusal) ? plan.refusal : null;
    for (const dir of TRIM_DIRECTIONS) {
      const b = q<HTMLButtonElement>(`[data-sk-dir="${dir}"]`);
      if (!b) continue;
      b.disabled = stickRefusal !== null;
      b.style.opacity = stickRefusal ? '0.4' : '1';
      b.style.cursor = stickRefusal ? 'not-allowed' : 'pointer';
    }
    const well = q<HTMLElement>('#sk-well');
    if (well) well.style.opacity = stickRefusal ? '0.45' : '1';

    const msg = q<HTMLElement>('#sk-msg');
    if (msg) {
      let text: string;
      let tone: string;
      if (stickRefusal) {
        text = describeRefusal(stickRefusal, c.tanks);
        tone = WARN;
      } else if (flash && c.now < flash.until) {
        text = flash.text;
        tone = WARN;
      } else if (view) {
        text = describeTrimStatus(view.base, trim, c.now, trimFor(station, c.firing ?? null));
        tone = text.startsWith('ON STATION') ? GREEN : text.startsWith('BURNING') ? AMBER : GOLD;
      } else {
        text = describeRefusal('no-station', c.tanks);
        tone = WARN;
      }
      if (msg.textContent !== text) msg.textContent = text;
      msg.style.color = tone;
    }
    refreshMove(c);
  };

  /** One burn — the stick's only write. */
  const fire = (dir: TrimDirection): void => {
    const c = readContext();
    if (isMoveActive(c.station?.move, c.now)) {
      flash = { text: 'The station is moving to another planet: the stick holds until it arrives.', until: c.now + FLASH_MS };
      refresh();
      return;
    }
    const plan = planTrim(c, dir);
    if (!plan.ok) {
      flash = { text: describeRefusal(plan.refusal, c.tanks, trimFor(c.station, c.trim)?.dRadiusKm ?? 0), until: c.now + FLASH_MS };
      refresh();
      return;
    }
    flash = writeTrimBurn(plan.burn) ? null : { text: 'The burn did not go through. Try the stick again.', until: c.now + FLASH_MS };
    refresh();
  };

  /** The knob: where the hand holds it, else leaning the way a burn pushes. */
  const placeKnob = (now: number): void => {
    const knob = q<HTMLElement>('#sk-knob');
    if (!knob) return;
    if (drag) {
      knob.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
      return;
    }
    const firing = firingNow(now);
    const push = firing ? PUSH[firing.dir] : { x: 0, y: 0 };
    const t = `translate(${push.x * KNOB_TRAVEL * 0.7}px, ${push.y * KNOB_TRAVEL * 0.7}px)`;
    if (knob.style.transform !== t) knob.style.transform = t;
  };

  const btn = (dir: TrimDirection, label: string, title: string) =>
    `<button type="button" data-sk-dir="${dir}" title="${esc(title)}" style="width:100%; padding:5px 2px; border-radius:6px; border:1px solid rgba(255,179,0,0.45); background:rgba(255,179,0,0.10); color:${AMBER}; font-family:inherit; font-size:10px; font-weight:800; letter-spacing:0.5px; white-space:pre-line; line-height:1.25;">${label}</button>`;
  const row = (label: string, id: string) => `
    <div style="display:flex; justify-content:space-between; gap:10px; padding:4px 0; border-bottom:1px solid rgba(212,168,75,0.10); font-size:11px;">
      <span style="color:${GOLD_DIM};">${label}</span><span id="${id}" style="text-align:right;"></span>
    </div>`;
  const tabStyle = (on: boolean) => `flex:1; padding:6px; border-radius:6px; border:1px solid ${on ? AMBER : 'rgba(212,168,75,0.25)'}; background:${on ? 'rgba(255,179,0,0.14)' : 'transparent'}; color:${on ? AMBER : GOLD_DIM}; font-family:inherit; font-size:10px; font-weight:800; letter-spacing:1px; cursor:pointer;`;

  const mountKeep = (h: HTMLElement): void => {
    panel = document.createElement('div');
    panel.id = 'device-station-helm-pane';
    panel.style.cssText = `
      position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
      width: 400px; max-height: 88vh; overflow-y: auto;
      background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
      border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
      padding: 18px; display: flex; flex-direction: column;
      color: ${GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      box-sizing: border-box; pointer-events: auto;
    `;
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">🛰️ STATION HELM</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div style="display:flex; gap:6px; margin:8px 0 4px;">
        <button type="button" data-sk-tab="keep" aria-pressed="true" style="${tabStyle(true)}">STATION KEEPING</button>
        <button type="button" data-sk-tab="ship" aria-pressed="false" style="${tabStyle(false)}">FUEL &amp; DOCKING</button>
      </div>
      ${row('STATION', 'sk-station')}
      ${row('ORBIT', 'sk-orbit')}
      ${row('ALTITUDE', 'sk-alt')}
      ${row('SPEED', 'sk-speed')}
      ${row('POSITION', 'sk-pos')}
      ${row('DRIFT', 'sk-drift')}
      ${row('THRUSTERS', 'sk-thrusters')}
      ${row('PROPELLANT', 'sk-fuel')}
      <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; margin-top:10px;">
        <canvas id="sk-box" width="368" height="320" style="width:184px; height:160px; display:block; border-radius:6px; border:1px solid rgba(0,229,255,0.18);" aria-label="Station keeping box: the station against its orbit slot"></canvas>
        <div style="display:grid; grid-template-columns:44px 74px 44px; grid-template-rows:auto 74px auto; gap:4px; align-items:center; justify-items:stretch;">
          <span></span>${btn('raise', '▲ RAISE', `Raise the orbit ${TRIM_STEP_KM} km (one burn)`)}<span></span>
          ${btn('back', '◀\nBACK', `Slide ${PHASE_STEP_DEG}° back along the orbit (one burn)`)}
          <div id="sk-well" tabindex="0" role="group" aria-label="Trim stick. Flick it, or use the arrow keys: up raises, down lowers, right slides ahead, left slides back." style="position:relative; width:74px; height:74px; border-radius:50%; background:radial-gradient(circle, #0b1620 55%, #05090f); border:1px solid rgba(255,179,0,0.45); box-shadow: inset 0 0 12px rgba(0,0,0,0.9); touch-action:none; cursor:grab; outline-offset:2px;">
            <div style="position:absolute; left:50%; top:8px; bottom:8px; width:1px; background:rgba(255,179,0,0.18);"></div>
            <div style="position:absolute; top:50%; left:8px; right:8px; height:1px; background:rgba(255,179,0,0.18);"></div>
            <div id="sk-knob" style="position:absolute; left:50%; top:50%; width:26px; height:26px; margin:-13px 0 0 -13px; border-radius:50%; background:radial-gradient(circle at 35% 35%, #FFE082, ${AMBER} 55%, #7a4f00); box-shadow:0 2px 6px rgba(0,0,0,0.8); transition:transform 0.18s ease-out; pointer-events:none;"></div>
          </div>
          ${btn('ahead', '▶\nAHEAD', `Slide ${PHASE_STEP_DEG}° ahead along the orbit (one burn)`)}
          <span></span>${btn('lower', '▼ LOWER', `Lower the orbit ${TRIM_STEP_KM} km (one burn)`)}<span></span>
        </div>
      </div>
      <div id="sk-msg" role="status" style="margin-top:10px; padding:9px 12px; border:1px solid rgba(212,168,75,0.2); border-radius:8px; font-size:10px; line-height:1.55;"></div>
      <div style="margin-top:12px; font-size:10px; font-weight:800; color:#F0C060; letter-spacing:1px;">🚚 MOVE TO ANOTHER PLANET</div>
      <div id="sk-move"></div>
      <div id="sk-move-msg" role="status" style="margin-top:6px; font-size:10px; line-height:1.55;"></div>
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px; margin-top:10px; line-height:1.5;">
        SSF STATION KEEPING v0 · circular orbit · a lower orbit runs faster · one flick = one burn = ${TRIM_FUEL} fuel
      </div>
    `;

    // Clicks stay in the panel: the window-level canvas handler releases the
    // focus on any click that reaches it.
    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const dirBtn = target.closest<HTMLButtonElement>('[data-sk-dir]');
      if (dirBtn && !dirBtn.disabled) {
        fire(dirBtn.dataset.skDir as TrimDirection);
        return;
      }
      const moveBtn = target.closest<HTMLButtonElement>('[data-sk-move]');
      if (moveBtn?.dataset.skMove) {
        startMove(moveBtn.dataset.skMove);
        return;
      }
      const tab = target.closest<HTMLElement>('[data-sk-tab]');
      if (tab?.dataset.skTab === 'ship') showShip();
    });

    const well = panel.querySelector<HTMLElement>('#sk-well')!;
    well.addEventListener('keydown', (e) => {
      const dir = ARROW_KEYS[e.key];
      if (!dir) return;
      e.preventDefault();
      // One press, one burn: a held key's auto-repeat is not a new press
      // (it would fire again the moment the last burn ends).
      if (e.repeat) return;
      fire(dir);
    });
    well.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = well.getBoundingClientRect();
      drag = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, dx: 0, dy: 0 };
      well.setPointerCapture?.(e.pointerId);
      well.style.cursor = 'grabbing';
      const knob = q<HTMLElement>('#sk-knob');
      if (knob) knob.style.transition = 'none';
    });
    well.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      let dx = e.clientX - drag.cx;
      let dy = e.clientY - drag.cy;
      const len = Math.hypot(dx, dy);
      if (len > KNOB_TRAVEL) {
        dx = (dx / len) * KNOB_TRAVEL;
        dy = (dy / len) * KNOB_TRAVEL;
      }
      drag.dx = dx;
      drag.dy = dy;
      placeKnob(Date.now());
    });
    const letGo = (e: PointerEvent, flick: boolean) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dir = flick ? flickDirection(drag.dx, drag.dy) : null;
      drag = null;
      well.style.cursor = 'grab';
      const knob = q<HTMLElement>('#sk-knob');
      if (knob) knob.style.transition = 'transform 0.18s ease-out';
      if (dir) fire(dir);
      placeKnob(Date.now());
    };
    well.addEventListener('pointerup', (e) => letGo(e, true));
    well.addEventListener('pointercancel', (e) => letGo(e, false));

    h.appendChild(panel);
    unsubs.push(subscribeStationKeeping(refresh));
    unsubs.push(subscribeStationMove(refresh));
    unsubs.push(subscribeShip(refresh));
    unsubs.push(subscribeFurniture(refresh));
    unsubs.push(subscribeDoors(refresh));
    // 🪐 A peer's trim of this station, or a newly learned neighbour.
    unsubs.push(subscribePlanetSummary(refresh));
    refresh();
    placeKnob(Date.now());
  };

  const unmountKeep = (): void => {
    for (const off of unsubs.splice(0)) off();
    drag = null;
    panel?.remove();
    panel = null;
  };

  const showShip = (): void => {
    if (!host || face === 'ship') return;
    unmountKeep();
    face = 'ship';
    ship = deps.shipFace();
    ship.mount(host);
    back = document.createElement('button');
    back.type = 'button';
    back.textContent = '◂ STATION KEEPING';
    back.style.cssText = `position:absolute; top:14px; left:50%; transform:translateX(-50%); pointer-events:auto; padding:7px 14px; border-radius:8px; border:1px solid ${AMBER}; background:rgba(4,8,22,0.94); color:${AMBER}; font-family:'SF Mono','Monaco','Consolas',monospace; font-size:11px; font-weight:800; letter-spacing:1px; cursor:pointer; box-shadow:0 6px 24px rgba(0,0,0,0.8);`;
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      showKeep();
    });
    host.appendChild(back);
  };

  const showKeep = (): void => {
    if (!host || face === 'keep') return;
    ship?.unmount();
    ship = null;
    back?.remove();
    back = null;
    face = 'keep';
    mountKeep(host);
  };

  return {
    mount(h: HTMLElement): void {
      host = h;
      face = 'keep';
      mountKeep(h);
    },
    unmount(): void {
      if (face === 'ship') {
        ship?.unmount();
        ship = null;
        back?.remove();
        back = null;
      } else {
        unmountKeep();
      }
      face = 'keep';
      host = null;
      view = null;
      flash = null;
      moveFlash = null;
    },
    update(dt: number): void {
      if (face === 'ship') {
        ship?.update(dt);
        return;
      }
      if (!panel) return;
      sinceText += dt;
      if (sinceText >= TEXT_REFRESH_S || (flash && Date.now() >= flash.until)) {
        if (flash && Date.now() >= flash.until) flash = null;
        if (moveFlash && Date.now() >= moveFlash.until) moveFlash = null;
        refresh();
      }
      const now = Date.now();
      placeKnob(now);
      const canvas = q<HTMLCanvasElement>('#sk-box');
      if (canvas) drawKeepingBox(canvas, view, now, firingNow(now));
    },
  };
}
