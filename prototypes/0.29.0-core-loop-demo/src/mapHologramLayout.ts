/**
 * 🔮 The map table's hologram, laid out (#251, follow-up to #33).
 *
 * The holotable's 2D panel plots the solar system (map.ts) and, from a
 * station's card, the station's own plan (stationPlan.ts). The hologram
 * floating over the table shows the same two pictures in the room, to
 * everyone standing there, in turn: the plot, then the station you are
 * in, each faded in and out. This module is the pure part — where every
 * marker, ring, course, module block and gangway sits on the disc, in
 * metres from the disc's centre — so it tests without three.js. The map's
 * frame (screenOffset: +x right, +y down the screen, looking down from the
 * north) lands on the table as +x, +z: the picture reads from the table's
 * player side exactly as the panel does.
 */

import type { MapBody } from './map';
import { courseOnScreen, plotOffset } from './map';
import type { PlanModule, StationPlan } from './stationPlan';

/** Radius of the picture on the disc (metres) — inside the disc's 0.62. */
export const HOLO_RADIUS = 0.5;
/** Map units that reach the picture's edge: the belt (280) just inside it. */
export const PLOT_EXTENT = 300;
/** Metres per map unit. */
export const PLOT_SCALE = HOLO_RADIUS / PLOT_EXTENT;

export interface HoloMarker {
  id: string;
  name: string;
  type: MapBody['type'];
  /** Metres from the disc centre. */
  x: number;
  z: number;
  /** The station the holotable marks "you are here". */
  here: boolean;
  /** The orbit the body rides, when it rides one: its centre and radius on
   *  the disc (a planet's round the sun, a station's round its planet). */
  orbit?: { cx: number; cz: number; r: number };
}

/**
 * Every body of the plot at `nowMs`, on the disc. A body's orbit ring is
 * its own (a planet's round the sun at its schematic radius; a station's
 * round its planet, where its altitude puts it); a station crossing to
 * another planet rides none until it arrives; the sun, the Lagrange
 * pockets and the belt ride their parents' rings or none.
 */
export function plotMarkers(
  bodies: readonly MapBody[],
  nowMs: number,
  hereId = '',
  simTick = 0,
): HoloMarker[] {
  return bodies.map((body) => {
    const o = plotOffset(bodies, body, nowMs, simTick);
    const marker: HoloMarker = {
      id: body.id,
      name: body.name,
      type: body.type,
      x: o.dx * PLOT_SCALE,
      z: o.dy * PLOT_SCALE,
      here: body.type === 'station' && body.id === hereId,
    };
    const ring = orbitRing(bodies, body, nowMs, simTick);
    if (ring) marker.orbit = ring;
    return marker;
  });
}

function orbitRing(
  bodies: readonly MapBody[],
  body: MapBody,
  nowMs: number,
  simTick: number,
): HoloMarker['orbit'] | null {
  if (body.type === 'star' || body.type === 'lagrange' || body.type === 'asteroid-field') return null;
  let parentId = body.parentId;
  let radius = body.orbitRadius;
  if (body.placeAt) {
    const place = body.placeAt(nowMs);
    // In transit between planets (no parent): no ring to ride.
    if (!place.parentId) return null;
    parentId = place.parentId;
    radius = place.radius;
  }
  if (body.eccentricity && body.semiMajorAxis) return null;
  const parent = parentId ? bodies.find((b) => b.id === parentId) : undefined;
  if (parentId && !parent) return null;
  const c = parent ? plotOffset(bodies, parent, nowMs, simTick) : { dx: 0, dy: 0 };
  return { cx: c.dx * PLOT_SCALE, cz: c.dy * PLOT_SCALE, r: radius * PLOT_SCALE };
}

/** The belt's radius on the disc, when the plot has one. */
export function beltRadius(bodies: readonly MapBody[]): number | null {
  const belt = bodies.find((b) => b.type === 'asteroid-field');
  return belt ? belt.orbitRadius * PLOT_SCALE : null;
}

/** Each moving station's course on the disc (courseOnScreen at the disc's
 *  scale), burn to arrival; nothing once it has arrived. */
export function plotCourses(
  bodies: readonly MapBody[],
  nowMs: number,
): Array<{ id: string; points: Array<{ x: number; z: number }> }> {
  const out: Array<{ id: string; points: Array<{ x: number; z: number }> }> = [];
  for (const body of bodies) {
    const pts = courseOnScreen(body, nowMs, 0, 0, PLOT_SCALE);
    if (pts.length > 1) out.push({ id: body.id, points: pts.map((p) => ({ x: p.x, z: p.y })) });
  }
  return out;
}

export interface HoloModule {
  roomId: string;
  name: string;
  /** Centre on the disc (metres) and heading. */
  x: number;
  z: number;
  rotY: number;
  /** Half extents on the disc (metres). */
  halfX: number;
  halfZ: number;
  /** The room this client stands in. */
  here: boolean;
  ship: boolean;
}

export interface HoloLink {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** A visiting ship's berth, not station structure. */
  berth: boolean;
}

export interface StationHologram {
  /** Metres per plan unit. */
  scale: number;
  modules: HoloModule[];
  links: HoloLink[];
}

/** The most of the disc a station fills, so its gangways keep clear of the rim. */
const STATION_FILL = 0.9;
/** The most of the disc's radius one module may span, so a lone 2 × 2
 *  room is a block on the table, not a slab across it. */
const MODULE_FILL = 0.5;

/**
 * The station's plan on the disc: centred on the plan's bounds, scaled so
 * the whole station fits inside `radius` (and no single module spans more
 * than MODULE_FILL of it), each gangway a line between the two modules it
 * joins, drawn once however many doors name it.
 */
export function stationLayout(plan: StationPlan, radius = HOLO_RADIUS): StationHologram {
  const all = [...plan.modules, ...plan.ships];
  if (all.length === 0) return { scale: 0, modules: [], links: [] };
  const b = plan.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  // The bounds' corner is the farthest any module reaches.
  const reach = Math.max(Math.hypot(b.maxX - cx, b.maxZ - cz), 1e-6);
  const largest = Math.max(...all.map((m) => 2 * Math.max(m.halfX, m.halfZ)), 1e-6);
  const scale = Math.min((radius * STATION_FILL) / reach, (radius * MODULE_FILL) / largest);
  const at = (m: PlanModule) => ({ x: (m.x - cx) * scale, z: (m.z - cz) * scale });
  const modules = all.map((m): HoloModule => ({
    roomId: m.roomId,
    name: m.name,
    ...at(m),
    rotY: m.rotY,
    halfX: m.halfX * scale,
    halfZ: m.halfZ * scale,
    here: m.here,
    ship: m.kind === 'ship',
  }));
  const byId = new Map(all.map((m) => [m.roomId, m]));
  const seen = new Set<string>();
  const links: HoloLink[] = [];
  for (const m of all) {
    for (const l of m.links) {
      const other = byId.get(l.toRoomId);
      if (!other || other === m) continue;
      const key = [m.roomId, other.roomId].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = at(m), c = at(other);
      links.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, berth: l.berth });
    }
  }
  return { scale, modules, links };
}

/** Seconds the plot shows, then the station, and the fade between. */
export const PLOT_SECONDS = 16;
export const STATION_SECONDS = 10;
export const FADE_SECONDS = 1;

export type HoloMode = 'plot' | 'station';

/**
 * Which picture the hologram shows `t` seconds into its cycle, and how far
 * in it is (0 = just gone, 1 = fully shown): the plot for PLOT_SECONDS,
 * the station for STATION_SECONDS, each fading in and out over
 * FADE_SECONDS. With no station to show (`withStation` false) the plot
 * stays, fully shown.
 */
export function holoModeAt(t: number, withStation = true): { mode: HoloMode; fade: number } {
  if (!withStation) return { mode: 'plot', fade: 1 };
  const cycle = PLOT_SECONDS + STATION_SECONDS;
  const u = ((t % cycle) + cycle) % cycle;
  const [mode, start, span]: [HoloMode, number, number] = u < PLOT_SECONDS
    ? ['plot', 0, PLOT_SECONDS]
    : ['station', PLOT_SECONDS, STATION_SECONDS];
  const into = u - start;
  const fade = Math.max(0, Math.min(1, into / FADE_SECONDS, (span - into) / FADE_SECONDS));
  return { mode, fade };
}
