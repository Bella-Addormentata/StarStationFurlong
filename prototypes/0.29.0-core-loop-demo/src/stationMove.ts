/**
 * 🚚 Station moves — a station leaves its planet for another one under its
 * own thrusters (owner ask, 2026-09-27: "stations … should be able to be
 * moved to other planets, perhaps slowly with its own thrusters, or fast with
 * the help of a powerful tug like ship"). Both ways write the same record:
 * `mode: 'thrusters'` from the station's helm, `mode: 'tug'` from a docked
 * tug's helm (see "Tugs" below).
 *
 * TRUE PHYSICS (owner pick, 2026-09-27) on the shared 60× clock: a move is the
 * Hohmann transfer solarOrbits.planPlanetTransfer plans — it leaves only at a
 * launch window (days apart) and takes the textbook time (Sovereign II → Aris
 * Prime: about 50 real hours). Engine blocks must be fitted to burn at all;
 * the burns are priced on delta-v and on the station's size, so a big station
 * needs a lot of propellant. The fast way is the tug.
 *
 * Derive, don't tick: one write schedules the whole move. Where the station is
 * at any moment comes from the record and the clock —
 *   before `departAt`  in its old orbit, and the move is SCHEDULED;
 *   until `arriveAt`   in transit around the sun (interplanetaryPointAt);
 *   after              in its new orbit around the new planet.
 * stations.listStations applies it through the move resolver main.ts installs,
 * so the station list, the holotable and ship travel all follow.
 *
 * The record names the station by its WELCOME ROOM (the same on every
 * install; its id is per install and only informational) and carries where
 * it leaves from, so a later move simply supersedes an earlier one (its
 * `from` is where the last one arrived). Only the latest move per station is
 * kept.
 *
 * Storage: the `stationMoves` map in the HELM ROOM's doc, one entry per
 * move (`move:<clientID>:<departAt>:<station>`; older builds' single record
 * sits under `stationKeeping`'s 'move' key) — shared by
 * everyone in the room. Two moves written at once both land; compareMoves
 * picks the one that flies, the same everywhere, and only its fuel is drawn. Station records are
 * still kept per install, so each install also REMEMBERS every move it has
 * seen (localStorage), keyed by station id: the station stays moved when you
 * walk to another room — and the per-planet summary (planetSummary.ts)
 * carries each station's latest move to every install around the planet.
 *
 * Fuel rides the tank's draw meters, like a trim burn: each entry carries its
 * own fuel, and binding the doc registers their sum (the moves that fly) as
 * the 'stationMove' meter (shipDoc.setFuelDrawMeter). The tank adds it
 * to the trim's, so a trim burn and a move started at once from two tabs
 * both pay.
 *
 * Pure except for the doc binding and the saved list. Pinned by
 * stationMove.test.ts.
 */

import * as Y from 'yjs';
import { ORBIT_EPOCH_MS, orbitalSeconds, realMsFor, wrapAngle } from './orbits';
import type { OrbitPoint } from './orbits';
import { FUEL_METER_MAX, setFuelDrawMeter } from './shipDoc';
import { interplanetaryPointAt, planPlanetTransfer, planetSunPointAt } from './solarOrbits';
import type { InterplanetaryPlan } from './solarOrbits';
import { FUEL_PER_KMS } from './stationDirectory';
import { MAX_ORBIT_SLOTS, PLANETS, moveBelongsTo, planetById, latestMoveOf, setStationMoveResolver, stationForRoom, stationInTransit } from './stations';
import type { MovingStation, StationMove, StationRecord } from './stations';

export type { StationMove } from './stations';

// ── The record ───────────────────────────────────────────────────────────────

const MAX_ID_LENGTH = 128;
/** Times sit between the epoch and a century after it (the trim's bound). */
const MAX_AT_MS = ORBIT_EPOCH_MS + 100 * 365.25 * 24 * 3600 * 1000;

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= ORBIT_EPOCH_MS && v <= MAX_AT_MS;
const isSlot = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_ORBIT_SLOTS;
const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

/** Shape guard — a hostile peer can write anything into the map. */
export function isStationMove(v: unknown): v is StationMove {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof StationMove, unknown>>;
  return isId(r.stationId)
    && typeof r.welcomeRoomId === 'string' && r.welcomeRoomId.length <= MAX_ID_LENGTH
    && isId(r.fromPlanetId) && isSlot(r.fromSlot)
    && isId(r.toPlanetId) && isSlot(r.toSlot)
    && isTime(r.departAt) && isTime(r.arriveAt) && (r.arriveAt as number) > (r.departAt as number)
    && (r.mode === 'thrusters' || (r.mode === 'tug' && isId(r.tugRoomId)))
    && (r.tugRoomId === undefined || isId(r.tugRoomId))
    && (r.bookedAt === undefined || isTime(r.bookedAt))
    // One level only, checked before recursing: a hostile nest is refused
    // at the first step, never walked.
    && (r.settles === undefined || (typeof r.settles === 'object' && r.settles !== null
      && (r.settles as { settles?: unknown }).settles === undefined
      && isStationMove(r.settles) && r.settles.welcomeRoomId === r.welcomeRoomId))
    && typeof r.fuel === 'number' && Number.isInteger(r.fuel) && r.fuel >= 0 && r.fuel <= FUEL_METER_MAX
    && typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX;
}

/** How far ahead a real move can be: the longest wait for a launch window
 *  (4.3 real days between Sovereign and Aris) and the longest trip (about
 *  two real days) each fit well inside it. */
export const MOVE_HORIZON_MS = 7 * 24 * 3_600_000;

/**
 * Could this move have been planned by a helm at or before `nowMs`? The
 * latest departure wins every merge, so a peer's move leaving decades from
 * now would otherwise hold its station "moving" forever. Anything leaving
 * past the horizon, or taking longer than it, is refused wherever a move
 * arrives from outside (room doc, remembered list, planet summary).
 */
export function isPlausibleMove(m: StationMove, nowMs: number = Date.now()): boolean {
  // A pin ranks as the move it settles, so that move must pass too.
  return m.departAt <= nowMs + MOVE_HORIZON_MS && m.arriveAt - m.departAt <= MOVE_HORIZON_MS
    && bookedOf(m) <= nowMs + MOVE_HORIZON_MS
    && (!m.settles || isPlausibleMove(m.settles, nowMs));
}

/** When the move was booked: its own stamp, or (older records) its departure. */
export function bookedOf(m: StationMove): number {
  return m.bookedAt ?? m.departAt;
}

/** Were these two booked at once — each before the other arrived? Moves
 *  booked one after the other never are (a helm books only once the last
 *  move has arrived), however far apart they fly. */
export function concurrentMoves(a: StationMove, b: StationMove): boolean {
  return bookedOf(a) < b.arriveAt && bookedOf(b) < a.arriveAt;
}

/** A move that goes nowhere: it holds a station where it is (a cancelled
 *  tow, or where an arrival settled). */
export function isPinMove(m: StationMove): boolean {
  return !!m.settles || (m.fromPlanetId === m.toPlanetId && m.fromSlot === m.toSlot);
}

function compareFlown(a: StationMove, b: StationMove): number {
  if (a.departAt !== b.departAt) return a.departAt - b.departAt;
  const sa = JSON.stringify(cleanMove(a));
  const sb = JSON.stringify(cleanMove(b));
  return sa === sb ? 0 : sa > sb ? 1 : -1;
}

/** One total order on a station's moves, the same on every client: the
 *  later departure wins, and two leaving the same millisecond are told apart
 *  by their serialized records. A pin ranks as the move it settles, just
 *  after it (pins of one move by their records): a pin never lifts a move
 *  that lost to a concurrent one over the winner. Positive when `a` wins. */
export function compareMoves(a: StationMove, b: StationMove): number {
  const by = compareFlown(a.settles ?? a, b.settles ?? b);
  if (by !== 0) return by;
  if (!a.settles !== !b.settles) return a.settles ? 1 : -1;
  if (!a.settles) return 0;
  // Two pins of one move: a cancel (it leaves before that move arrives)
  // beats a pin of where the move arrived, whatever each replica saw first.
  if (isCancelPin(a) !== isCancelPin(b)) return isCancelPin(a) ? 1 : -1;
  return compareFlown(a, b);
}

/** A pin that undoes the move it settles (cancelTowLeftBehind) rather than
 *  saying where it arrived: it leaves before that move arrives. */
export function isCancelPin(m: StationMove): boolean {
  return !!m.settles && m.departAt < m.settles.arriveAt;
}

/** Only the fields a move has — what a write publishes. */
export function cleanMove(m: StationMove): StationMove {
  return {
    stationId: m.stationId,
    welcomeRoomId: m.welcomeRoomId,
    fromPlanetId: m.fromPlanetId,
    fromSlot: m.fromSlot,
    toPlanetId: m.toPlanetId,
    toSlot: m.toSlot,
    departAt: m.departAt,
    arriveAt: m.arriveAt,
    mode: m.mode,
    fuel: m.fuel,
    fuelDrawn: m.fuelDrawn,
    ...(m.mode === 'tug' && m.tugRoomId ? { tugRoomId: m.tugRoomId } : {}),
    ...(typeof m.bookedAt === 'number' ? { bookedAt: m.bookedAt } : {}),
    ...(m.settles ? { settles: cleanMove({ ...m.settles, settles: undefined }) } : {}),
  };
}

export type MovePhase = 'scheduled' | 'transit' | 'arrived';

export function movePhase(move: StationMove, realMs: number): MovePhase {
  if (realMs < move.departAt) return 'scheduled';
  return realMs < move.arriveAt ? 'transit' : 'arrived';
}

/** The interplanetary plan a thruster move follows, rebuilt from its record:
 *  the same sun orbits, pinned to the record's own departure. (A tow flies a
 *  straight torch course instead: towPointAt.) */
export function movePlan(move: StationMove): InterplanetaryPlan | null {
  if (move.mode !== 'thrusters') return null;
  const plan = planPlanetTransfer(
    { id: move.stationId, planetId: move.fromPlanetId, orbitSlot: move.fromSlot },
    { id: `${move.stationId}@${move.toPlanetId}`, planetId: move.toPlanetId, orbitSlot: move.toSlot },
    move.departAt,
  );
  if (!plan) return null;
  return { ...plan, departAt: move.departAt, arriveAt: move.arriveAt, waitMs: 0, transferMs: move.arriveAt - move.departAt };
}

// ── Planning a move ──────────────────────────────────────────────────────────

/** Why a move will not go, in the order the helm checks. */
export type MoveRefusal =
  | 'not-bolted' // the helm's module is no longer station structure
  | 'no-station' // the atlas does not place this module in a station yet
  | 'not-commander' // only the module's owner moves the station
  | 'moving' // a move is already scheduled or under way
  | 'same-planet' // already there: use the trim stick
  | 'no-slot' // every orbit around the destination is taken
  | 'no-thrusters' // no engine block on this module
  | 'unknown-layout' // this install does not know the station's modules yet
  | 'no-fuel'; // not enough propellant for both burns

export interface MoveContext {
  bolted: boolean;
  /** The station as stations.listStations lists it (with its move, if any). */
  station: StationRecord | null;
  /** Every listed station — for a free orbit at the destination. */
  stations: StationRecord[];
  commander: boolean;
  engines: number;
  /** Fuel aboard, clamped to the tanks' capacity. */
  fuel: number;
  /** Fuel moves have drawn in this room so far (readMoveFuelDrawn). */
  drawn: number;
  /** What the tank's meter owes its level (shipDoc.fuelDrawDeficit), added
   *  to this draw. */
  deficit: number;
  /** Modules in the station (its atlas component): the mass the burns push;
   *  0 when this install does not know its layout, and no move is priced. */
  modules: number;
  now: number;
}

/** A move's quote: the plan and what it costs, before the checks that only
 *  gate the button (fuel, thrusters, owner). */
export interface MoveQuote {
  toPlanetId: string;
  toSlot: number;
  plan: InterplanetaryPlan;
  fuel: number;
}

export type MovePlanResult =
  | { ok: true; move: StationMove; quote: MoveQuote }
  | { ok: false; refusal: MoveRefusal; quote: MoveQuote | null };

/** The lowest orbit slot around `planetId` no listed station holds at
 *  `nowMs`: a station between planets (stationInTransit) holds none, as in
 *  stations.listStations. */
export function freeSlotAround(planetId: string, stations: StationRecord[], exceptId?: string, nowMs: number = Date.now()): number | null {
  const id = planetById(planetId).id;
  const used = new Set(stations.filter((s) => s.id !== exceptId && planetById(s.planetId).id === id && !stationInTransit(s, nowMs))
    .map((s) => s.orbitSlot));
  for (let slot = 0; slot < MAX_ORBIT_SLOTS; slot++) if (!used.has(slot)) return slot;
  return null;
}

/** Propellant for a move: both burns' delta-v, times the modules pushed. */
export function moveFuelCost(deltaVKmS: number, modules: number): number {
  return Math.max(1, Math.ceil(deltaVKmS * FUEL_PER_KMS * Math.max(1, Math.floor(modules))));
}

/** What moving the station to `toPlanetId` would take — or null when there is
 *  no station, it is already there, or the planet has no free orbit. */
export function quoteMove(
  station: StationRecord | null,
  stations: StationRecord[],
  toPlanetId: string,
  modules: number,
  now: number,
): MoveQuote | null {
  // No quote for a layout this install cannot see (0 modules): a price
  // clamped to one module would undercharge the move.
  if (!station || !(modules >= 1)) return null;
  const to = planetById(toPlanetId).id;
  if (to === planetById(station.planetId).id) return null;
  const toSlot = freeSlotAround(to, stations, station.id, now);
  if (toSlot === null) return null;
  const plan = planPlanetTransfer(station, { id: `${station.id}@${to}`, planetId: to, orbitSlot: toSlot }, now);
  if (!plan) return null;
  return { toPlanetId: to, toSlot, plan, fuel: moveFuelCost(plan.deltaVKmS, modules) };
}

/** Is a move still ahead of the station or under way? */
export function isMoveActive(move: StationMove | undefined | null, realMs: number): boolean {
  return !!move && realMs < move.arriveAt;
}

/** Schedule a thruster move to `toPlanetId`: the record to write, or why not. */
export function planStationMove(ctx: MoveContext, toPlanetId: string): MovePlanResult {
  const { station, now } = ctx;
  if (!ctx.bolted) return { ok: false, refusal: 'not-bolted', quote: null };
  if (!station) return { ok: false, refusal: 'no-station', quote: null };
  if (!ctx.commander) return { ok: false, refusal: 'not-commander', quote: null };
  if (isMoveActive(station.move, now)) return { ok: false, refusal: 'moving', quote: null };
  if (planetById(toPlanetId).id === planetById(station.planetId).id) return { ok: false, refusal: 'same-planet', quote: null };
  if (!(ctx.modules >= 1)) return { ok: false, refusal: 'unknown-layout', quote: null };
  const quote = quoteMove(station, ctx.stations, toPlanetId, ctx.modules, now);
  if (!quote) return { ok: false, refusal: 'no-slot', quote: null };
  if (ctx.engines < 1) return { ok: false, refusal: 'no-thrusters', quote };
  if (!(ctx.fuel >= quote.fuel)) return { ok: false, refusal: 'no-fuel', quote };
  return {
    ok: true,
    quote,
    move: {
      stationId: station.id,
      welcomeRoomId: station.welcomeRoomId,
      fromPlanetId: planetById(station.planetId).id,
      fromSlot: station.orbitSlot,
      toPlanetId: quote.toPlanetId,
      toSlot: quote.toSlot,
      departAt: quote.plan.departAt,
      arriveAt: quote.plan.arriveAt,
      mode: 'thrusters',
      bookedAt: now,
      fuel: quote.fuel,
      fuelDrawn: ctx.drawn + ctx.deficit + quote.fuel,
    },
  };
}

// ── Tugs: a torch flight ─────────────────────────────────────────────────────
//
// A tug is any ship module with TUG_MIN_ENGINES engine blocks or more, docked
// at a station. Its helm tows the station to another planet: the stack leaves
// AT ONCE and thrusts the whole way — speeding up to the halfway point, then
// braking — on a straight course from where the old planet is at departure to
// where the new planet will be at arrival (owner pick, 2026-09-27, torch drive; the ask:
// "fast with the help of a powerful tug like ship"). Still true physics on
// the 60× clock: t = 2·√(d / a), Δv = a·t. The sun's pull is small beside the
// torch and is left out. The tug's tanks pay, through its own room's
// 'stationMove' meter; the drive is far more efficient than engine blocks.

/** Engine blocks a ship needs to tow a station. */
export const TUG_MIN_ENGINES = 4;

/** The torch's steady acceleration, km/s² (0.1 m/s², about a hundredth of a
 *  g). Sovereign II → Aris Prime takes 7½ to 14 real hours by where the
 *  planets are. */
export const TUG_ACCEL_KMS2 = 1e-4;

/** Fuel per km/s of torch Δv per module pushed (the station's modules and the
 *  tug) — an eightieth of what engine blocks burn. */
export const TUG_FUEL_PER_KMS = 0.5;

function sunXZ(p: OrbitPoint): { x: number; z: number } {
  return { x: p.radiusKm * Math.cos(p.angle), z: -p.radiusKm * Math.sin(p.angle) };
}

function fromXZ(x: number, z: number): OrbitPoint {
  return { radiusKm: Math.hypot(x, z), angle: wrapAngle(Math.atan2(-z, x)) };
}

export interface TowPlan {
  departAt: number;
  arriveAt: number;
  transferMs: number;
  /** Straight-line distance flown, km. */
  distanceKm: number;
  deltaVKmS: number;
}

/** A torch flight between two planets leaving at `departAt`: its length
 *  meets the target planet where it will be on arrival (a fixed point that
 *  settles in a few steps, the planets being slow beside the torch). */
export function planTow(fromPlanetId: string, toPlanetId: string, departAt: number): TowPlan | null {
  const from = planetById(fromPlanetId).id;
  const to = planetById(toPlanetId).id;
  if (from === to) return null;
  const start = sunXZ(planetSunPointAt(from, departAt));
  let t = 0;
  let d = 0;
  for (let i = 0; i < 30; i++) {
    const end = sunXZ(planetSunPointAt(to, departAt + realMsFor(t)));
    d = Math.hypot(end.x - start.x, end.z - start.z);
    const next = 2 * Math.sqrt(d / TUG_ACCEL_KMS2);
    if (Math.abs(next - t) < 1) { t = next; break; }
    t = next;
  }
  const transferMs = Math.round(realMsFor(t));
  return { departAt, arriveAt: departAt + transferMs, transferMs, distanceKm: d, deltaVKmS: TUG_ACCEL_KMS2 * t };
}

/** Where a towed station is on its torch course, sun-centred. */
export function towPointAt(move: StationMove, realMs: number): OrbitPoint {
  const start = sunXZ(planetSunPointAt(move.fromPlanetId, move.departAt));
  const end = sunXZ(planetSunPointAt(move.toPlanetId, move.arriveAt));
  const span = orbitalSeconds(move.arriveAt) - orbitalSeconds(move.departAt);
  const f = span > 0 ? Math.min(1, Math.max(0, (orbitalSeconds(realMs) - orbitalSeconds(move.departAt)) / span)) : 1;
  // Constant thrust: speeding up for the first half, braking for the second.
  const s = f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
  return fromXZ(start.x + (end.x - start.x) * s, start.z + (end.z - start.z) * s);
}

/** Where a moving station is between its burns, sun-centred, whichever way
 *  it travels; null outside the transit. */
export function moveTransitPointAt(move: StationMove, realMs: number): OrbitPoint | null {
  if (movePhase(move, realMs) !== 'transit') return null;
  // One planet under two ids (or a pin) crosses no space, towed or not.
  if (planetById(move.fromPlanetId).id === planetById(move.toPlanetId).id) return null;
  if (move.mode === 'tug') return towPointAt(move, realMs);
  const plan = movePlan(move);
  return plan ? interplanetaryPointAt(plan, realMs) : null;
}

/** Propellant a tow takes from the tug's tanks. */
export function towFuelCost(deltaVKmS: number, stationModules: number): number {
  return Math.max(1, Math.ceil(deltaVKmS * TUG_FUEL_PER_KMS * (Math.max(1, Math.floor(stationModules)) + 1)));
}

/** Why a tug will not tow, in the order its helm checks. */
export type TowRefusal =
  | 'not-docked' // the ship is not docked at a known station
  | 'not-commander'
  | 'moving' // the station is already scheduled to move, or moving
  | 'same-planet'
  | 'no-slot'
  | 'too-weak' // fewer than TUG_MIN_ENGINES engine blocks
  | 'unknown-layout' // this install does not know the station's modules
  | 'no-fuel';

export interface TowContext {
  /** The station the ship is docked at, as listed, or null. */
  station: StationRecord | null;
  stations: StationRecord[];
  /** The tug's own room. */
  tugRoomId: string;
  commander: boolean;
  engines: number;
  fuel: number;
  /** Fuel tows and moves have drawn in the tug's room (readMoveFuelDrawn). */
  drawn: number;
  deficit: number;
  /** Modules in the station being towed; 0 when this install does not know
   *  its layout (its welcome room is not in the atlas), and no tow is priced. */
  modules: number;
  now: number;
}

export interface TowQuote {
  toPlanetId: string;
  toSlot: number;
  plan: TowPlan;
  fuel: number;
}

export type TowPlanResult =
  | { ok: true; move: StationMove; quote: TowQuote }
  | { ok: false; refusal: TowRefusal; quote: TowQuote | null };

export function quoteTow(
  station: StationRecord | null,
  stations: StationRecord[],
  toPlanetId: string,
  modules: number,
  now: number,
): TowQuote | null {
  // No quote for a layout this install cannot see (0 modules): a price
  // clamped to one module would undercharge the tow.
  if (!station || !(modules >= 1)) return null;
  const to = planetById(toPlanetId).id;
  if (to === planetById(station.planetId).id) return null;
  const toSlot = freeSlotAround(to, stations, station.id, now);
  if (toSlot === null) return null;
  const plan = planTow(station.planetId, to, now);
  if (!plan) return null;
  return { toPlanetId: to, toSlot, plan, fuel: towFuelCost(plan.deltaVKmS, modules) };
}

/** Tow the station the ship is docked at to `toPlanetId`: the move record to
 *  write in the tug's room, or why not. */
export function planStationTow(ctx: TowContext, toPlanetId: string): TowPlanResult {
  const { station, now } = ctx;
  if (!station) return { ok: false, refusal: 'not-docked', quote: null };
  if (!ctx.commander) return { ok: false, refusal: 'not-commander', quote: null };
  if (isMoveActive(station.move, now)) return { ok: false, refusal: 'moving', quote: null };
  if (planetById(toPlanetId).id === planetById(station.planetId).id) return { ok: false, refusal: 'same-planet', quote: null };
  // A tow's price scales with the modules pushed: one guessed from a layout
  // this install cannot see would undercharge it.
  if (!(ctx.modules >= 1)) return { ok: false, refusal: 'unknown-layout', quote: null };
  const quote = quoteTow(station, ctx.stations, toPlanetId, ctx.modules, now);
  if (!quote) return { ok: false, refusal: 'no-slot', quote: null };
  if (ctx.engines < TUG_MIN_ENGINES) return { ok: false, refusal: 'too-weak', quote };
  if (!(ctx.fuel >= quote.fuel)) return { ok: false, refusal: 'no-fuel', quote };
  return {
    ok: true,
    quote,
    move: {
      stationId: station.id,
      welcomeRoomId: station.welcomeRoomId,
      fromPlanetId: planetById(station.planetId).id,
      fromSlot: station.orbitSlot,
      toPlanetId: quote.toPlanetId,
      toSlot: quote.toSlot,
      departAt: quote.plan.departAt,
      arriveAt: quote.plan.arriveAt,
      mode: 'tug',
      tugRoomId: ctx.tugRoomId,
      bookedAt: now,
      fuel: quote.fuel,
      fuelDrawn: ctx.drawn + ctx.deficit + quote.fuel,
    },
  };
}

export function describeTowRefusal(refusal: TowRefusal, quote: TowQuote | null, fuel: number): string {
  switch (refusal) {
    case 'not-docked': return 'Dock at a station to tow it.';
    case 'not-commander': return 'Only the ship\'s owner can tow.';
    case 'moving': return 'That station is already scheduled to move, or moving.';
    case 'same-planet': return 'The station already orbits that planet.';
    case 'no-slot': return 'Every orbit around that planet is taken.';
    case 'too-weak': return `A tug needs at least ${TUG_MIN_ENGINES} ENGINE BLOCKs.`;
    case 'unknown-layout': return 'This ship does not know the station\'s layout yet, so the tow cannot be priced.';
    case 'no-fuel': return `Needs ${quote?.fuel ?? '?'} fuel; ${Math.floor(fuel)} aboard. Fit more FUEL TANKs and refuel.`;
  }
}

/** Is this room's own tow under way (or about to leave)? Its ship holds. */
export function isTowing(roomId: string, realMs: number): boolean {
  // Every station's standing move: a tug room can hold several stations'
  // tows, and another station's pin may sort above an active one.
  return roomStanding().some((m) => m.mode === 'tug' && m.tugRoomId === roomId && isMoveActive(m, realMs));
}

/** Does a move hold this dock still? A tug's tow under way (either end), or
 *  either end belonging to a station between planets: every ship docked to
 *  it rides along, and none may leave or join it until it arrives. Before a
 *  thruster move leaves, and after any move arrives, docks work as usual. */
export function dockLockedByMove(roomIds: string[], realMs: number): boolean {
  if (towHoldsDock(roomIds, realMs)) return true;
  return roomIds.some((id) => {
    if (!id) return false;
    const station = stationForRoom(id);
    const move = station ? latestMoveOf(station) : null;
    return !!move && stationInTransit({ move }, realMs);
  });
}

/** Is any of these rooms a tug whose tow is under way (or about to leave),
 *  by the bound room's record or any move this install remembers? Its dock
 *  holds the station, so neither end may UNDOCK it — from the tug's docking
 *  computer or from the station's door panel. */
export function towHoldsDock(roomIds: string[], realMs: number): boolean {
  const ids = new Set(roomIds.filter(Boolean));
  if (ids.size === 0) return false;
  return [...roomStanding(), ...readRememberedMoves()].some((m) =>
    m.mode === 'tug' && !!m.tugRoomId && ids.has(m.tugRoomId) && isMoveActive(m, realMs));
}

/**
 * A tug that left its station behind: a DEPART written at the same moment
 * as a TOW (another tab, or one offline) flies the tug away while the tow
 * still says it is the station's engine. Whichever tab sees the two together
 * cancels the tow with a move that leaves the station where it was, settling
 * that tow: it ranks just after it everywhere, so the tow is never flown,
 * held or paid for, and a move that beats the tow beats the cancel too.
 * Every station's standing tow by this tug is checked, not only the room's
 * latest: two offline tabs of one tug can each have towed another station.
 * Returns whether it wrote a cancel.
 */
export function cancelTowLeftBehind(
  roomId: string,
  flight: { status: string; castOffAt?: number; departedAt?: number },
  realMs: number,
  /** Is this room still docked to a room of that station, right now? A
   *  manual UNDOCK leaves the flight record 'docked', so the live dock is
   *  what says the tug let go. Leave it out when it is not known. */
  dockedTo?: (welcomeRoomId: string) => boolean,
): boolean {
  let wrote = false;
  for (const standing of [...roomStanding()]) {
    if (isCancelPin(standing)) continue;
    // Once a tow has arrived its arrival may be pinned; the tow is its parent.
    const tow = standing.settles ?? standing;
    if (tow.mode !== 'tug' || tow.tugRoomId !== roomId) continue;
    // The tug left before the tow was over: by when the flight cast off when
    // the record says, however late this tab learns of it; a tug still
    // 'docked' that let go of the station (UNDOCK records no time) by now.
    let leftAt: number;
    if (flight.status !== 'docked') leftAt = flight.castOffAt ?? flight.departedAt ?? realMs;
    else if (dockedTo && !dockedTo(tow.welcomeRoomId)) leftAt = realMs;
    else continue;
    if (leftAt >= tow.arriveAt) continue;
    const departAt = tow.departAt + 1;
    wrote = writeStationMove({
      stationId: tow.stationId,
      welcomeRoomId: tow.welcomeRoomId,
      fromPlanetId: tow.fromPlanetId,
      fromSlot: tow.fromSlot,
      toPlanetId: tow.fromPlanetId,
      toSlot: tow.fromSlot,
      departAt,
      arriveAt: departAt + 1,
      mode: 'thrusters',
      bookedAt: Math.floor(realMs),
      settles: tow,
      fuel: 0,
      fuelDrawn: 0,
    }) || wrote;
  }
  return wrote;
}

/**
 * Settle an arrival for everyone: once a station's move has arrived, write
 * where the station list put it (its new slot, the next free one after a
 * clash, or home after a bounce off a full planet) as a move that goes
 * nowhere, leaving the moment the last one arrived and naming the move it
 * settles. Each install decides a bounce from the stations it knows, and
 * those can differ; the pin is shared like any move (room doc, remembered
 * list, planet summaries), and compareMoves ranks it as the move it settles:
 * pins of one move settle to one place everywhere, and a pin of a move that
 * turns out to have lost to a concurrent one loses with it (the winner is
 * pinned in its turn). Returns whether it wrote.
 */
export function pinSettledArrival(station: StationRecord | null, realMs: number): boolean {
  if (!station) return false;
  const move = latestMoveOf(station);
  if (!move || realMs < move.arriveAt || isPinMove(move)) return false;
  const planetId = planetById(station.planetId).id;
  return writeStationMove({
    stationId: station.id,
    welcomeRoomId: move.welcomeRoomId,
    fromPlanetId: planetId,
    fromSlot: station.orbitSlot,
    toPlanetId: planetId,
    toSlot: station.orbitSlot,
    departAt: move.arriveAt,
    arriveAt: move.arriveAt + 1,
    mode: 'thrusters',
    bookedAt: Math.floor(realMs),
    settles: move,
    fuel: 0,
    fuelDrawn: 0,
  });
}

// ── What the dashboard says ──────────────────────────────────────────────────

/** "2d 03h" / "5h 12m" / "4m" — a real-time span. */
export function formatLongSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}

export function describeMoveRefusal(refusal: MoveRefusal, quote: MoveQuote | null, fuel: number): string {
  switch (refusal) {
    case 'not-bolted': return 'This module is no longer bolted into a station.';
    case 'no-station': return 'This module is not part of a known station yet.';
    case 'not-commander': return 'Only the module\'s owner can move the station.';
    case 'moving': return 'A move is already scheduled or under way.';
    case 'same-planet': return 'The station already orbits that planet: use the trim stick.';
    case 'no-slot': return 'Every orbit around that planet is taken.';
    case 'unknown-layout': return 'This helm does not know the station\'s layout yet, so the move cannot be priced.';
    case 'no-thrusters': return 'Fit an ENGINE BLOCK to this module to burn for another planet.';
    case 'no-fuel': return `Needs ${quote?.fuel ?? '?'} fuel for both burns; ${Math.floor(fuel)} aboard. Fit more FUEL TANKs and refuel, or wait for a tug.`;
  }
}

/** The status line for a move in progress. */
export function describeMove(move: StationMove, realMs: number): string {
  const to = planetById(move.toPlanetId).name;
  switch (movePhase(move, realMs)) {
    case 'scheduled': return `Leaving for ${to} at the launch window in ${formatLongSpan(move.departAt - realMs)}.`;
    case 'transit': return move.mode === 'tug'
      ? `Under tow to ${to}: arriving in ${formatLongSpan(move.arriveAt - realMs)}.`
      : `In transit to ${to}: arriving in ${formatLongSpan(move.arriveAt - realMs)}.`;
    case 'arrived': return `Arrived at ${to}, orbit slot ${move.toSlot}.`;
  }
}

/** The planets a station could move to, in PLANETS order. */
export function otherPlanets(station: StationRecord | null): string[] {
  const here = station ? planetById(station.planetId).id : '';
  return PLANETS.map((p) => p.id).filter((id) => id !== here);
}

// ── Remembered moves (per install) ───────────────────────────────────────────

const KEY = 'ssf-station-moves';
/** Twice the stations the atlas and the planet summaries can carry (64), so
 *  every station's latest move is kept even with finished ones about. */
const MAX_REMEMBERED = 128;

export function readRememberedMoves(): StationMove[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((m): m is StationMove => isStationMove(m) && isPlausibleMove(m, now)).slice(0, MAX_REMEMBERED).map(cleanMove);
  } catch { return []; }
}

/** Two moves of the same station: by welcome room, or by id without one. */
function sameStation(a: StationMove, b: StationMove): boolean {
  return a.welcomeRoomId ? a.welcomeRoomId === b.welcomeRoomId : !b.welcomeRoomId && a.stationId === b.stationId;
}

/** Remember a move this install has seen — from the helm room, or from the
 *  per-planet summary. A later departure for the same station replaces an
 *  earlier one; an older one is ignored. Returns whether the list changed. */
export function rememberMove(move: StationMove, nowMs: number = Date.now()): boolean {
  if (!isStationMove(move) || !isPlausibleMove(move, nowMs)) return false;
  const list = readRememberedMoves();
  const at = list.findIndex((m) => sameStation(m, move));
  if (at >= 0) {
    const old = list[at];
    if (compareMoves(move, old) <= 0) return false;
    list[at] = cleanMove(move);
  } else {
    list.push(cleanMove(move));
    // Forget the move that finished longest ago when full.
    while (list.length > MAX_REMEMBERED) {
      let oldest = 0;
      list.forEach((m, i) => { if (m.arriveAt < list[oldest].arriveAt) oldest = i; });
      list.splice(oldest, 1);
    }
  }
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { return false; }
  return true;
}

/** The latest move this install knows for a station, matched by its welcome
 *  room (stations.moveBelongsTo), so a move another install wrote under its
 *  own id for the station still applies here. */
export function rememberedMoveFor(station: MovingStation): StationMove | null {
  const remembered = readRememberedMoves().find((m) => moveBelongsTo(m, station)) ?? null;
  // The bound room's own standing move too, so a move written here applies
  // even when this install cannot store it (localStorage full or blocked).
  const here = roomStanding().find((m) => moveBelongsTo(m, station)) ?? null;
  if (!here) return remembered;
  return !remembered || compareMoves(here, remembered) > 0 ? here : remembered;
}

/** Point stations.listStations at the remembered moves. */
export function installStationMoveResolver(): void {
  setStationMoveResolver(rememberedMoveFor);
}

// ── The room doc ─────────────────────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
/** The room's 'stationKeeping' map: only the legacy 'move' record is read
 *  from it now. */
let keepMap: Y.Map<unknown> | null = null;
/** The room's 'stationMoves' map: the move log (entries and settled records)
 *  on its own, so its bounded scan never walks the trim burn log or anything
 *  else a peer writes beside it. */
let moveMap: Y.Map<unknown> | null = null;
let unobserve: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch (err) { console.warn('[station move] listener failed', err); }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && keepMap !== null && moveMap !== null;
}

/** Prefix of a move's own entry in the room's 'stationMoves' map: one
 *  entry per move written (`move:<clientID>:<departAt>:<station>`), never rewritten,
 *  so two moves written at once from two tabs (or an offline one) both land
 *  and one order decides between them everywhere. */
const ENTRY_PREFIX = 'move:';

/** The key moves were kept under before entries: one Yjs-arbitrated record
 *  whose fuelDrawn was the room's running total. Still read, never written. */
const LEGACY_KEY = 'move';

/** Prefix of the settled part of the move log: `moveSettled:<writer>:<n>`
 *  holding { n, drawn, floor, recent } for the first `n` entries one writer
 *  (the clientID in an entry's key) wrote that have left the log: the final
 *  unbeaten fuel and largest unbeaten running total, and the moves still
 *  reversible (MOVE_FINAL_MS), each paid only while nothing beats it. A
 *  writer's entries leave
 *  in the order it wrote them, and Yjs hands every replica a writer's
 *  entries in that order, so two replicas pruning at once cut prefixes of
 *  one sequence: the record with the larger `n` covers the other's, and
 *  readers take each writer's largest. Nothing is summed twice or lost when
 *  both records survive a merge. */
const SETTLED_PREFIX = 'moveSettled:';

/** Entries that arrived longer ago than this can leave the log, unless they
 *  still stand as a station's move or next to a move that stays. */
export const MOVE_LOG_KEEP_MS = 24 * 60 * 60 * 1000;

/** At most this many move and settled keys are read from the peer-writable
 *  map per pass, so a flood cannot stall a room: moves and pins come a few
 *  a day, and pruning keeps an honest log far below it. */
export const MOVE_SCAN_MAX = 256;

/** A pruned move stays reversible this long after it arrived: kept whole in
 *  its writer's settled record, so a rival learned late that beats it still
 *  takes its fuel back. Past it (or past SETTLED_RECENT_MAX) it is final. */
export const MOVE_FINAL_MS = MOVE_HORIZON_MS;
export const SETTLED_RECENT_MAX = 16;

/** `drawn` and `floor` are final; `recent` holds pruned moves still paid for
 *  only while nothing beats them. */
interface SettledMoves { n: number; drawn: number; floor: number; recent: StationMove[] }

/** A settled record off the wire: a positive whole count, totals within the
 *  fuel meter's range, and at most SETTLED_RECENT_MAX well-formed moves. */
function isSettledMoves(v: unknown): v is SettledMoves {
  const r = v as SettledMoves;
  const meter = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= FUEL_METER_MAX;
  return !!r && typeof r === 'object' && Number.isSafeInteger(r.n) && r.n > 0 && meter(r.drawn) && meter(r.floor)
    && (r.recent === undefined || (Array.isArray(r.recent) && r.recent.length <= SETTLED_RECENT_MAX
      && r.recent.every((m) => validMove(m) !== null)));
}

function validMove(raw: unknown): StationMove | null {
  return isStationMove(raw) && isPlausibleMove(raw) ? cleanMove(raw) : null;
}

/** The writer (Yjs clientID) in an entry key `move:<clientID>:<departAt>:<station>`,
 *  or a settled key `moveSettled:<clientID>:<n>`. */
function writerOf(key: string, prefix: string): string {
  const rest = key.slice(prefix.length);
  const cut = rest.indexOf(':');
  return cut > 0 ? rest.slice(0, cut) : rest;
}

/** Every move this room's doc holds (a bounded scan): its entries (with
 *  their keys), a legacy record, each writer's best settled record, and the
 *  keys that hold junk or a settled record another covers. */
function roomMoves(): {
  entries: StationMove[];
  keyed: Array<{ key: string; move: StationMove }>;
  legacy: StationMove | null;
  settled: Map<string, SettledMoves & { key: string }>;
  stale: string[];
} {
  const settled = new Map<string, SettledMoves & { key: string }>();
  if (!docAlive()) return { entries: [], keyed: [], legacy: null, settled, stale: [] };
  const keyed: Array<{ key: string; move: StationMove }> = [];
  const stale: string[] = [];
  let scanned = 0;
  for (const [k, v] of moveMap!.entries()) {
    // Every key visited counts, whatever it holds: the walk itself is bounded.
    if (++scanned > MOVE_SCAN_MAX) break;
    const isSettled = k.startsWith(SETTLED_PREFIX);
    if (!isSettled && !k.startsWith(ENTRY_PREFIX)) { stale.push(k); continue; }
    if (isSettled) {
      if (!isSettledMoves(v)) { stale.push(k); continue; }
      const w = writerOf(k, SETTLED_PREFIX);
      const had = settled.get(w);
      if (!had || v.n > had.n || (v.n === had.n && v.drawn > had.drawn)) {
        if (had) stale.push(had.key);
        settled.set(w, { n: v.n, drawn: v.drawn, floor: v.floor, recent: (v.recent ?? []).map(cleanMove), key: k });
      } else stale.push(k);
      continue;
    }
    const m = validMove(v);
    if (m) keyed.push({ key: k, move: m });
    else stale.push(k);
  }
  return { entries: keyed.map((e) => e.move), keyed, legacy: validMove(keepMap!.get(LEGACY_KEY)), settled, stale };
}

/** The move a record stands for: a pin's settled move, else itself. */
function flownOf(m: StationMove): StationMove {
  return m.settles ?? m;
}

/** Did a concurrent move of the same station win over this one? Another
 *  move booked at the same time (concurrentMoves: each before the other
 *  arrived, however far apart their flights) that wins the one order
 *  (compareMoves), or a cancel of this very move. A pin stands for the move
 *  it settles on both counts, so the winner's arrival pin still beats every
 *  move its flight beat, and a cancel beats its move's own arrival pin. The
 *  winner is also what the station list follows, so the loser never flies:
 *  it holds no tug, and its fuel is not drawn. */
function superseded(m: StationMove, known: StationMove[]): boolean {
  const self = JSON.stringify(cleanMove(flownOf(m)));
  return known.some((o) => {
    if (!sameStation(o, m) || compareMoves(o, m) <= 0) return false;
    // A pin of this same move: only a cancel undoes it, however late.
    if (JSON.stringify(cleanMove(flownOf(o))) === self) return isCancelPin(o);
    return concurrentMoves(flownOf(o), flownOf(m));
  });
}

/** Can one of these two moves decide whether the other is superseded? */
function related(a: StationMove, b: StationMove): boolean {
  if (!sameStation(a, b)) return false;
  const fa = flownOf(a), fb = flownOf(b);
  return concurrentMoves(fa, fb) || JSON.stringify(cleanMove(fa)) === JSON.stringify(cleanMove(fb));
}

/** Every move known here, for deciding winners: the room's own, and every
 *  move this install remembers (another room's doc may hold the winner). */
function knownMoves(own: StationMove[]): StationMove[] {
  return [...own, ...readRememberedMoves()];
}

/** Each station's standing move among `own`: the best one no concurrent
 *  move beat (a tug's room can hold tows of several stations). */
function standingMoves(own: StationMove[], known: StationMove[]): StationMove[] {
  const best: StationMove[] = [];
  for (const m of own) {
    if (superseded(m, known)) continue;
    const at = best.findIndex((b) => sameStation(b, m));
    if (at < 0) best.push(m);
    else if (compareMoves(m, best[at]) > 0) best[at] = m;
  }
  return best;
}

/** Each station's standing move in the bound room, cached until the room
 *  or this install's remembered moves change (the station list asks for
 *  every station, often). */
let standingCache: { version: string; moves: StationMove[] } | null = null;
let roomVersion = 0;

function roomStanding(): StationMove[] {
  if (!docAlive()) return [];
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { /* none stored */ }
  const version = `${roomVersion}|${stored ?? ''}`;
  if (standingCache?.version === version) return standingCache.moves;
  const { entries, legacy } = roomMoves();
  const own = legacy ? [legacy, ...entries] : entries;
  const moves = standingMoves(own, knownMoves(own));
  standingCache = { version, moves };
  return moves;
}

/** The room's latest move that is not beaten by a concurrent one, or null
 *  (none, unbound, or malformed). */
export function readStationMove(): StationMove | null {
  const { entries, legacy } = roomMoves();
  const own = legacy ? [legacy, ...entries] : entries;
  let best: StationMove | null = null;
  for (const m of standingMoves(own, knownMoves(own))) {
    if (!best || compareMoves(m, best) > 0) best = m;
  }
  return best;
}

/** The meter's parts: the settled base (else the legacy record's running
 *  total), each distinct unbeaten entry's own fuel, and the largest unbeaten
 *  running total (fuelDrawn). */
function meterParts(entries: StationMove[], known: StationMove[], base: number): { sum: number; floor: number } {
  let sum = base;
  let floor = 0;
  // The same move written twice (two tabs, one millisecond) is one move.
  const seen = new Set<string>();
  for (const m of entries) {
    const key = JSON.stringify(m);
    if (seen.has(key) || superseded(m, known)) continue;
    seen.add(key);
    sum += m.fuel;
    floor = Math.max(floor, m.fuelDrawn);
  }
  return { sum, floor };
}

/** Fuel moves have drawn in this room: the 'stationMove' draw meter — the
 *  legacy record's running total and every writer's settled total, plus
 *  each live entry's own fuel unless a concurrent move beat it; never below
 *  an unbeaten entry's own running total (fuelDrawn, kept for pruned entries
 *  as each settled record's floor), which carries the meter's deficit at
 *  booking, so a move booked after a loser dropped out of the sum still
 *  pays. */
export function readMoveFuelDrawn(): number {
  const { entries, legacy, settled } = roomMoves();
  const recent = recentMoves(settled);
  const known = knownMoves([...(legacy ? [legacy] : []), ...entries, ...recent]);
  let base = legacy?.fuelDrawn ?? 0;
  let settledFloor = 0;
  for (const r of settled.values()) { base += r.drawn; settledFloor = Math.max(settledFloor, r.floor); }
  // Recently pruned moves count like live ones: paid unless beaten.
  const { sum, floor } = meterParts([...entries, ...recent], known, base);
  return Math.max(sum, floor, settledFloor);
}

/** Every settled record's still-reversible moves. */
function recentMoves(settled: Map<string, SettledMoves>): StationMove[] {
  return [...settled.values()].flatMap((r) => r.recent);
}

/** Prune the move log inside a write's transaction. An entry can leave once
 *  it arrived before `now - MOVE_LOG_KEEP_MS`, unless it is a station's
 *  standing move or could still decide whether a kept entry is beaten
 *  (related, closed over); and only as part of its writer's oldest run of
 *  entries (see SETTLED_PREFIX). What leaves is added to its writer's settled
 *  record, so the meter reads the same. Junk keys and covered settled
 *  records go too. Keeps the log, and every read's superseded checks,
 *  bounded by the moves of about a day. */
function pruneMoveLog(now: number): void {
  const { entries, keyed, legacy, settled, stale } = roomMoves();
  for (const k of stale) moveMap!.delete(k);
  const own = legacy ? [legacy, ...entries] : entries;
  const known = knownMoves([...own, ...recentMoves(settled)]);
  const through = now - MOVE_LOG_KEEP_MS;
  const standing = new Set(standingMoves(entries, known));
  type Entry = { key: string; move: StationMove };
  const kept = new Set<Entry>(keyed.filter((e) => e.move.arriveAt >= through || standing.has(e.move)));
  const byWriter = new Map<string, Entry[]>();
  for (const e of keyed) {
    const w = writerOf(e.key, ENTRY_PREFIX);
    byWriter.set(w, [...(byWriter.get(w) ?? []), e]);
  }
  for (const list of byWriter.values()) list.sort((x, y) => bookedOf(x.move) - bookedOf(y.move) || x.move.departAt - y.move.departAt);
  // Grow `kept` until it is closed: everything related to a kept entry, and
  // every entry after a kept one in its writer's order.
  for (let grew = true; grew;) {
    grew = false;
    for (const e of keyed) {
      if (kept.has(e)) continue;
      if ([...kept].some((k) => related(k.move, e.move))) { kept.add(e); grew = true; }
    }
    for (const list of byWriter.values()) {
      const at = list.findIndex((e) => kept.has(e));
      if (at < 0) continue;
      for (const e of list.slice(at)) if (!kept.has(e)) { kept.add(e); grew = true; }
    }
  }
  if (kept.size === keyed.length) return;
  const keptMoves = keyed.filter((e) => kept.has(e)).map((e) => e.move);
  // A move written twice (two tabs) is one move: a copy that stays pays.
  const counted = new Set(keptMoves.map((m) => JSON.stringify(m)));
  for (const [w, list] of byWriter) {
    const gone = list.filter((e) => !kept.has(e));
    if (gone.length === 0) continue;
    const had = settled.get(w);
    let drawn = had?.drawn ?? 0;
    let floor = had?.floor ?? 0;
    // Pruned moves nothing beats stay whole (reversible) for a while; one
    // already beaten was never paid and is dropped.
    const recent = [...(had?.recent ?? [])];
    for (const e of gone) {
      moveMap!.delete(e.key);
      const id = JSON.stringify(e.move);
      if (counted.has(id) || superseded(e.move, known)) continue;
      counted.add(id);
      recent.push(e.move);
    }
    // The oldest past MOVE_FINAL_MS, or past the cap, become final: paid
    // unless something beats them by now.
    recent.sort((x, y) => x.arriveAt - y.arriveAt || compareMoves(x, y));
    const final = recent.filter((m, i) => m.arriveAt < now - MOVE_FINAL_MS || i < recent.length - SETTLED_RECENT_MAX);
    for (const m of final) {
      if (superseded(m, known)) continue;
      drawn += m.fuel;
      floor = Math.max(floor, m.fuelDrawn);
    }
    const n = (had?.n ?? 0) + gone.length;
    if (had) moveMap!.delete(had.key);
    moveMap!.set(`${SETTLED_PREFIX}${w}:${n}`, {
      n,
      drawn: Math.min(FUEL_METER_MAX, drawn),
      floor: Math.min(FUEL_METER_MAX, floor),
      recent: recent.filter((m) => !final.includes(m)),
    });
  }
}

/** Bind the room doc — beside bindStationKeepingDoc. Each station's standing
 *  move in the room is remembered on this install, and the move log's fuel
 *  total becomes one of the tank's draw meters. */
export function bindStationMoveDoc(doc: Y.Doc): void {
  unobserve?.();
  boundDoc = doc;
  const map = doc.getMap('stationKeeping');
  const moves = doc.getMap('stationMoves');
  keepMap = map;
  moveMap = moves;
  roomVersion++;
  const onChange = () => {
    roomVersion++;
    const { entries, legacy } = roomMoves();
    const own = legacy ? [legacy, ...entries] : entries;
    for (const m of standingMoves(own, knownMoves(own))) rememberMove(m);
    notify();
  };
  // The legacy record rides 'stationKeeping'; every trim burn changes that
  // map too, so only a change to the legacy key counts there.
  const onKeep = (e: Y.YMapEvent<unknown>) => { if (e.keysChanged.has(LEGACY_KEY)) onChange(); };
  map.observe(onKeep);
  moves.observe(onChange);
  unobserve = () => { map.unobserve(onKeep); moves.unobserve(onChange); };
  setFuelDrawMeter('stationMove', { read: readMoveFuelDrawn, subscribe: subscribeStationMove });
  onChange();
}

export function subscribeStationMove(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish a move (owner-gated at the caller). Returns whether it wrote. */
export function writeStationMove(move: StationMove): boolean {
  if (!docAlive()) return false;
  const clean = cleanMove(move);
  if (!isStationMove(clean)) {
    console.warn('[station move] refused to write a malformed move', move);
    return false;
  }
  boundDoc!.transact(() => {
    pruneMoveLog(Date.now());
    // One key per move: a writer's moves of two stations can leave at once.
    moveMap!.set(`${ENTRY_PREFIX}${boundDoc!.clientID}:${clean.departAt}:${clean.welcomeRoomId || clean.stationId}`, clean);
  });
  rememberMove(clean);
  return true;
}
