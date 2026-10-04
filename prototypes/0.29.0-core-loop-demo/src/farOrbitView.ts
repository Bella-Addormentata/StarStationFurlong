/**
 * 🔭 The far pass — a perspective backdrop behind the isometric station
 * (owner ask, 2026-09-27; geometry in farOrbits.ts).
 *
 * While the exterior view is up, each frame is drawn in three passes:
 *   1. the main scene's SKY only (nebula + stars, on SKY_LAYER), through the
 *      game's orthographic camera — the backdrop it always had;
 *   2. the FAR scene through a perspective camera that copies the ortho
 *      camera's orientation (so the rig's 45° detents and the slow drift turn
 *      it too) and sits EYE_DISTANCE behind the viewer: the planet at its
 *      true size off the station's −X, every known orbit ring, the other
 *      stations (a box per module) and ships in flight on their transfers;
 *   3. the main scene WITHOUT the sky, depth cleared, so the isometric station
 *      always sits on top — unchanged from before.
 * Outside the exterior view `renderWithFarPass` is one plain render.
 *
 * Distant bodies are impostors at a fixed SCREEN size (a real station 2,000 km
 * off is far below a pixel): each frame their scale follows their distance.
 * Their places are exact angles on the shared clock with compressed
 * altitudes (farOrbits.ts); what is known about them comes from the station
 * list and the per-planet summary (planetSummary.ts) — never another
 * station's full atlas.
 *
 * A station moving between planets shows the sun's frame instead
 * (farOrbits.transitLayout): the old planet is gone from outside the windows
 * until the station arrives.
 */

import * as THREE from 'three';
import {
  angleAt,
  orbitForSlot,
  stationOrbit,
  stationPointAt,
  transferPointAt,
  wrapAngle,
} from './orbits';
import type { OrbitPoint, TransferPlan } from './orbits';
import { frozenCourse, planetLayout, transitLayout } from './farOrbits';
import type { FarBody, FarLayout, FarShipInput, FarStationInput, FrozenCourses } from './farOrbits';
import { readStore } from './planetSummary';
import { isPinMove, moveTransitPointAt, stationPointWithMoveAt } from './stationMove';
import { isShipReady } from './devices';
import { readPhysicalDoors } from './doorsDoc';
import { shipDocBound } from './shipDoc';
// 🕹️ Ships flown by hand (issue 203): this one's pose, and others' coasted on.
import type { FreePose } from './freeFlight';
import { remoteFreeShips, resolvedFreePose, stationFlyingFree } from './freeFlightPilot';
// 🚏 A ferry route's leg is flown by its timetable, never written to the
// stored flight (robot pilot routes, build notes A4): the resolved flight.
import { routeStayOffList } from './pilotRoute';
import { resolveShipFlight } from './shipRoute';
// 🚚 Another ferry's leg, where its summary says the route copied its stops.
import { routeLegEnds, routeStayPlace, summaryLegEnds } from './planetSummary';
import { flightCapable, followsFlightRecord, groundedBy } from './stationDirectory';
import { MAX_ENTRIES, atlasComponents, atlasLayout, readAtlas } from './stationAtlas';
import {
  adriftAt, adriftPlace, altitudeChangesSince, orbitChangeBase, currentRoomId, currentStation, dockedStationFor, latestMoveOf, listStations, planetById,
  planetForRoom, roomAdriftPlace, stationInTransit,
} from './stations';
import type { StationMove, StationRecord } from './stations';

/** The main scene's sky objects also live on this layer, so pass 1 can draw
 *  them alone (tagged on first use). */
export const SKY_LAYER = 1;
/** Names renderer.ts gives the sky objects. */
const SKY_NAMES = new Set(['nebula-sky', 'nebula-stars']);
/** world.ts's older planet backdrops (the one seen through room windows and
 *  the outdoor deck's overhead planet): hidden while the far pass draws the
 *  real planet, or they would sit on top of it. */
const OLD_PLANET_NAMES = ['ambientPlanet', 'ambientPlanetGlow', 'deckPlanet'];

/** How far behind the viewer the far camera sits, in compressed km. Frames
 *  the nearest rings and the planet's limb around the station. */
const EYE_DISTANCE = 14_000;
const FOV_DEG = 40;
/** On-screen sizes, CSS px. */
const MODULE_PX = 7;
const SHIP_PX = 9;
const PLANET_PX = 16;
const SUN_PX = 30;
/** Boxes per row of a station impostor; bigger stations wrap to more rows.
 *  Every module gets a box (a station's count is bounded by the atlas cap,
 *  stationAtlas.MAX_ENTRIES, and every box shares one geometry and material). */
const MODULES_PER_ROW = 8;
/** How often the list of what is out there is re-read, real ms. */
const REFRESH_MS = 1000;

const RING_COLOR = 0x9fd4ff;
const PATH_COLOR = 0xffa040;
const STATION_COLOR = 0xd8e2ee;
const SHIP_COLOR = 0xffa040;

// ── What is out there (re-read every REFRESH_MS) ────────────────────────────

type Source =
  | {
      mode: 'planet';
      planetId: string;
      viewer: (ms: number) => OrbitPoint;
      viewerRingRadiusKm?: number;
      stations: Array<{ record: StationRecord; modules: number }>;
      ships: FarShipInput[];
      key: string;
      /** See stationYaw. */
      yaw: number;
    }
  | { mode: 'sun'; move: StationMove; key: string; yaw: number };

/** The far frame is the station's (its welcome room's): the iso scene is
 *  drawn in the current room's, which atlasLayout anchors at zero yaw, so a
 *  room turned against the welcome room turns the planet with it. Zero when
 *  the welcome room is out of reach (or is the current room). */
function stationYaw(welcomeRoomId: string | undefined, roomId: string | undefined): number {
  if (!welcomeRoomId || !roomId || welcomeRoomId === roomId) return 0;
  return atlasLayout(roomId, MAX_ENTRIES).find((p) => p.roomId === welcomeRoomId)?.rotY ?? 0;
}

/** Where a flight record's location is: a station, or open orbit (174's
 *  adrift:<planet>:<slot>, where a ship waits once its station has left). */
type Place = Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot' | 'orbit'>;

/** A flight's end as it was when the ship left (`leftAt`): a station that
 *  has moved to another planet since then is still at its old slot for the
 *  flight, as shipArrival.ts reads it (the ship arrives in open orbit there).
 *  A pin stands for the move it settles; a cancel pin is no move at all. */
function placeOf(id: string | undefined, all: readonly StationRecord[], leftAt?: number, now = Date.now()): Place | undefined {
  if (!id) return undefined;
  const station = all.find((s) => s.id === id);
  if (station) {
    // The remembered move, not the record's: listStations drops a move once
    // it has arrived, and a ship that left before it still flies the old orbit.
    const latest = latestMoveOf(station) ?? station.move;
    const moved = !latest ? undefined
      : !latest.settles ? latest
      : latest.departAt < latest.settles.arriveAt ? undefined
      : latest.settles;
    if (moved && leftAt !== undefined && moved.arriveAt > leftAt && moved.departAt <= now && betweenPlanets(moved)) {
      // 🎚️ At the altitude it flew there when the ship left: the orbit an
      // altitude change since then left, else the one this move left.
      const climb = altitudeChangesSince(station, leftAt, now)[0]?.orbit;
      const orbit = climb ? orbitChangeBase(climb)
        : moved.fromOrbit ? { radiusKm: moved.fromOrbit.radiusKm, phase0: moved.fromOrbit.phase0 } : undefined;
      return { id: station.id, planetId: planetById(moved.fromPlanetId).id, orbitSlot: moved.fromSlot, ...(orbit ? { orbit } : {}) };
    }
    // 🎚️ Likewise an altitude change since the ship left, found among every
    // move known (a later booking can hide it from the latest): the flight
    // was planned to the orbit the station flew then.
    const climbed = leftAt !== undefined ? altitudeChangesSince(station, leftAt, now)[0]?.orbit : undefined;
    if (climbed) {
      return {
        id: station.id, planetId: station.planetId, orbitSlot: station.orbitSlot,
        orbit: orbitChangeBase(climbed),
      };
    }
    return station;
  }
  const adrift = adriftPlace(id);
  return adrift ? { id, planetId: planetById(adrift.planetId).id, orbitSlot: adrift.orbitSlot } : undefined;
}

/** A flight's end where it orbited at cast-off (the record's originAt or
 *  destinationAt, as shipArrival.ts reads them): however many moves the
 *  station made since (only the latest is remembered), that is where the ship
 *  left from or flies to. Under the station's own id, so its trim still
 *  applies while it flies that slot (a trim names the slot it is for).
 *  Undefined when the record kept none. */
function castOffPlace(
  id: string, keptAt: string | undefined, all: readonly StationRecord[], leftAt: number, now: number,
): Place | undefined {
  const at = keptAt ? adriftPlace(keptAt) : null;
  if (!at) return undefined;
  const place: Place = { id, planetId: planetById(at.planetId).id, orbitSlot: at.orbitSlot };
  // 🎚️ The record keeps only the slot: the altitude the station flew there
  // at cast-off is the one placeOf finds (its orbit then, climbs since undone).
  const then = placeOf(id, all, leftAt, now);
  return then?.orbit && planetById(then.planetId).id === place.planetId && then.orbitSlot === place.orbitSlot
    ? { ...place, orbit: then.orbit } : place;
}

/** A flight's transfer rebuilt from its record, fixed once seen
 *  (farOrbits.frozenCourse). `flight` names it by what stays fixed while it
 *  flies: who flies (and for another ship, the welcome rooms its summary
 *  gives as the ends), never an id this install reads through its own
 *  aliases, which can name one end differently from one read to the next. A
 *  ferry leg's `copies` of its stops place it when known. */
function flightPlan(
  flight: readonly string[],
  departedAt: number,
  etaAt: number,
  copies: readonly [Place, Place] | null,
  ends: () => readonly [Place | undefined, Place | undefined],
): TransferPlan | null {
  return frozenCourse(frozenPlans, flight, departedAt, etaAt, copies, ends, gatherNow);
}

/** Flight plans already drawn, by flight; one not seen for a while is dropped. */
const frozenPlans: FrozenCourses = new Map();
const FROZEN_PLAN_TTL_MS = 60_000;
const MAX_FROZEN_PLANS = 256;
let gatherNow = 0;

function pruneFrozenPlans(now: number): void {
  for (const [key, entry] of frozenPlans) {
    if (now - entry.seenAt > FROZEN_PLAN_TTL_MS || frozenPlans.size > MAX_FROZEN_PLANS) frozenPlans.delete(key);
  }
}

/** Between planets right now. A stay-put pin move (stationMove.isPinMove,
 *  written after an arrival) is a station settled at its slot, never a
 *  transfer. */
function reallyMoving(s: StationRecord, now: number): boolean {
  // Only a move with a real course right now: a malformed record (both ends
  // on one planet, say) leaves the station at its slot (listStations), so it
  // is drawn there, never hidden and never given a sun view.
  return !!s.move && !isPinMove(s.move) && stationInTransit(s, now)
    && betweenPlanets(s.move) && moveTransitPointAt(s.move, now) !== null;
}

/** A move whose ends are two different planets, once unknown ids read as
 *  the default planet: a record naming one planet twice has no course. */
function betweenPlanets(m: StationMove): boolean {
  return planetById(m.fromPlanetId).id !== planetById(m.toPlanetId).id;
}

/** Modules to draw for a station: the rooms of its atlas component that
 *  the (capped) atlas actually holds. A component also names door targets
 *  with no entry, which peers control, so those never count. */
function modulesOf(station: StationRecord, components: Set<string>[], atlas: Record<string, unknown>): number {
  if (!station.welcomeRoomId) return 1;
  const component = components.find((c) => c.has(station.welcomeRoomId));
  if (!component) return 1;
  let n = 0;
  for (const roomId of component) if (Object.prototype.hasOwnProperty.call(atlas, roomId)) n++;
  return Math.min(MAX_ENTRIES, Math.max(1, n));
}

/** What is out there now. Old plans are dropped after the read, not before
 *  it, so a flight it looks up is kept however long the far pass was off. */
function gather(now: number): Source {
  gatherNow = now;
  try {
    return readSource(now);
  } finally {
    pruneFrozenPlans(now);
  }
}

/** Test seam: what the far pass reads at `now`. */
export function gatherForTest(now: number): Source {
  return gather(now);
}

/** Test seam: forget every flight already drawn. */
export function forgetFlightsForTest(): void {
  frozenPlans.clear();
}

function readSource(now: number): Source {
  const roomId = currentRoomId();
  const atlas = readAtlas();
  const all = listStations(atlas);
  const components = atlasComponents(atlas);

  // Aboard a ship in flight: see the planet from the transfer.
  // Every room binds a ship doc, so a flight record alone proves nothing: the
  // room follows its record only as main.ts's room resolver has it
  // (followsFlightRecord: never a station's own room, a docked record only
  // while the room may fly, and a flight under way whatever fitting comes off
  // mid-trip).
  let aboard: TransferPlan | null = null;
  // Aboard a ship in open orbit (waiting where its destination station left,
  // or resting there): see the planet from that orbit, not from the ship's
  // own one-room station.
  let adrift: Place | null = null;
  // Aboard a ship flown by hand: see the planet from where it flies.
  let free: FreePose | null = null;
  // 🚏 A running ferry route's timetable while it rules the flight (its legs
  // write no stored `flight`), else the stored record.
  const resolved = shipDocBound() ? resolveShipFlight(now) : null;
  const rec = resolved?.flight ?? null;
  const places = resolved?.places ?? null;
  // 🕹️ Flown by hand, a one-module station's own room follows its pose too
  // (freeFlightCapable), and a ship that lost a part it flies by still coasts.
  const flownFree = rec?.status === 'free-flight' && [null, 'lone-station'].includes(groundedBy());
  if (rec && (flownFree || followsFlightRecord(rec.status, flightCapable(isShipReady())))) {
    if (rec.status === 'in-flight' && rec.destinationId && rec.departedAt !== undefined && rec.etaAt !== undefined) {
      const leftAt = rec.castOffAt ?? rec.departedAt;
      const to = rec.destinationId;
      // 🚚 The timetable's legs fly the route's own copy of each stop, which
      // a stop's station may have left for another planet: those are its
      // ends, untrimmed as the timetable planned them. An ordinary flight's
      // ends go by their stations' ids, so their trims apply.
      // Named by the room, not the ends: readFlightRecord reads both end ids
      // through this install's aliases each time (a learned station listed,
      // then dropped), and the same flight must keep the course it was drawn on.
      aboard = flightPlan(['own', roomId], rec.departedAt, rec.etaAt, routeLegEnds(places), () => [
        castOffPlace(rec.locationId, rec.originAt, all, leftAt, now) ?? placeOf(rec.locationId, all, leftAt, now),
        castOffPlace(to, rec.destinationAt, all, leftAt, now) ?? placeOf(to, all, leftAt, now),
      ]);
      // Kept through every leg: a ship casts off before its launch window,
      // and transferPointAt holds it on the source orbit while it waits (and
      // on the target orbit once it is there) until it docks.
    }
    if (rec.status === 'free-flight') free = resolvedFreePose(now);
    // A docked record's location can still name open orbit after a dock by
    // hand from there: its live dock, or where it rests, says where it is
    // (the room resolver, below).
    if (!aboard && !free && rec.status !== 'docked' && adriftPlace(rec.locationId)) adrift = placeOf(rec.locationId, all) ?? null;
    // 🚚 A timetable stay with no live dock carrying the ship along with a
    // station: it waits on the route's copy of the stop, where its leg in
    // ended and its next leg leaves from, untrimmed as they are, whether or
    // not the stop's station is still there (the keeper passes a berth its
    // station has left). Only a live dock puts it on the station's orbit:
    // one on the room's own doors, each read past the snapshot's cap, as the
    // room resolver reads it (doorsDoc.readPhysicalDoors).
    if (!aboard && !adrift && !free && places && !places.to) {
      const stay = routeStayOffList(
        places,
        dockedStationFor(roomId, readPhysicalDoors().values(), atlas, all) !== null,
        (id) => planetById(id).id,
      );
      adrift = stay && routeStayPlace(stay);
    }
    // Redocking: the ship has arrived where its destination was when it cast
    // off (destinationAt), which a move since then has left: it stays on that
    // orbit until the dock completes, not at the station's new place.
    if (!aboard && !adrift && !free && rec.status === 'redocking') {
      const castOffAt = rec.castOffAt ?? rec.departedAt;
      const place = (castOffAt !== undefined ? castOffPlace(rec.locationId, rec.destinationAt, all, castOffAt, now) : undefined)
        ?? placeOf(rec.locationId, all, castOffAt, now);
      const station = all.find((s) => s.id === rec.locationId);
      // A destination still in transit is listed at its origin until it arrives,
      // so a matching slot proves nothing: the ship stays on its own orbit.
      // 🎚️ So does an altitude change, under way or done: the ship reached
      // the orbit it left, which the station no longer flies.
      const sameOrbit = !!station && !station.orbit === !place?.orbit && (!station.orbit || !place?.orbit
        || (Math.abs(station.orbit.radiusKm - place.orbit.radiusKm) < 1e-6
          && Math.abs(wrapAngle(station.orbit.phase0 - place.orbit.phase0)) < 1e-9));
      if (place && (!station || reallyMoving(station, now) || stationInTransit(station, now) || !sameOrbit
        || planetById(station.planetId).id !== place.planetId || station.orbitSlot !== place.orbitSlot)) {
        adrift = place;
      }
    }
  }
  // Anywhere else the room resolver puts this room in open orbit (main.ts's,
  // through shipArrival.shipPlaceId): a ship resting there after letting go of
  // its dock, say. Its own one-room stand-in is no place to see it from.
  if (!aboard && !adrift && !free) {
    const open = roomAdriftPlace(roomId);
    if (open) adrift = { id: adriftAt(open.planetId, open.orbitSlot), ...open };
  }

  // Not in a known station (offline, or before the first join): stand in
  // for the planet's slot-0 station, so it is not drawn as a neighbour on
  // top of the viewer.
  const me = aboard || adrift || free
    ? null
    : currentStation() ??
      all.find((s) => planetById(s.planetId).id === planetForRoom(roomId, atlas).id && s.orbitSlot === 0 && !reallyMoving(s, now)) ??
      null;
  // The sun view only while the move really has a course right now (a
  // malformed record, say both ends on one planet, has none): otherwise the
  // planet view below, never an empty backdrop.
  const yaw = me ? stationYaw(me.welcomeRoomId, roomId) : 0;
  if (me && reallyMoving(me, now) && me.move) {
    const m = me.move;
    // JSON, not a joined string: ids come from peers and may hold any delimiter.
    return { mode: 'sun', move: m, yaw, key: JSON.stringify([
        'sun', m.welcomeRoomId, m.mode, m.fromPlanetId, m.fromSlot, m.toPlanetId, m.toSlot, m.departAt, m.arriveAt,
      ]) };
  }

  const planetId = aboard
    ? aboard.from.planet.id
    : free
      ? planetById(free.planetId).id
    : adrift
      ? adrift.planetId
      : me
      ? planetById(me.planetId).id
      : planetForRoom(roomId, atlas).id;
  let viewer: (ms: number) => OrbitPoint;
  let viewerRingRadiusKm: number | undefined;
  if (aboard) {
    const plan = aboard;
    viewer = (ms) => transferPointAt(plan, ms);
  } else if (free) {
    // The pose is read again each frame: the stick moves it between gathers.
    let last: OrbitPoint = { radiusKm: free.radiusKm, angle: free.angle };
    viewer = (ms) => {
      const p = resolvedFreePose(ms);
      if (p) last = { radiusKm: p.radiusKm, angle: p.angle };
      return last;
    };
  } else if (adrift) {
    const place = adrift;
    viewer = (ms) => stationPointAt(place, ms);
    viewerRingRadiusKm = stationOrbit(place).radiusKm;
  } else if (me) {
    const station = me;
    // 🎚️ On its altitude change's course while it flies one.
    viewer = (ms) => stationPointWithMoveAt(station, ms);
    viewerRingRadiusKm = stationOrbit(me).radiusKm;
  } else {
    const orbit = orbitForSlot(planetId, 0);
    viewer = (ms) => ({ radiusKm: orbit.radiusKm, angle: angleAt(orbit, ms) });
    viewerRingRadiusKm = orbit.radiusKm;
  }

  const idOf = (room: string) => all.find((s) => s.welcomeRoomId === room)?.id;
  const byRoom = (room: string | undefined, leftAt: number) =>
    placeOf(room ? idOf(room) : undefined, all, leftAt, now);
  const ships: FarShipInput[] = [];
  // Every known ship anywhere, flying or docked: its room is also listed as a
  // one-module station (a dock berth leaves it its own atlas component), which
  // may sit around another planet than the ship, so it is hidden in every
  // view, not only its own planet's. Only flights are drawn, on their courses.
  const flying = new Set<string>();
  const known = Object.values(readStore(now).ships).filter((ship) => !ship.retired);
  for (const ship of known) flying.add(ship.roomId);
  const inFlight = known.filter((ship) => ship.status === 'in-flight');
  // Each flight is placed by its own plan's planet, not the summary's
  // planetId: that follows the origin station's current record, which a
  // move since the ship left has taken to another planet.
  for (const ship of inFlight) {
    if (ship.roomId === roomId) continue;
    const { fromRoom, toRoom, departedAt } = ship;
    if (!fromRoom || !toRoom || departedAt === undefined || ship.etaAt === undefined) continue;
    // 🚚 A ferry's leg flies the route's copy of its two stops, which its
    // summary carries: a stop's station may have moved planets since, where
    // the station list would place it (untrimmed, as its timetable planned
    // them). A summary without them (relayed by an older client) is drawn
    // by the station list until one with them comes.
    const plan = flightPlan(['ship', ship.roomId, fromRoom, toRoom], departedAt, ship.etaAt, summaryLegEnds(ship), () => [
      byRoom(fromRoom, departedAt),
      byRoom(toRoom, departedAt),
    ]);
    if (!plan || plan.from.planet.id !== planetId) continue;
    // Only ships on their transfer right now: the gather re-runs every
    // REFRESH_MS, so a ship joins the key at departure and leaves it at
    // arrival, and the static frame is rebuilt at both.
    if (transferPointAt(plan, now).leg === 'transfer') {
      ships.push({ id: `ship:${ship.roomId}`, name: ship.name, plan });
    }
  }

  // 🕹️ Ships flown by hand, where their last pose has coasted to (with the
  // zone rules, as every other reader coasts them).
  for (const ship of remoteFreeShips(planetId, now)) {
    ships.push({
      id: `ship:${ship.roomId}`,
      name: ship.name,
      at: (ms) => {
        const p = ship.at(ms);
        return { radiusKm: p.radiusKm, angle: p.angle };
      },
    });
  }

  const stations = all
    // Never the viewer: its own station, nor the one-module station the room
    // it stands in (a ship, say) is listed as.
    .filter((s) => s.id !== me?.id && !(roomId && s.welcomeRoomId === roomId))
    // A ship is listed as its own one-module station too; a flying one is
    // drawn on its transfer instead, a docked one not at all. A saved or
    // built-in station that flew by itself (Fly and park) is no station
    // while it flies free (remembered past its summary, until a move of its
    // own is booked: stationFlyingFree), drawn as a ship while its summary
    // lasts; parked, it is one again.
    .filter((s) => !stationFlyingFree(s, now) && (!flying.has(s.welcomeRoomId) || !s.derived))
    .filter((s) => planetById(s.planetId).id === planetId && !reallyMoving(s, now))
    .map((record) => ({ record, modules: modulesOf(record, components, atlas) }));

  const key = JSON.stringify([
    'planet',
    planetId,
    viewerRingRadiusKm ?? 'x',
    // Everything buildFrame draws once: ring radii (a trim moves a ring
    // without changing its slot), names, module counts and each course.
    ...stations.map((s) => [s.record.id, stationOrbit(s.record).radiusKm.toFixed(3), s.modules, s.record.name]),
    ...ships.map((s) => s.plan ? [
      s.id, s.name, s.plan.departAt, s.plan.arriveAt,
      s.plan.from.radiusKm.toFixed(3), s.plan.from.phase0, s.plan.to.radiusKm.toFixed(3), s.plan.to.phase0,
    ] : [s.id, s.name, 'free']),
  ]);
  return { mode: 'planet', planetId, viewer, viewerRingRadiusKm, stations, ships, key, yaw };
}

/** The layout now; `withPaths` samples the courses too, which only a
 *  rebuild of the static geometry needs. */
function layoutFor(source: Source, now: number, withPaths: boolean): FarLayout | null {
  if (source.mode === 'sun') return transitLayout(source.move, now, withPaths);
  const stations: FarStationInput[] = source.stations.map(({ record, modules }) => ({
    id: record.id,
    name: record.name,
    point: stationPointWithMoveAt(record, now),
    ringRadiusKm: stationOrbit(record).radiusKm,
    modules,
  }));
  return planetLayout({
    planetId: source.planetId,
    nowMs: now,
    viewer: source.viewer(now),
    viewerRingRadiusKm: source.viewerRingRadiusKm,
    stations,
    ships: source.ships,
    withPaths,
  });
}

// ── The far scene ────────────────────────────────────────────────────────────

let active = false;
let farScene: THREE.Scene | null = null;
let farCamera: THREE.PerspectiveCamera | null = null;
/** The planet (or sun) frame, re-posed each frame so the viewer sits at the
 *  origin, planet-locked. */
let frame: THREE.Group | null = null;
let sunLight: THREE.DirectionalLight | null = null;
let source: Source | null = null;
let builtKey = '';
let lastRefresh = 0;
/** OLD_PLANET_NAMES found in the scene, re-found after a refresh. */
let oldPlanets: THREE.Object3D[] | null = null;
/** Bodies are keyed by kind AND id: a station's id is free text and could
 *  equal a ship's `ship:<room>`. */
const bodyKey = (b: FarBody): string => `${b.kind}\u0000${b.id}`;
/** Screen-sized objects: body key → [object, px per local unit]. */
const bodies = new Map<string, { obj: THREE.Object3D; px: number }>();

function ensureScene(): void {
  if (farScene) return;
  farScene = new THREE.Scene();
  farCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 10, 2_000_000);
  farScene.add(new THREE.AmbientLight(0xffffff, 0.35));
  sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  farScene.add(sunLight);
  farScene.add(sunLight.target);
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const d = c as THREE.Mesh;
    d.geometry?.dispose?.();
    const mats = d.material ? (Array.isArray(d.material) ? d.material : [d.material]) : [];
    for (const m of mats) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  });
}

function clearFrame(): void {
  if (frame && farScene) {
    farScene.remove(frame);
    disposeTree(frame);
  }
  frame = null;
  bodies.clear();
  builtKey = '';
}

function labelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = 'bold 28px system-ui, sans-serif';
  let w = 256;
  if (ctx) {
    ctx.font = font;
    w = Math.ceil(ctx.measureText(text).width) + 16;
  }
  canvas.width = w;
  canvas.height = 40;
  if (ctx) {
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 8, 20);
    ctx.fillStyle = color;
    ctx.fillText(text, 8, 20);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  // Height 2 local units; the body's per-frame scale sets the pixels.
  sprite.scale.set((2 * canvas.width) / canvas.height, 2, 1);
  sprite.center.set(0, 0);
  return sprite;
}

function circle(radius: number, color: number, opacity: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  const n = 256;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(radius * Math.cos(a), 0, -radius * Math.sin(a)));
  }
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

function stationImpostor(body: FarBody): THREE.Object3D {
  const g = new THREE.Group();
  const n = body.modules;
  const perRow = Math.min(MODULES_PER_ROW, n);
  const rows = Math.ceil(n / perRow);
  const geo = new THREE.BoxGeometry(1, 0.8, 1);
  const mat = new THREE.MeshStandardMaterial({ color: STATION_COLOR, roughness: 0.6, metalness: 0.3, emissive: 0x223344 });
  // Rows of modules along the direction of travel (local −Z), stacked
  // outward (+X), centred.
  for (let i = 0; i < n; i++) {
    const box = new THREE.Mesh(geo, mat);
    box.position.z = -((i % perRow) - (perRow - 1) / 2) * 1.25;
    box.position.x = (Math.floor(i / perRow) - (rows - 1) / 2) * 1.25;
    g.add(box);
  }
  return g;
}

function shipImpostor(): THREE.Object3D {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.4, 8),
    new THREE.MeshBasicMaterial({ color: SHIP_COLOR }),
  );
  cone.rotation.x = -Math.PI / 2; // nose toward −Z, prograde
  const g = new THREE.Group();
  g.add(cone);
  return g;
}

function sphereImpostor(color: number, emissive = false): THREE.Object3D {
  const mat = emissive
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), mat));
  return g;
}

function buildFrame(layout: FarLayout): void {
  clearFrame();
  if (!farScene) return;
  frame = new THREE.Group();
  frame.name = 'far-orbit-frame';

  if (layout.planet) {
    const p = layout.planet;
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(p.radiusKm, 96, 64),
      new THREE.MeshStandardMaterial({
        color: p.color,
        roughness: 0.9,
        metalness: 0.05,
        emissive: p.emissive,
        emissiveIntensity: 0.35,
      }),
    );
    planet.name = 'far-planet';
    frame.add(planet);
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(p.radiusKm * 1.025, 96, 64),
      new THREE.MeshBasicMaterial({ color: p.atmosphere, transparent: true, opacity: 0.12, side: THREE.BackSide }),
    );
    frame.add(atmo);
  }

  for (const r of layout.rings) frame.add(circle(r.radius, RING_COLOR, r.own ? 0.7 : 0.3));
  for (const path of layout.paths) {
    const pts = path.points.map((q) => new THREE.Vector3(q.x, q.y, q.z));
    frame.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: PATH_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
      ),
    );
  }

  for (const b of layout.bodies) {
    let obj: THREE.Object3D;
    let px: number;
    if (b.kind === 'station') {
      obj = stationImpostor(b);
      px = MODULE_PX;
    } else if (b.kind === 'ship') {
      obj = shipImpostor();
      px = SHIP_PX;
    } else if (b.kind === 'sun') {
      obj = sphereImpostor(0xfff2c0, true);
      px = SUN_PX;
    } else {
      obj = sphereImpostor(planetById(b.id).color);
      px = PLANET_PX;
    }
    const label = labelSprite(b.name, b.kind === 'ship' ? '#ffc080' : '#e8f2ff');
    label.position.set(0.8, 0.8, 0);
    obj.add(label);
    obj.name = `far-body-${b.id}`;
    frame.add(obj);
    bodies.set(bodyKey(b), { obj, px });
  }

  farScene.add(frame);
}

/** Move everything to where it is now. */
function poseFrame(layout: FarLayout, yaw: number): void {
  if (!frame) return;
  // The layout is in the station's frame; turn it (about the viewer, the
  // origin) into the current room's, with the sun turned the same way.
  const p = layout.transform.position;
  frame.position.set(p.x, p.y, p.z).applyAxisAngle(UP, yaw);
  frame.rotation.set(0, layout.transform.rotationY + yaw, 0);
  for (const b of layout.bodies) {
    const entry = bodies.get(bodyKey(b));
    if (!entry) continue;
    entry.obj.position.set(b.position.x, b.position.y, b.position.z);
    // Line the impostor up with its orbit (rotation.y = its orbit angle puts
    // its local −Z along the direction of travel, as for a station).
    entry.obj.rotation.set(0, b.angle, 0);
  }
  if (sunLight) {
    const d = layout.sunDirection;
    sunLight.position.set(d.x * 1e5, d.y * 1e5, d.z * 1e5).applyAxisAngle(UP, yaw);
    sunLight.target.position.set(0, 0, 0);
  }
}

const tmp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Keep every impostor at its on-screen size. */
function sizeBodies(heightPx: number): void {
  if (!farCamera) return;
  const perPxAt1 = (2 * Math.tan(THREE.MathUtils.degToRad(farCamera.fov) / 2)) / Math.max(1, heightPx);
  for (const { obj, px } of bodies.values()) {
    obj.getWorldPosition(tmp);
    // Camera-space depth, not distance: a perspective projection scales
    // by depth, so an off-axis body keeps its size as the view drifts.
    const d = Math.max(1, -tmp.applyMatrix4(farCamera.matrixWorldInverse).z);
    obj.scale.setScalar(d * perPxAt1 * px);
  }
}

function update(renderer: THREE.WebGLRenderer, ortho: THREE.Camera): void {
  ensureScene();
  const now = Date.now();
  // A move's capture burn is a boundary too: re-read at once so the view
  // swaps to the new planet instead of going blank until the next refresh.
  const arrived = source?.mode === 'sun' && now >= source.move.arriveAt;
  if (!source || arrived || now - lastRefresh >= REFRESH_MS) {
    try {
      source = gather(now);
    } catch (err) {
      console.warn('far orbit view: could not read the stations', err);
    }
    lastRefresh = now;
  }
  const rebuild = !!source && source.key !== builtKey;
  const layout = source ? layoutFor(source, now, rebuild) : null;
  if (!layout) {
    clearFrame();
  } else {
    if (rebuild && source) {
      buildFrame(layout);
      builtKey = source.key;
    }
    poseFrame(layout, source?.yaw ?? 0);
  }

  const cam = farCamera!;
  const size = renderer.getSize(new THREE.Vector2());
  cam.aspect = size.x / Math.max(1, size.y);
  cam.quaternion.copy(ortho.quaternion);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ortho.quaternion);
  cam.position.copy(forward.multiplyScalar(-EYE_DISTANCE));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  frame?.updateMatrixWorld(true);
  sizeBodies(size.y);
  frame?.updateMatrixWorld(true);
}

// ── Public ───────────────────────────────────────────────────────────────────

/** exteriorView turns the far pass on and off with the space view. */
export function setFarPassActive(on: boolean): void {
  active = on;
  source = null;
  oldPlanets = null;
  if (!on) clearFrame();
}

/** Re-read what is out there on the next frame (room swapped, stations
 *  changed). */
export function refreshFarPass(): void {
  source = null;
  oldPlanets = null;
}

/** The frame's render: one plain render, or sky → far pass → station while
 *  the exterior view is up. */
export function renderWithFarPass(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  if (!active) {
    renderer.render(scene, camera);
    return;
  }
  if (!oldPlanets || oldPlanets.some((o) => !o.parent)) {
    oldPlanets = OLD_PLANET_NAMES.map((n) => scene.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
  }
  const hidden = oldPlanets;
  const hiddenShown = hidden.map((o) => o.visible);
  for (const o of hidden) o.visible = false;
  const sky = scene.children.filter((o) => SKY_NAMES.has(o.name));
  for (const o of sky) o.layers.enable(SKY_LAYER);
  const shown = sky.map((o) => o.visible);
  const background = scene.background;
  const cameraLayers = camera.layers.mask;
  const autoClear = renderer.autoClear;
  try {
    update(renderer, camera);
    // 1. The sky alone (clears with the scene background as usual). A room
    //    shows its nebula only on a deck, so the sky is shown for this pass.
    for (const o of sky) o.visible = true;
    camera.layers.set(SKY_LAYER);
    renderer.render(scene, camera);
    camera.layers.mask = cameraLayers;
    renderer.autoClear = false;
    // 2. The far scene.
    if (farScene && farCamera && frame) {
      renderer.clearDepth();
      renderer.render(farScene, farCamera);
    }
    // 3. The station, on top, without the sky or a clearing background.
    renderer.clearDepth();
    for (const o of sky) o.visible = false;
    scene.background = null;
    renderer.render(scene, camera);
  } finally {
    scene.background = background;
    sky.forEach((o, i) => { o.visible = shown[i]; });
    hidden.forEach((o, i) => { o.visible = hiddenShown[i]; });
    camera.layers.mask = cameraLayers;
    renderer.autoClear = autoClear;
  }
}
