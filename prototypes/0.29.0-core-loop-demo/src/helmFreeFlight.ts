/**
 * 🕹️ The helm's FREE FLIGHT panel (issue 203): the radar, the live figures,
 * the stick and AUTO-DOCK. devices.ts createHelmUI renders it while the ship
 * is flown by hand and wires its buttons; this file only draws.
 */

import {
  APPROACH_ZONE_KM,
  DOCK_ZONE_KM,
  HULL_KM,
  bodyOffset,
  propagate,
  readout,
  speedCap,
} from './freeFlight';
import type { FreePose, FreeReadout, FreeStation, FreeZone } from './freeFlight';
import { readStore } from './planetSummary';
import { currentRoomId } from './stations';

const ZONE_NAMES: Record<FreeZone, string> = {
  open: 'OPEN SPACE',
  approach: 'APPROACH ZONE',
  dock: 'DOCKING ZONE',
};
const ZONE_COLORS: Record<FreeZone, string> = {
  open: '#81D4FA',
  approach: '#FFB74D',
  dock: '#00E676',
};

/** km/s on the orbital clock, as the helm says it. */
export function formatSpeed(kms: number): string {
  const ms = kms * 1000;
  return ms < 1000 ? `${Math.round(ms)} m/s` : `${kms.toFixed(2)} km/s`;
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/** The figures that change every frame, by data-free-live name. */
export function freeFigures(r: FreeReadout): Record<string, string> {
  return {
    speed: formatSpeed(r.speedKms),
    cap: formatSpeed(speedCap(r.zone)),
    alt: `${Math.round(r.altitudeKm).toLocaleString('en-US')} km`,
    zone: ZONE_NAMES[r.zone],
    nearest: r.nearest ? `${r.nearest.station.name} · ${formatDistance(r.nearest.distanceKm)}` : 'no station known around this planet',
  };
}

/** What a redraw of the panel's buttons depends on (the rest moves in place). */
export function freePanelKey(r: FreeReadout | null): string {
  return r ? `${r.zone}|${r.dockAt?.id ?? ''}|${r.parked}|${Math.ceil(r.parkFuel - 1e-9)}` : 'none';
}

export interface FreePanelInput {
  readout: FreeReadout | null;
  commander: boolean;
  stickTaken: boolean;
  padName: string | null;
  /** A note under AUTO-DOCK (why it could not dock, say). */
  note: string | null;
  /** Fuel in the tanks (PARK needs parkFuel of it). */
  fuel: number;
  esc: (s: string) => string;
}

export function renderFreeFlightPanel(i: FreePanelInput): string {
  const r = i.readout;
  if (!r) {
    return `
      <div style="margin-top:12px; padding:10px 12px; border:1px solid rgba(129,212,250,0.35); border-radius:8px;">
        <div style="font-size:11px; color:#81D4FA; letter-spacing:0.5px;">🕹️ FLYING FREE</div>
        <div style="font-size:10px; color:rgba(212,168,75,0.75); margin-top:6px;">Waiting for the ship's position to arrive…</div>
      </div>`;
  }
  const f = freeFigures(r);
  const zoneColor = ZONE_COLORS[r.zone];
  const stickBtn = !i.commander
    ? `<button disabled style="${btnStyle(false, '#81D4FA')}">COMMANDER ONLY</button>`
    : `<button id="helm-free-stick" style="${btnStyle(true, i.stickTaken ? '#FFB74D' : '#81D4FA')}">${i.stickTaken ? 'LET GO OF THE STICK' : 'TAKE THE STICK'}</button>`;
  const dockOk = i.commander && r.dockAt !== null;
  const dockLabel = r.dockAt
    ? `AUTO-DOCK AT ${i.esc(r.dockAt.name.toUpperCase())}`
    : `AUTO-DOCK · within ${formatDistance(DOCK_ZONE_KM)} of a station`;
  // 🅿️ PARK: stop dead and hold a steady orbit here.
  const parkNeed = Math.ceil(r.parkFuel - 1e-9);
  const parkOk = i.commander && !r.parked && i.fuel >= parkNeed;
  const parkLabel = r.parked
    ? `🅿️ PARKED · ${r.nearest && r.zone !== 'open' ? `holding beside ${i.esc(r.nearest.station.name.toUpperCase())}` : 'steady orbit'}`
    : `🅿️ PARK${parkNeed > 0 ? ` · ${parkNeed} fuel to stop` : ''}`;
  const parkBtn = `<button id="helm-free-park"${parkOk ? '' : ' disabled'} style="${btnStyle(parkOk || r.parked, '#CE93D8')} margin-top:8px;">${parkLabel}</button>`;
  const parkNote = r.parked
    ? 'Parked: the ship holds this orbit until you thrust again. Turning does not unpark it.'
    : !i.commander ? '' : i.fuel < parkNeed ? `PARK needs ${parkNeed} fuel to stop the ship; the tanks hold ${Math.floor(i.fuel)}. Brake by hand instead.` : '';
  const legend = i.stickTaken
    ? `<div style="font-size:9px; color:rgba(212,168,75,0.6); margin-top:6px; line-height:1.5;">
        W/S or ↑/↓ thrust · A/D or ←/→ turn · Q/E slide · X or SPACE brake${i.padName ? `<br>🎮 ${i.esc(i.padName.slice(0, 48))}: stick turns and thrusts, button 1 brakes` : ''}
      </div>`
    : `<div style="font-size:9px; color:rgba(212,168,75,0.6); margin-top:6px; line-height:1.5;">The ship coasts while nobody holds the stick.</div>`;
  return `
    <div style="margin-top:12px; padding:10px 12px; border:1px solid ${zoneColor}55; border-radius:8px; background:rgba(129,212,250,0.04);">
      <div style="display:flex; justify-content:space-between; font-size:11px; letter-spacing:0.5px;">
        <span style="color:#81D4FA;">🕹️ FLYING FREE</span>
        <span data-free-live="zone" style="color:${zoneColor};">${f.zone}</span>
      </div>
      <canvas id="helm-free-radar" style="width:100%; height:200px; margin-top:8px; display:block; background:rgba(0,0,0,0.45); border:1px solid rgba(129,212,250,0.18); border-radius:6px;"></canvas>
      <div style="display:grid; grid-template-columns:auto 1fr; gap:3px 10px; font-size:10px; margin-top:8px;">
        <span style="color:rgba(212,168,75,0.7);">SPEED</span><span><span data-free-live="speed">${f.speed}</span> <span style="color:rgba(212,168,75,0.5);">(limit <span data-free-live="cap">${f.cap}</span>)</span></span>
        <span style="color:rgba(212,168,75,0.7);">ALTITUDE</span><span data-free-live="alt">${f.alt}</span>
        <span style="color:rgba(212,168,75,0.7);">NEAREST</span><span data-free-live="nearest">${i.esc(f.nearest)}</span>
      </div>
      <div style="margin-top:8px;">${stickBtn}</div>
      ${legend}
      ${parkBtn}
      ${parkNote ? `<div style="font-size:9px; color:rgba(212,168,75,0.6); margin-top:6px; line-height:1.5;">${parkNote}</div>` : ''}
      <button id="helm-free-dock"${dockOk ? '' : ' disabled'} style="${btnStyle(dockOk, '#00E676')} margin-top:8px;">${dockLabel}</button>
      ${i.note ? `<div style="font-size:10px; color:#FFB74D; margin-top:6px; line-height:1.4;">${i.esc(i.note)}</div>` : ''}
      <div style="font-size:9px; color:rgba(212,168,75,0.5); margin-top:6px; line-height:1.4;">Speed limits: ${formatSpeed(speedCap('approach'))} within ${APPROACH_ZONE_KM} km of a station, ${formatSpeed(speedCap('dock'))} within ${DOCK_ZONE_KM} km. Nothing gets closer than ${Math.round(HULL_KM * 1000)} m.</div>
    </div>`;
}

function btnStyle(enabled: boolean, tone: string): string {
  return `width:100%; padding:8px; border-radius:6px; border:1px solid ${enabled ? tone : 'rgba(212,168,75,0.25)'}; background:${enabled ? `${tone}2E` : 'rgba(80,80,80,0.15)'}; color:${enabled ? tone : 'rgba(212,168,75,0.4)'}; font-family:inherit; font-weight:800; cursor:${enabled ? 'pointer' : 'not-allowed'}; text-transform:uppercase;`;
}

/** Write the moving figures into the open panel. */
export function writeFreeFigures(panel: HTMLElement, r: FreeReadout): void {
  const f = freeFigures(r);
  for (const el of panel.querySelectorAll<HTMLElement>('[data-free-live]')) {
    const v = f[el.dataset.freeLive ?? ''];
    if (v !== undefined && el.textContent !== v) el.textContent = v;
  }
  const zone = panel.querySelector<HTMLElement>('[data-free-live="zone"]');
  if (zone) zone.style.color = ZONE_COLORS[r.zone];
}

/** Radar ranges, km: the smallest that holds the nearest station. */
const RANGES = [0.5, 2, 10, 50, 250, 1000, 5000, 25000, 100000];

/**
 * The radar: the ship at the centre, nose up; the stations around the planet
 * (with the zones of a near one), other ships flown by hand, the way to the
 * planet and the way the orbit runs. Heading-up, so turning turns the world.
 */
export function drawFreeRadar(canvas: HTMLCanvasElement, pose: FreePose, stations: readonly FreeStation[], now: number): void {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const w = canvas.clientWidth || 360;
  const h = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const r = readout(pose, stations);
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 14;
  const want = r.nearest ? r.nearest.distanceKm * 1.25 : 5000;
  const range = RANGES.find((x) => x >= want) ?? RANGES[RANGES.length - 1];
  const scale = radius / range;
  const toScreen = (fwd: number, right: number) => ({ x: cx + right * scale, y: cy - fwd * scale });

  // Range rings.
  g.strokeStyle = 'rgba(129,212,250,0.18)';
  g.lineWidth = 1;
  for (const k of [0.5, 1]) {
    g.beginPath();
    g.arc(cx, cy, radius * k, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(129,212,250,0.45)';
  g.font = '9px monospace';
  g.textAlign = 'left';
  g.fillText(formatDistance(range), cx + radius * 0.72, cy - radius * 0.72);

  // Edge markers: the planet (radial in) and the way the orbit runs.
  const edge = (fwd: number, right: number, label: string, color: string) => {
    const l = Math.hypot(fwd, right) || 1;
    const x = cx + (right / l) * (radius + 6);
    const y = cy - (fwd / l) * (radius + 6);
    g.fillStyle = color;
    g.textAlign = 'center';
    g.fillText(label, Math.max(14, Math.min(w - 14, x)), Math.max(9, Math.min(h - 3, y + 3)));
  };
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  // Body frame of a local (along, radial) direction: fwd = a·c + r·s, right = −a·s + r·c.
  edge(-s, -c, '● PLANET', 'rgba(255,183,77,0.75)');
  edge(c, -s, 'ORBIT ▲', 'rgba(129,212,250,0.55)');

  // Stations, with the zones of the nearest.
  for (const st of stations) {
    const off = bodyOffset(pose, st.pointAt(now));
    const d = Math.hypot(off.fwd, off.right);
    const near = r.nearest?.station === st;
    if (near) {
      const p = toScreen(off.fwd, off.right);
      for (const [km, color] of [[APPROACH_ZONE_KM, 'rgba(255,183,77,0.35)'], [DOCK_ZONE_KM, 'rgba(0,230,118,0.45)'], [HULL_KM, 'rgba(255,138,128,0.5)']] as const) {
        const px = km * scale;
        if (px < 3 || px > radius * 6) continue;
        g.strokeStyle = color;
        g.setLineDash(km === HULL_KM ? [] : [4, 3]);
        g.beginPath();
        g.arc(p.x, p.y, px, 0, Math.PI * 2);
        g.stroke();
      }
      g.setLineDash([]);
    }
    if (d * scale <= radius) {
      const p = toScreen(off.fwd, off.right);
      g.fillStyle = near ? '#F0C060' : '#D8E2EE';
      g.fillRect(p.x - 3, p.y - 3, 6, 6);
      g.textAlign = 'left';
      g.fillText(st.name.slice(0, 22), p.x + 6, p.y - 4);
    } else if (near) {
      edge(off.fwd, off.right, `◆ ${st.name.slice(0, 16)}`, '#F0C060');
    }
  }

  // Other ships flown by hand, as last heard of (coasted on).
  try {
    const own = currentRoomId();
    for (const ship of Object.values(readStore(now).ships)) {
      if (ship.retired || ship.roomId === own || ship.status !== 'free-flight' || !ship.free) continue;
      if (ship.free.planetId !== pose.planetId) continue;
      const there = propagate(ship.free, now, stations);
      const off = bodyOffset(pose, { radiusKm: there.radiusKm, angle: there.angle });
      if (Math.hypot(off.fwd, off.right) * scale > radius) continue;
      const p = toScreen(off.fwd, off.right);
      g.fillStyle = '#FFA040';
      g.beginPath();
      g.moveTo(p.x, p.y - 4); g.lineTo(p.x + 4, p.y); g.lineTo(p.x, p.y + 4); g.lineTo(p.x - 4, p.y);
      g.fill();
      g.textAlign = 'left';
      g.fillText(ship.name.slice(0, 16), p.x + 6, p.y + 3);
    }
  } catch {
    /* the summary store is optional here */
  }

  // Velocity: the limit for the zone reaches the inner ring.
  const vf = pose.vAlong * c + pose.vRadial * s;
  const vr = -pose.vAlong * s + pose.vRadial * c;
  const vScale = (radius * 0.5) / speedCap(r.zone);
  if (Math.hypot(vf, vr) > 1e-6) {
    g.strokeStyle = '#00E676';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + vr * vScale, cy - vf * vScale);
    g.stroke();
    g.lineWidth = 1;
  }

  // The ship, nose up.
  g.fillStyle = '#81D4FA';
  g.beginPath();
  g.moveTo(cx, cy - 8);
  g.lineTo(cx + 5, cy + 6);
  g.lineTo(cx, cy + 3);
  g.lineTo(cx - 5, cy + 6);
  g.closePath();
  g.fill();
}
