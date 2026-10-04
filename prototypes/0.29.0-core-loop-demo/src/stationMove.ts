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
import {
  MIN_ALTITUDE_KM, MIN_ORBIT_SEPARATION_KM, ORBIT_EPOCH_MS, baseOrbit, circularOrbit, maxAltitudeKm, orbitForSlot,
  orbitChangePointAt, orbitalSeconds, planOrbitChange, realMsFor, stationOrbit, stationPointAt, wrapAngle,
} from './orbits';
import type { CircularOrbit, OrbitChangePlan, OrbitPoint } from './orbits';
import { FUEL_METER_MAX, setFuelDrawMeter } from './shipDoc';
import { interplanetaryPointAt, planPlanetTransfer, planetSunPointAt } from './solarOrbits';
import type { InterplanetaryPlan } from './solarOrbits';
import { FUEL_PER_KMS } from './stationDirectory';
import { MAX_TRIM_KM } from './stationKeeping';
import {
  MAX_ORBIT_SLOTS, PLANETS, altitudeMoveKey, isOrbitChange, knownSlotsAround, orbitChangeBase, lostAltitudeClaims, orbitClaimedAt, setAltitudeHistory, moveBelongsTo,
  planetById, latestMoveOf, setStationMoveResolver, stationForRoom, stationInTransit, stationLeftPlanet,
} from './stations';
import type { MovingStation, OrbitChange, StationMove, StationOrbit, StationRecord } from './stations';

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
/** An orbit radius: finite, positive, and inside the farthest slot's by a
 *  wide margin (the altitude band itself is checked where it is flown). */
const isRadius = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e7;
const isPhase = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 2 * Math.PI;

/** 🎚️ Shape guard for the altitude orbit a move leaves from. */
function isStationOrbit(v: unknown): v is { radiusKm: number; phase0: number; since?: number } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isRadius(o.radiusKm) && isPhase(o.phase0) && (o.since === undefined || isTime(o.since));
}

/** 🎚️ The radii an altitude orbit around `planetId` may have: the band the
 *  ALT window offers, from MIN_ALTITUDE_KM (or the lowest slot, if lower)
 *  to the top slot, widened by `slackKm` (a trim on the orbit a move leaves). */
function inAltitudeBand(radiusKm: number, planetId: string, slackKm: number): boolean {
  const planet = planetById(planetId);
  const low = planet.radiusKm + Math.min(MIN_ALTITUDE_KM, orbitForSlot(planet.id, 0).altitudeKm) - slackKm;
  const high = planet.radiusKm + maxAltitudeKm(planet.id) + slackKm;
  return radiusKm >= low - 1e-6 && radiusKm <= high + 1e-6;
}

/** 🎚️ Does an altitude change fit its planet: it leaves from inside the band
 *  (a trimmed orbit, so with the trim's slack) and ends inside it, clear of
 *  every other slot's own orbit (which the planner always keeps clear), and
 *  its times and new orbit are the Hohmann transfer its two orbits make from
 *  its departure (planOrbitChange), so it is flown the way it is drawn? */
function orbitChangeFits(o: OrbitChange, planetId: string, slot: number, departAt: number, arriveAt: number): boolean {
  if (!inAltitudeBand(o.fromRadiusKm, planetId, MAX_TRIM_KM) || !inAltitudeBand(o.toRadiusKm, planetId, 0)) return false;
  const planet = planetById(planetId);
  // The base it leaves: in the band, a trim away from the orbit it flies from.
  const base = orbitChangeBase(o);
  if (o.fromBase && (!inAltitudeBand(base.radiusKm, planetId, 0)
    || Math.abs(base.radiusKm - o.fromRadiusKm) > MAX_TRIM_KM + 1e-6)) return false;
  // Only a change from the slot's own orbit (trimmed, perhaps) goes without a
  // claim stamp: a custom orbit it leaves is always stamped (sourceClaimOf),
  // so an unstamped one could never be weighed against other claims.
  if (o.fromSince === undefined
    && Math.abs(base.radiusKm - orbitForSlot(planet.id, slot).radiusKm) > MAX_TRIM_KM + 1e-6) return false;
  for (let s = 0; s < MAX_ORBIT_SLOTS; s++) {
    if (s !== slot && Math.abs(orbitForSlot(planet.id, s).radiusKm - o.toRadiusKm) < MIN_ORBIT_SEPARATION_KM) return false;
  }
  const plan = planOrbitChange(circularOrbit(planet, o.fromRadiusKm, o.fromPhase0), o.toRadiusKm, departAt);
  return !!plan && plan.departAt === departAt && plan.arriveAt === arriveAt
    && Math.abs(wrapAngle(plan.to.phase0 - o.toPhase0)) < 1e-6;
}

/** 🎚️ Shape guard for an altitude change's two orbits. */
function isOrbitChangeRecord(v: unknown): v is OrbitChange {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<Record<keyof OrbitChange, unknown>>;
  return isRadius(o.fromRadiusKm) && isPhase(o.fromPhase0) && isRadius(o.toRadiusKm) && isPhase(o.toPhase0)
    && (o.fromSince === undefined || isTime(o.fromSince))
    && (o.fromBase === undefined || isStationOrbit(o.fromBase));
}

/** 🎚️ When the custom orbit an altitude change leaves was claimed (the
 *  epoch when unknown); nothing when the station flies its slot's own. */
function sourceClaimOf(station: StationRecord): { fromSince?: number } {
  if (!station.orbit) return {};
  const since = orbitClaimedAt(latestMoveOf(station) ?? station.move, station.orbit);
  return { fromSince: isTime(since) ? since : ORBIT_EPOCH_MS };
}

/** 🎚️ The base orbit an altitude change leaves, when the trimmed orbit it
 *  flies from (`from`) is not it (OrbitChange.fromBase). */
function baseLeftOf(station: StationRecord, from: Pick<CircularOrbit, 'radiusKm' | 'phase0'>): { fromBase?: StationOrbit } {
  const base = baseOrbit(station);
  return Math.abs(base.radiusKm - from.radiusKm) < 1e-9 && Math.abs(wrapAngle(base.phase0 - from.phase0)) < 1e-12
    ? {} : { fromBase: { radiusKm: base.radiusKm, phase0: base.phase0 } };
}

/** 🎚️ The custom orbit a station's next move keeps until it leaves (its
 *  fromOrbit), with when that orbit was claimed; nothing at its slot's own. */
function heldOrbitOf(station: StationRecord): { fromOrbit?: NonNullable<StationMove['fromOrbit']> } {
  if (!station.orbit) return {};
  const since = orbitClaimedAt(latestMoveOf(station) ?? station.move, station.orbit);
  return { fromOrbit: { radiusKm: station.orbit.radiusKm, phase0: station.orbit.phase0, since: isTime(since) ? since : ORBIT_EPOCH_MS } };
}

function clearOfOtherSlots(radiusKm: number, planetId: string, slot: number): boolean {
  const planet = planetById(planetId);
  for (let s = 0; s < MAX_ORBIT_SLOTS; s++) {
    if (s !== slot && Math.abs(orbitForSlot(planet.id, s).radiusKm - radiusKm) < MIN_ORBIT_SEPARATION_KM) return false;
  }
  return true;
}

function claimedByBooking(since: number | undefined, bookedAt: number): boolean {
  return since === undefined || since <= bookedAt;
}

/** Shape guard — a hostile peer can write anything into the map. */
export function isStationMove(v: unknown): v is StationMove {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof StationMove, unknown>>;
  return isId(r.stationId)
    && typeof r.welcomeRoomId === 'string' && r.welcomeRoomId.length <= MAX_ID_LENGTH
    && isId(r.fromPlanetId) && isSlot(r.fromSlot)
    && isId(r.toPlanetId) && isSlot(r.toSlot)
    // Within one planet only by going nowhere, written as such (both
    // planners refuse a same-planet move): an unknown planet reads as the
    // default one, so it is compared as read.
    && (planetById(r.fromPlanetId as string).id !== planetById(r.toPlanetId as string).id
      || (r.fromPlanetId === r.toPlanetId && r.fromSlot === r.toSlot))
    && isTime(r.departAt) && isTime(r.arriveAt) && (r.arriveAt as number) > (r.departAt as number)
    && (r.mode === 'thrusters' || (r.mode === 'tug' && isId(r.tugRoomId))
      // An altitude change stays around its planet, in its slot.
      || (r.mode === 'orbit' && r.tugRoomId === undefined && isOrbitChangeRecord(r.orbit)
        && r.fromPlanetId === r.toPlanetId && r.fromSlot === r.toSlot
        && orbitChangeFits(r.orbit, r.toPlanetId as string, r.toSlot as number, r.departAt as number, r.arriveAt as number)))
    && (r.tugRoomId === undefined || isId(r.tugRoomId))
    && (r.orbit === undefined || r.mode === 'orbit')
    && (r.fromOrbit === undefined || (r.mode !== 'orbit' && isStationOrbit(r.fromOrbit)
      && inAltitudeBand(r.fromOrbit.radiusKm, r.fromPlanetId as string, MAX_TRIM_KM)
      // Unstamped, it could never be weighed against other claims: only
      // the slot's own orbit (trimmed, perhaps) goes without (orbitChangeFits).
      && ((r.fromOrbit as { since?: number }).since !== undefined
        || Math.abs(r.fromOrbit.radiusKm - orbitForSlot(r.fromPlanetId as string, r.fromSlot as number).radiusKm) <= MAX_TRIM_KM + 1e-6)
      // Clear of every other slot's own orbit, as an altitude change ends.
      && clearOfOtherSlots(r.fromOrbit.radiusKm, r.fromPlanetId as string, r.fromSlot as number)))
    // Booked no later than it leaves: one stamped after a rival arrived
    // would read as booked after it (concurrentMoves) and escape it. Only a
    // move that goes nowhere may be later: a pin is written once what it
    // records is over.
    && (r.bookedAt === undefined || (isTime(r.bookedAt) && ((r.bookedAt as number) <= (r.departAt as number)
      || (r.fromPlanetId === r.toPlanetId && r.fromSlot === r.toSlot))))
    // 🎚️ The orbit it leaves was claimed by the time it was booked: claims
    // are weighed in time order, so a later stamp would jump the queue.
    && claimedByBooking(r.mode === 'orbit' ? (r.orbit as { fromSince?: number } | undefined)?.fromSince : (r.fromOrbit as { since?: number } | undefined)?.since,
      (r.bookedAt ?? r.departAt) as number)
    // One level only, checked before recursing: a hostile nest is refused
    // at the first step, never walked.
    && (r.settles === undefined || (typeof r.settles === 'object' && r.settles !== null
      && (r.settles as { settles?: unknown }).settles === undefined
      // 🎚️ An altitude change is never pinned (stations.isPinMove).
      && (r.settles as { mode?: unknown }).mode !== 'orbit'
      && isStationMove(r.settles) && r.settles.welcomeRoomId === r.welcomeRoomId
      && isPinOf(r as StationMove, r.settles)))
    && typeof r.fuel === 'number' && Number.isInteger(r.fuel) && r.fuel >= 0 && r.fuel <= FUEL_METER_MAX
    && typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX;
}

/** Is `p` a pin of `of` in the form one is written (pinSettledArrival,
 *  writeCancelOf)? It holds its station where it is for a millisecond and
 *  draws no fuel. An arrival pin leaves the moment that move arrived, at
 *  either end of it (home after a bounce; any slot there, as the list may
 *  have moved it on); a cancel undoes a tow the moment after it left, where
 *  it left from. Anything else would rank as that move (compareMoves) and
 *  place its station early, or somewhere it never went. */
function isPinOf(p: StationMove, of: StationMove): boolean {
  const planet = planetById(p.fromPlanetId).id;
  if (p.toPlanetId !== p.fromPlanetId || p.toSlot !== p.fromSlot || p.arriveAt !== p.departAt + 1
    || p.mode !== 'thrusters' || p.fuel !== 0 || p.fuelDrawn !== 0) return false;
  if (p.departAt < of.arriveAt) {
    return of.mode === 'tug' && p.departAt === of.departAt + 1
      && planet === planetById(of.fromPlanetId).id && p.fromSlot === of.fromSlot;
  }
  return p.departAt === of.arriveAt
    && (planet === planetById(of.toPlanetId).id || planet === planetById(of.fromPlanetId).id);
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
 *  tow, or where an arrival settled). An altitude change keeps its planet
 *  and slot too, but flies: it is no pin. */
export function isPinMove(m: StationMove): boolean {
  return !!m.settles || (m.mode !== 'orbit' && m.fromPlanetId === m.toPlanetId && m.fromSlot === m.toSlot);
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
    ...(m.mode === 'orbit' && m.orbit ? {
      orbit: {
        fromRadiusKm: m.orbit.fromRadiusKm, fromPhase0: m.orbit.fromPhase0,
        toRadiusKm: m.orbit.toRadiusKm, toPhase0: m.orbit.toPhase0,
        ...(typeof m.orbit.fromSince === 'number' ? { fromSince: m.orbit.fromSince } : {}),
        ...(m.orbit.fromBase ? { fromBase: { radiusKm: m.orbit.fromBase.radiusKm, phase0: m.orbit.fromBase.phase0 } } : {}),
      },
    } : {}),
    ...(m.mode !== 'orbit' && m.fromOrbit ? {
      fromOrbit: {
        radiusKm: m.fromOrbit.radiusKm, phase0: m.fromOrbit.phase0,
        ...(typeof m.fromOrbit.since === 'number' ? { since: m.fromOrbit.since } : {}),
      },
    } : {}),
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

/** The lowest orbit slot around `planetId` no station holds at `nowMs` or
 *  is on its way to — a listed one, or one heard of from a planet summary
 *  (stations.knownSlotsAround; most around other planets are never listed
 *  here): a station between planets (stationInTransit) holds none where it
 *  left, as in stations.listStations, but keeps the slot its move is bound
 *  for. */
export function freeSlotAround(planetId: string, stations: StationRecord[], exceptId?: string, nowMs: number = Date.now()): number | null {
  const id = planetById(planetId).id;
  const others = stations.filter((s) => s.id !== exceptId);
  const used = new Set(others.filter((s) => planetById(s.planetId).id === id && !stationLeftPlanet(s, nowMs))
    .map((s) => s.orbitSlot));
  // A station on its way here (or booked to come) has its slot paid for:
  // it is not offered again, so the move that follows never clashes there.
  for (const s of others) {
    const m = s.move;
    if (m && !isPinMove(m) && m.arriveAt > nowMs && planetById(m.toPlanetId).id === id) used.add(m.toSlot);
  }
  const known = knownSlotsAround(id, stations.map((s) => s.welcomeRoomId), nowMs);
  for (const slot of [...known.taken, ...known.reserved]) used.add(slot);
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
      ...heldOrbitOf(station),
      toPlanetId: quote.toPlanetId,
      toSlot: quote.toSlot,
      departAt: quote.plan.departAt,
      arriveAt: quote.plan.arriveAt,
      mode: 'thrusters',
      bookedAt: now,
      fuel: quote.fuel,
      fuelDrawn: Math.min(FUEL_METER_MAX, ctx.drawn + ctx.deficit + quote.fuel),
    },
  };
}

// ── 🎚️ Altitude changes (issue 191) ──────────────────────────────────────────
//
// The station helm's ALT window picks an altitude around the planet the
// station orbits; ENGAGE flies there at once on a Hohmann transfer
// (orbits.planOrbitChange) under the station's own thrusters, priced like a
// move (delta-v times the modules pushed). It is written as a StationMove
// with mode 'orbit' — same planet, same slot, the two orbits in `orbit` — so
// it rides everything a move has: the room's move log and its fuel meter,
// the remembered list, the planet summary, compareMoves, and the dock lock
// while it flies (no ship docks with, leaves or reaches a station between
// two orbits). Once it arrives, stations.listStations lists the station
// with the new orbit (StationRecord.orbit), and its trim starts over there.

/** Why an altitude change will not go, in the order the helm checks. */
export type AltitudeRefusal =
  | Exclude<MoveRefusal, 'same-planet' | 'no-slot'>
  | 'same-altitude' // the station already flies that altitude
  | 'too-low' // below MIN_ALTITUDE_KM
  | 'too-high' // above the top slot's altitude
  | 'too-close'; // within MIN_ORBIT_SEPARATION_KM of another orbit

/** What an altitude change would take, before the checks that only gate the
 *  button (fuel, thrusters, owner). */
export interface AltitudeQuote {
  altitudeKm: number;
  plan: OrbitChangePlan;
  fuel: number;
}

export type AltitudePlanResult =
  | { ok: true; move: StationMove; quote: AltitudeQuote }
  | { ok: false; refusal: AltitudeRefusal; quote: AltitudeQuote | null; near?: OrbitNeighbour };

/** An orbit an altitude would come too close to: a station's (by name), or
 *  another slot's own orbit, kept clear for whoever settles there. */
export interface OrbitNeighbour {
  radiusKm: number;
  /** The station's name; absent for a slot's own orbit. */
  name?: string;
}

/** The altitude a station flies now, km (its trimmed orbit's). */
export function stationAltitudeKm(station: StationRecord): number {
  return stationOrbit(station).altitudeKm;
}

/** "1,250 km" — an altitude for the dashboard. */
export function formatAltitude(km: number): string {
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/**
 * The orbits around `station`'s planet an altitude change must keep clear of:
 * every other station there (its BASE orbit, so both keep their whole trim
 * band, and where an altitude change of its own is taking it), and every
 * other slot's own orbit — open now or held by a station flying an altitude
 * of its own, which may come back to it or leave the slot to the next
 * station to arrive or be built. A station between planets holds none.
 */
export function orbitsToKeepClear(station: StationRecord, stations: StationRecord[], nowMs: number): OrbitNeighbour[] {
  const planet = planetById(station.planetId);
  const out: OrbitNeighbour[] = [];
  for (const s of stations) {
    if (s.id === station.id || (station.welcomeRoomId && s.welcomeRoomId === station.welcomeRoomId)) continue;
    if (planetById(s.planetId).id !== planet.id || stationLeftPlanet(s, nowMs)) continue;
    out.push({ radiusKm: baseOrbit(s).radiusKm, name: s.name });
    const m = s.move;
    if (m && isOrbitChange(m) && m.orbit && nowMs < m.arriveAt) out.push({ radiusKm: m.orbit.toRadiusKm, name: s.name });
  }
  // The station's own slot is its own to come back to; every other slot's
  // orbit is kept clear, held or not.
  for (let slot = 0; slot < MAX_ORBIT_SLOTS; slot++) {
    if (slot !== station.orbitSlot) out.push({ radiusKm: orbitForSlot(planet.id, slot).radiusKm });
  }
  return out;
}

/** The nearest orbit an altitude comes within MIN_ORBIT_SEPARATION_KM of,
 *  or null when it is clear of them all. */
export function altitudeConflict(radiusKm: number, clear: OrbitNeighbour[]): OrbitNeighbour | null {
  let near: OrbitNeighbour | null = null;
  for (const o of clear) {
    const gap = Math.abs(o.radiusKm - radiusKm);
    if (gap < MIN_ORBIT_SEPARATION_KM && (!near || gap < Math.abs(near.radiusKm - radiusKm))) near = o;
  }
  return near;
}

/** What flying the station to `altitudeKm` would take — or null when there
 *  is no station, or no change to plan (the same altitude, or a layout this
 *  install cannot price). The altitude band and the separation are the
 *  planner's checks, not the quote's, so the helm can still show a price. */
export function quoteAltitude(
  station: StationRecord | null,
  altitudeKm: number,
  modules: number,
  now: number,
): AltitudeQuote | null {
  if (!station || !(modules >= 1) || !Number.isFinite(altitudeKm)) return null;
  const from = stationOrbit(station);
  const plan = planOrbitChange(from, from.planet.radiusKm + altitudeKm, now);
  if (!plan) return null;
  return { altitudeKm, plan, fuel: moveFuelCost(plan.deltaVKmS, modules) };
}

/** Round an altitude to the whole km the ALT window shows. */
export function wholeAltitude(km: number): number {
  return Math.round(km);
}

/** Schedule an altitude change to `altitudeKm` (whole km): the move record to
 *  write, or why not. */
export function planStationAltitude(ctx: MoveContext, altitudeKm: number): AltitudePlanResult {
  const { station, now } = ctx;
  if (!ctx.bolted) return { ok: false, refusal: 'not-bolted', quote: null };
  if (!station) return { ok: false, refusal: 'no-station', quote: null };
  if (!ctx.commander) return { ok: false, refusal: 'not-commander', quote: null };
  if (isMoveActive(station.move, now)) return { ok: false, refusal: 'moving', quote: null };
  const planet = planetById(station.planetId);
  if (!Number.isFinite(altitudeKm) || altitudeKm < MIN_ALTITUDE_KM) return { ok: false, refusal: 'too-low', quote: null };
  if (altitudeKm > maxAltitudeKm(planet.id)) return { ok: false, refusal: 'too-high', quote: null };
  if (wholeAltitude(stationAltitudeKm(station)) === wholeAltitude(altitudeKm)) return { ok: false, refusal: 'same-altitude', quote: null };
  if (!(ctx.modules >= 1)) return { ok: false, refusal: 'unknown-layout', quote: null };
  const quote = quoteAltitude(station, altitudeKm, ctx.modules, now);
  if (!quote) return { ok: false, refusal: 'same-altitude', quote: null };
  const near = altitudeConflict(quote.plan.to.radiusKm, orbitsToKeepClear(station, ctx.stations, now));
  if (near) return { ok: false, refusal: 'too-close', quote, near };
  if (ctx.engines < 1) return { ok: false, refusal: 'no-thrusters', quote };
  if (!(ctx.fuel >= quote.fuel)) return { ok: false, refusal: 'no-fuel', quote };
  const { plan } = quote;
  const planetId = planet.id;
  return {
    ok: true,
    quote,
    move: {
      stationId: station.id,
      welcomeRoomId: station.welcomeRoomId,
      fromPlanetId: planetId,
      fromSlot: station.orbitSlot,
      toPlanetId: planetId,
      toSlot: station.orbitSlot,
      departAt: plan.departAt,
      arriveAt: plan.arriveAt,
      mode: 'orbit',
      orbit: {
        fromRadiusKm: plan.from.radiusKm,
        fromPhase0: plan.from.phase0,
        toRadiusKm: plan.to.radiusKm,
        toPhase0: plan.to.phase0,
        ...sourceClaimOf(station),
        ...baseLeftOf(station, plan.from),
      },
      bookedAt: now,
      fuel: quote.fuel,
      fuelDrawn: Math.min(FUEL_METER_MAX, ctx.drawn + ctx.deficit + quote.fuel),
    },
  };
}

export function describeAltitudeRefusal(
  refusal: AltitudeRefusal,
  quote: AltitudeQuote | null,
  fuel: number,
  station: StationRecord | null = null,
  near: OrbitNeighbour | null = null,
): string {
  const planet = planetById(station?.planetId);
  switch (refusal) {
    case 'same-altitude': return 'The station already flies that altitude.';
    case 'too-low': return `Too low: ${formatAltitude(MIN_ALTITUDE_KM)} is the lowest orbit clear of the atmosphere.`;
    case 'too-high': return `Too high: ${formatAltitude(maxAltitudeKm(planet.id))} is the highest orbit around ${planet.name}.`;
    case 'too-close': {
      const alt = near ? formatAltitude(near.radiusKm - planet.radiusKm) : '';
      const whose = near?.name ? `${near.name}'s orbit` : 'another slot\'s orbit, kept clear for the station it is kept for';
      return `Too close to ${whose}${alt ? ` at ${alt}` : ''}: keep ${MIN_ORBIT_SEPARATION_KM} km clear.`;
    }
    case 'moving': return 'A move or altitude change is already scheduled or under way.';
    case 'no-thrusters': return 'Fit an ENGINE BLOCK to this module to change the station\'s altitude.';
    case 'no-fuel': return `Needs ${quote?.fuel ?? '?'} fuel for both burns; ${Math.floor(fuel)} aboard. Fit more FUEL TANKs and refuel.`;
    default: return describeMoveRefusal(refusal, null, fuel);
  }
}

/** Where a station changing altitude is between its burns, planet-centred;
 *  null for any other move, or outside the transit. */
export function orbitChangeTransitPointAt(move: StationMove, realMs: number): OrbitPoint | null {
  if (move.mode !== 'orbit' || !move.orbit || movePhase(move, realMs) !== 'transit') return null;
  const plan = orbitChangePlanOf(move);
  return plan ? orbitChangePointAt(plan, realMs) : null;
}

/** Where a listed station is at a real time, planet-centred: on its altitude
 *  change's course while one is listed (before, between and after its burns:
 *  the listing catches up at its next read), else on the orbit it flies. */
export function stationPointWithMoveAt(station: StationRecord, realMs: number): OrbitPoint {
  const plan = station.move ? orbitChangePlanOf(station.move) : null;
  return plan ? orbitChangePointAt(plan, realMs) : stationPointAt(station, realMs);
}

/** The two orbits and burns of an altitude change, rebuilt from its record. */
export function orbitChangePlanOf(move: StationMove): Pick<OrbitChangePlan, 'from' | 'to' | 'departAt' | 'arriveAt'> | null {
  if (move.mode !== 'orbit' || !move.orbit) return null;
  const planet = planetById(move.fromPlanetId);
  const from: CircularOrbit = circularOrbit(planet, move.orbit.fromRadiusKm, move.orbit.fromPhase0);
  const to: CircularOrbit = circularOrbit(planet, move.orbit.toRadiusKm, move.orbit.toPhase0);
  return { from, to, departAt: move.departAt, arriveAt: move.arriveAt };
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
  /** 🚏 The tug runs a ferry route: its keeper would cast off from the
   *  station mid-tow (and a tow pins the ship the route moves). */
  | 'route-running'
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
  /** 🚏 A ferry route runs on the tug (shipRoute.isRouteRunning): STOP it
   *  first. Absent reads as none (an older caller). */
  routeRunning?: boolean;
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
  if (ctx.routeRunning === true) return { ok: false, refusal: 'route-running', quote: null };
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
      ...heldOrbitOf(station),
      toPlanetId: quote.toPlanetId,
      toSlot: quote.toSlot,
      departAt: quote.plan.departAt,
      arriveAt: quote.plan.arriveAt,
      mode: 'tug',
      tugRoomId: ctx.tugRoomId,
      bookedAt: now,
      fuel: quote.fuel,
      fuelDrawn: Math.min(FUEL_METER_MAX, ctx.drawn + ctx.deficit + quote.fuel),
    },
  };
}

export function describeTowRefusal(refusal: TowRefusal, quote: TowQuote | null, fuel: number): string {
  switch (refusal) {
    case 'not-docked': return 'Dock at a station to tow it.';
    case 'not-commander': return 'Only the ship\'s owner can tow.';
    case 'route-running': return 'Stop the ferry route to tow: its timetable would cast the tug off mid-tow.';
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
    // An aborted altitude change (another station claimed its orbit first)
    // never flew: it holds nothing.
    return !!move && stationInTransit({ move }, realMs) && !isAbortedAltitudeChange(move);
  });
}

/** dockLockedByMove for a room whose own doc is in hand: a far room's,
 *  fetched for a DOCK (farDoorWrite). The moves booked in that room, and
 *  those its planet summaries gossip (booked in another room of its
 *  station, or a tug's), count with every move known here, so a ship that
 *  has not heard of one yet still joins no station between planets: a tow
 *  that room is the tug of, ahead or under way, or a move of its station in
 *  transit. Its station is the one this install lists the room at, else
 *  the one whose welcome room it is, else the one its own bookings name (a
 *  move is booked from a room of its station, a tow from the tug; a pin is
 *  no booking: every game writes them for each station it lists, wherever
 *  it stands, pinSettledArrivals). A room
 *  whose records the bounded scans cannot all read (a peer can flood
 *  either map) is held too: what lies past them may be such a move, until
 *  the clients there prune the flood. */
export function roomDocLockedByMove(doc: Y.Doc, roomId: string, realMs: number): boolean {
  const { own: there, heard, complete } = docMoves(doc);
  if (!complete) return true;
  const all = [...there, ...heard, ...roomOwn(), ...readRememberedMoves()];
  const standing = standingMoves(all, all);
  if (standing.some((m) => m.mode === 'tug' && !!roomId && m.tugRoomId === roomId && isMoveActive(m, realMs))) return true;
  const station = roomId ? stationForRoom(roomId) : null;
  const towedBy = (m: StationMove) => flownOf(m).mode === 'tug' && flownOf(m).tugRoomId === roomId;
  const ofRoom = (m: StationMove) => (station
    ? moveBelongsTo(m, station)
    : (!!roomId && m.welcomeRoomId === roomId) || there.some((o) => !isPinMove(o) && !towedBy(o) && sameStation(o, m)));
  return standing.some((m) => ofRoom(m) && stationInTransit({ move: m }, realMs));
}

/** Remember the standing moves a room's own doc holds (a far room's), and
 *  those its planet summaries gossip, as the bound room's are
 *  (bindStationMoveDoc, planetSummary): this install then carries them on. */
export function rememberMovesIn(doc: Y.Doc): void {
  const { own, heard } = docMoves(doc);
  const all = [...own, ...heard];
  for (const m of standingMoves(all, knownMoves(all))) rememberMove(m);
}

/** Planet summaries one read visits: planetSummary's own pull bound. */
const SUMMARY_SCAN_MAX = 256;

/** What a room's doc that is not the bound one holds: the moves booked
 *  there (roomOwn's), the moves its planet summaries gossip
 *  (planetSummary.ts: each station's latest, under its welcome room,
 *  checked as that module's pull checks them), and whether the bounded
 *  scans read every record of both. Every client standing in a room
 *  publishes there its own station's move and every move it remembers, so
 *  a move booked in another room of the station, or in a tug's, reaches
 *  the room that way. */
function docMoves(doc: Y.Doc): { own: StationMove[]; heard: StationMove[]; complete: boolean } {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return { own: [], heard: [], complete: true };
  const { entries, legacy, folded, complete } = movesIn(doc.getMap('stationMoves'), doc.getMap('stationKeeping'));
  const summaries = doc.getMap('stationSummaries');
  const heard: StationMove[] = [];
  let scanned = 0;
  for (const [k, v] of summaries.entries()) {
    if (++scanned > SUMMARY_SCAN_MAX) break;
    if (typeof v !== 'object' || v === null || (v as { welcomeRoomId?: unknown }).welcomeRoomId !== k) continue;
    const m = validMove((v as { move?: unknown }).move);
    if (m && m.welcomeRoomId === k) heard.push(m);
  }
  return {
    own: [...(legacy ? [legacy] : []), ...entries, ...folded],
    heard,
    complete: complete && summaries.size <= SUMMARY_SCAN_MAX,
  };
}

/** Is any of these rooms a tug whose tow is under way (or about to leave),
 *  by the bound room's record or any move this install remembers? Its dock
 *  holds the station, so neither end may UNDOCK it — from the tug's docking
 *  computer or from the station's door panel. */
export function towHoldsDock(roomIds: string[], realMs: number): boolean {
  const ids = new Set(roomIds.filter(Boolean));
  if (ids.size === 0) return false;
  return knownStanding().some((m) =>
    m.mode === 'tug' && !!m.tugRoomId && ids.has(m.tugRoomId) && isMoveActive(m, realMs));
}

/** Each station's standing move among everything known here: the bound
 *  room's and every remembered one, history included. Only a standing move
 *  flies, so a cancelled or outbid tow kept as history holds no dock.
 *  Cached like roomStanding. */
let knownStandingCache: { version: string; moves: StationMove[] } | null = null;

function knownStanding(): StationMove[] {
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { /* none stored */ }
  const version = `${docAlive() ? roomVersion : -1}|${stored ?? ''}`;
  if (knownStandingCache?.version === version) return knownStandingCache.moves;
  const all = [...roomStanding(), ...readRememberedMoves()];
  const moves = standingMoves(all, all);
  knownStandingCache = { version, moves };
  return moves;
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
 * Those two tows are rivals anyway (one tug, one set of tanks): the one
 * that ranks lower is cancelled too, whatever the flight (outbidTows).
 * Returns whether it wrote a cancel.
 */
export function cancelTowLeftBehind(
  roomId: string,
  flight: { status: string; castOffAt?: number; departedAt?: number },
  realMs: number,
  /** Is this room still docked to a room of that station, right now? A
   *  manual UNDOCK leaves the flight record 'docked', so the live dock is
   *  what says the tug let go: true while any dock holds, else when it let
   *  go (the last of its docks into that station to let go, at or after
   *  `since`, the tow's booking: shipArrival.dockedToStation), else false
   *  (let go, time unknown). Leave it out when it is not known. */
  dockedTo?: (welcomeRoomId: string, since: number) => boolean | number,
): boolean {
  let wrote = false;
  for (const tow of outbidTows(roomId)) wrote = writeCancelOf(tow, realMs) || wrote;
  for (const standing of [...roomStanding()]) {
    if (isCancelPin(standing)) continue;
    // Once a tow has arrived its arrival may be pinned; the tow is its parent.
    const tow = standing.settles ?? standing;
    if (tow.mode !== 'tug' || tow.tugRoomId !== roomId) continue;
    // The tug left before the tow was over: by when the flight cast off when
    // the record says, however late this tab learns of it; a tug still
    // 'docked' that let go of the station by its UNDOCK's own stamp (the dock
    // tombstone), else by now.
    let leftAt: number;
    if (flight.status !== 'docked') leftAt = flight.castOffAt ?? flight.departedAt ?? realMs;
    else {
      const docked = dockedTo ? dockedTo(tow.welcomeRoomId, bookedOf(tow)) : true;
      if (docked === true) continue;
      leftAt = docked === false ? realMs : docked;
    }
    if (leftAt >= tow.arriveAt) continue;
    wrote = writeCancelOf(tow, realMs) || wrote;
  }
  return wrote;
}

/** This tug's tows that no move of their own station beat but another
 *  station's tow by the same tug outranked (tugRivals), and that nothing
 *  cancels yet. The tug room already neither flies nor pays for them; the
 *  station list elsewhere follows each station's own latest move, so the
 *  loss spreads as a cancel like any other. */
function outbidTows(roomId: string): StationMove[] {
  if (!docAlive()) return [];
  // Bundled tows too: placement and the meter read them.
  const own = roomOwn();
  const known = knownMoves(own);
  const seen = new Set<string>();
  return own.filter((m) => {
    if (m.settles || m.mode !== 'tug' || m.tugRoomId !== roomId) return false;
    const id = JSON.stringify(cleanMove(m));
    if (seen.has(id)) return false;
    seen.add(id);
    if (beatenForStation(m, known) || !outbidForTug(m, known)) return false;
    return !known.some((o) => isCancelPin(o) && JSON.stringify(cleanMove(flownOf(o))) === id);
  });
}

/** Cancel a tow: a move that leaves its station where it was, settling the
 *  tow and ranking just after it everywhere. */
function writeCancelOf(tow: StationMove, realMs: number): boolean {
  const departAt = tow.departAt + 1;
  return writeStationMove({
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
  });
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
  // An altitude change keeps its slot: there is no clash to settle.
  if (!move || realMs < move.arriveAt || isPinMove(move) || isOrbitChange(move)) return false;
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

/** pinSettledArrival for every station this install lists: a long move can
 *  finish while nobody is aboard that station, and every game that knows it
 *  settles it, so no install keeps its own bounce outcome for long. Returns
 *  how many pins it wrote. */
export function pinSettledArrivals(stations: StationRecord[], realMs: number): number {
  let wrote = 0;
  for (const station of stations) if (pinSettledArrival(station, realMs)) wrote++;
  return wrote;
}

// ── What the dashboard says ──────────────────────────────────────────────────

/** "1m 05s" under an hour, else formatLongSpan — an altitude change's span,
 *  which low down takes a minute or two. */
export function formatTransferSpan(ms: number): string {
  if (ms >= 3_600_000) return formatLongSpan(ms);
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

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
  if (move.mode === 'orbit' && move.orbit) {
    const alt = formatAltitude(move.orbit.toRadiusKm - planetById(move.toPlanetId).radiusKm);
    switch (movePhase(move, realMs)) {
      case 'scheduled': return `Burning for ${alt} in ${formatTransferSpan(move.departAt - realMs)}.`;
      case 'transit': return `Changing orbit to ${alt}: arriving in ${formatTransferSpan(move.arriveAt - realMs)}.`;
      case 'arrived': return `Orbiting at ${alt}.`;
    }
  }
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
/** Room for every station's latest move (the atlas and the planet summaries
 *  carry up to 64 stations) with finished ones and recent history about. */
const MAX_REMEMBERED = 256;
/** A station's earlier moves stay remembered while an entry they could
 *  decide is still reversible (pruned after MOVE_LOG_KEEP_MS, final after
 *  MOVE_FINAL_MS more), at most this many per station: a winner learned
 *  here keeps its loser unpaid after the station's next move replaces it
 *  as the latest. */
const HISTORY_PER_STATION = 8;

/** The remembered list as last parsed, with each move's id: parsed again
 *  only when the stored text changes (the station list, and every move a
 *  room's doc holds, ask for it often). A move stored here was plausible
 *  when it was stored, so it stays plausible. */
let rememberedCache: { raw: string; moves: StationMove[]; ids: Set<string> } | null = null;

function rememberedState(): { moves: StationMove[]; ids: Set<string> } {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* none stored */ }
  if (!raw) return { moves: [], ids: new Set() };
  if (rememberedCache?.raw === raw) return rememberedCache;
  let moves: StationMove[] = [];
  try {
    const arr = JSON.parse(raw);
    const now = Date.now();
    if (Array.isArray(arr)) {
      moves = arr.filter((m): m is StationMove => isStationMove(m) && isPlausibleMove(m, now)).slice(0, MAX_REMEMBERED).map(cleanMove);
    }
  } catch { /* corrupt: none */ }
  rememberedCache = { raw, moves, ids: new Set(moves.map(moveId)) };
  return rememberedCache;
}

export function readRememberedMoves(): StationMove[] {
  return rememberedState().moves.slice();
}

/** Two moves of the same station: by welcome room, or by id without one. */
function sameStation(a: StationMove, b: StationMove): boolean {
  return a.welcomeRoomId ? a.welcomeRoomId === b.welcomeRoomId : !b.welcomeRoomId && a.stationId === b.stationId;
}

/** Remember a move this install has seen — from the helm room, or from the
 *  per-planet summary. Each station's best move (compareMoves) is kept, and
 *  its earlier ones while still recent enough to decide a pending entry
 *  (HISTORY_PER_STATION). Returns whether the list changed. */
export function rememberMove(move: StationMove, nowMs: number = Date.now()): boolean {
  if (!isStationMove(move) || !isPlausibleMove(move, nowMs)) return false;
  const clean = cleanMove(move);
  const id = moveId(clean);
  const { moves: before, ids } = rememberedState();
  if (ids.has(id)) return false;
  const list = trimRemembered([...before, clean], nowMs);
  if (!list.includes(clean)) return false;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { return false; }
  // A new winner learned here (a planet summary, another room) can change
  // this room's standing move and so its 'stationMove' meter: tell the
  // listeners, the fuel meter among them, once the caller is done.
  notifySoon();
  return true;
}

/** Each station's best move (and its best standing one, when that one is
 *  beaten or outbid), then its recent history, within the caps: history goes
 *  first when full (longest finished first), then the bests that finished
 *  longest ago. */
function trimRemembered(list: StationMove[], nowMs: number): StationMove[] {
  const since = nowMs - MOVE_LOG_KEEP_MS - MOVE_FINAL_MS;
  // By station, as sameStation: its welcome room, or its id without one.
  const byStation = new Map<string, StationMove[]>();
  for (const m of list) {
    const k = m.welcomeRoomId ? `w:${m.welcomeRoomId}` : `s:${m.stationId}`;
    const g = byStation.get(k);
    if (g) g.push(m); else byStation.set(k, [m]);
  }
  const groups = [...byStation.values()];
  const bests: StationMove[] = [];
  const history: StationMove[] = [];
  const dropped: StationMove[] = [];
  for (const g of groups) {
    g.sort((x, y) => compareMoves(y, x));
    bests.push(g[0]);
    // When another station's tow by the same tug outbids that one (nothing
    // of its own station ranks above it to beat it), the best that stands
    // is what the station follows (rememberedMoveFor): kept too, however old.
    const stands = flownOf(g[0]).mode === 'tug' && outbidForTug(g[0], list)
      ? g.find((m) => !superseded(m, list)) : undefined;
    if (stands) bests.push(stands);
    const recent = g.slice(1).filter((m) => m !== stands && m.arriveAt >= since).slice(0, HISTORY_PER_STATION);
    history.push(...recent);
    dropped.push(...g.slice(1).filter((m) => m !== stands && !recent.includes(m)));
  }
  const byFinish = (x: StationMove, y: StationMove) => y.arriveAt - x.arriveAt;
  const keptBests = bests.sort(byFinish).slice(0, MAX_REMEMBERED);
  const evidence = altitudeEvidence(keptBests, history, dropped).slice(0, MAX_REMEMBERED - keptBests.length);
  const keptHistory = history.sort(byFinish).slice(0, MAX_REMEMBERED - keptBests.length - evidence.length);
  return [...keptBests, ...evidence, ...keptHistory];
}

/** 🎚️ Of the moves history would drop (too old, or past a station's cap),
 *  those an altitude claim of some station's best move needs to stay lost: a claim that beat it ages out of history only by being kept
 *  here, or the loser would be accepted later, unflown and unpaid. Each is
 *  tried without, oldest first, and kept only if the losses change. */
function altitudeEvidence(bests: StationMove[], history: StationMove[], dropped: StationMove[]): StationMove[] {
  // Every claim a best move makes: an altitude change's destination and the
  // orbit it leaves, or the custom orbit any other move (a pin too) holds.
  const claimsOf = (b: StationMove) => [altitudeMoveKey(b), `${altitudeMoveKey(b)}|from`];
  const claims = (b: StationMove) => (b.mode === 'orbit' && !b.settles) || !!(b.settles ?? b).fromOrbit;
  const losers = (moves: StationMove[]) => {
    const lost = lostAltitudeClaims(flownAmong(moves));
    return bests.filter(claims).flatMap(claimsOf).filter((k) => lost.has(k)).join('\n');
  };
  if (dropped.length === 0 || !bests.some(claims)) return [];
  let kept = [...dropped];
  const want = losers([...bests, ...history, ...kept]);
  if (!want) return [];
  for (const m of [...dropped].sort((x, y) => x.arriveAt - y.arriveAt)) {
    const without = kept.filter((k) => k !== m);
    if (losers([...bests, ...history, ...without]) === want) kept = without;
  }
  return kept;
}

let notifyQueued = false;

/** notify(), after the current task: coalesced, and never inside the
 *  caller's own write (a planet summary publish remembers moves). */
function notifySoon(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; notify(); });
}

/** The move a station follows: its standing move among everything this
 *  install knows (knownStanding: the bound room's, so a move written here
 *  applies even when this install cannot store it, and every remembered
 *  one), matched by its welcome room (stations.moveBelongsTo), so a move
 *  another install wrote under its own id for the station still applies
 *  here. A move beaten by a concurrent one of its station, or outbid by
 *  another station's tow by the same tug, never flies: the station follows
 *  the best of its moves that stands, as the fuel meter and the dock locks
 *  do. */
export function rememberedMoveFor(station: MovingStation): StationMove | null {
  return knownStanding().find((m) => moveBelongsTo(m, station)) ?? null;
}

/** 🚚 The move a station follows instead of `latest` (the latest move known
 *  for it), when that one does not stand here: a tow outbid by another
 *  station's on the same tug, or a move beaten by a concurrent one of its
 *  station (superseded). Null when it stands, or when nothing of the
 *  station's ranking below it does. A planet summary carries it beside
 *  `latest` (planetSummary.ts `stands`): a reader that learns the rival
 *  rejects `latest`, and without this would place the station by its first
 *  record. */
export function standingInsteadOf(latest: StationMove): StationMove | null {
  if (!superseded(latest, [...roomStanding(), ...readRememberedMoves()])) return null;
  const stands = knownStanding().find((m) => sameStation(m, latest));
  return stands && compareMoves(stands, latest) < 0 ? stands : null;
}

/** Where a station left from on the first of its moves to depart between
 *  `sinceMs` and `nowMs`: where it was at `sinceMs`, once it has left since
 *  (null: it has not). Among the moves this install knows (the bound room's
 *  and every remembered one): a move beaten, outbid or cancelled never flew,
 *  and an arrival's pin stands for the move it settles. */
export function stationLeftFrom(
  station: MovingStation,
  sinceMs: number,
  nowMs: number = Date.now(),
): { planetId: string; orbitSlot: number } | null {
  // Its standing move is the last it made (rememberedMoveFor): when even
  // that left before `sinceMs`, none did since.
  const latest = rememberedMoveFor(station);
  if (!latest || flownOf(latest).departAt < sinceMs) return null;
  const all = [...roomOwn(), ...readRememberedMoves()];
  let first: StationMove | null = null;
  for (const rec of all) {
    if (!moveBelongsTo(rec, station) || isCancelPin(rec)) continue;
    const m = flownOf(rec);
    if (m.departAt < sinceMs || m.departAt > nowMs || isPinMove(m)) continue;
    if (first && m.departAt >= first.departAt) continue;
    if (!superseded(m, all)) first = m;
  }
  return first ? { planetId: planetById(first.fromPlanetId).id, orbitSlot: first.fromSlot } : null;
}

/** Point stations.listStations at the remembered moves. */
export function installStationMoveResolver(): void {
  setStationMoveResolver(rememberedMoveFor);
  setAltitudeHistory(flownKnownMoves);
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
 *  holding { n, drawn, floor, recent, done } for the first `n` entries one writer
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
 *  only while nothing beats them; `done` the latest moves made final here
 *  (at most SETTLED_RECENT_MAX), so another writer's copy of one of them (a
 *  move written twice, two tabs) is never paid again. */
interface SettledMoves { n: number; drawn: number; floor: number; recent: StationMove[]; done?: StationMove[] }

/** One move's identity across copies: its published fields. */
function moveId(m: StationMove): string {
  return JSON.stringify(cleanMove(m));
}

/** A settled record off the wire: a positive whole count, totals within the
 *  fuel meter's range, and at most SETTLED_RECENT_MAX well-formed moves. */
function isSettledMoves(v: unknown): v is SettledMoves {
  const r = v as SettledMoves;
  const meter = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= FUEL_METER_MAX;
  // `recent` is always written (perhaps empty); only `done` may be missing.
  return !!r && typeof r === 'object' && Number.isSafeInteger(r.n) && r.n > 0 && meter(r.drawn) && meter(r.floor)
    && Array.isArray(r.recent)
    && [r.recent, r.done].every((list) => list === undefined || (Array.isArray(list) && list.length <= SETTLED_RECENT_MAX
      && list.every((m) => validMove(m) !== null)));
}

/** Prefix of a bundle (`moveFold:<bucket>:<hash>`): settled records and
 *  entries moved out of the top level past the caps (sweepLog), each kept
 *  whole under its own identity — a record under its writer, an entry under
 *  its key — so readers unpack them into the same places and a record or
 *  entry two bundles hold is still one. Each item goes to one of
 *  FOLD_BUCKETS buckets by its identity, so a fold rewrites only the
 *  buckets it adds to; the hash names the bundle's content, so replicas
 *  packing the same items write the same key. */
const FOLD_PREFIX = 'moveFold:';
const FOLD_BUCKETS = 16;
/** Items one bundle holds at most. */
export const FOLD_ITEMS_MAX = 64;
/** Bundle items a read unpacks at most: every bucket full, and as many
 *  again for versions of a bucket two replicas wrote at once, until the next
 *  sweep joins them. */
const MOVE_FOLD_READ_MAX = 2 * FOLD_BUCKETS * FOLD_ITEMS_MAX;

interface FoldBundle { settled: Record<string, SettledMoves>; entries: Record<string, StationMove> }

/** A writer id or entry key a bundle may hold: as long as writeStationMove
 *  makes one — the prefix, a client id (a uint32: 10 digits), a departure
 *  time (13 digits and up to 4 decimals within isTime's bounds) and a
 *  welcome room or station id, with the two colons between them. */
const FOLD_ID_MAX = ENTRY_PREFIX.length + 10 + 1 + 18 + 1 + MAX_ID_LENGTH;

/** Bundle values already checked, and found sound (or too big ever to be):
 *  a doc value is replaced, never changed in place, so each is checked once.
 *  A sound one stays sound (a move only grows more plausible with time). */
const foldVerdicts = new WeakMap<object, boolean>();

/** A bundle off the wire: at most FOLD_ITEMS_MAX well-formed items, counted
 *  as they are met, so an oversized one is refused at its first item past
 *  the cap without copying it. */
function isFoldBundle(v: unknown): v is FoldBundle {
  if (!v || typeof v !== 'object') return false;
  const known = foldVerdicts.get(v);
  if (known !== undefined) return known;
  const b = v as FoldBundle;
  if (!b.settled || typeof b.settled !== 'object' || Array.isArray(b.settled)
    || !b.entries || typeof b.entries !== 'object' || Array.isArray(b.entries)) return false;
  const own = Object.prototype.hasOwnProperty;
  let items = 0;
  let sound = true;
  for (const part of [b.settled, b.entries] as Array<Record<string, unknown>>) {
    for (const k in part) {
      if (!own.call(part, k)) continue;
      if (++items > FOLD_ITEMS_MAX) {
        foldVerdicts.set(v, false);
        return false;
      }
      if (!sound) continue;
      sound = part === b.settled
        ? k.length > 0 && k.length <= FOLD_ID_MAX && isSettledMoves(part[k])
        : k.startsWith(ENTRY_PREFIX) && k.length <= FOLD_ID_MAX && validMove(part[k]) !== null;
    }
  }
  if (sound) foldVerdicts.set(v, true);
  return sound;
}

/** The bucket a bundle key names (one hex digit), or null. */
function bucketOfKey(key: string): string | null {
  const rest = key.slice(FOLD_PREFIX.length);
  return /^[0-9a-f]:[0-9a-f]{16}$/.test(rest) ? rest[0] : null;
}

/** A short, stable hash of a string (FNV-1a, twice over), as 16 hex digits. */
function contentHash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The bucket an item belongs to, by its identity (`s:<writer>`, `e:<key>`). */
function bucketOfItem(id: string): string {
  return (parseInt(contentHash(id).slice(-2), 16) % FOLD_BUCKETS).toString(16);
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

/** What a room's doc holds of the move log (roomMoves). */
interface RoomMoves {
  entries: StationMove[];
  keyed: Array<{ key: string; move: StationMove }>;
  legacy: StationMove | null;
  settled: Map<string, SettledMoves & { key: string | null }>;
  folded: StationMove[];
  stale: string[];
  /** False when the bounds cut the scan short: a record may lie past them. */
  complete: boolean;
}

/** Every move this room's doc holds (a bounded scan): its entries (with
 *  their keys), a legacy record, each writer's best settled record, the
 *  entries bundled past the caps, and the keys that hold junk or a settled
 *  record another covers. A bundle's items unpack within their own budget,
 *  each in its place: a record as its writer's (key null: never stale, its
 *  bundle holds others), an entry once per key. */
function roomMoves(): RoomMoves {
  if (!docAlive()) return { entries: [], keyed: [], legacy: null, settled: new Map(), folded: [], stale: [], complete: true };
  return movesIn(moveMap!, keepMap!);
}

/** roomMoves over any room's maps: its 'stationMoves' and 'stationKeeping'. */
function movesIn(moveLog: Y.Map<unknown>, keep: Y.Map<unknown>): RoomMoves {
  const settled = new Map<string, SettledMoves & { key: string | null }>();
  const keyed: Array<{ key: string; move: StationMove }> = [];
  const folded = new Map<string, StationMove>();
  const stale: string[] = [];
  let scanned = 0;
  let unpacked = 0;
  let complete = true;
  // A writer's best record: the larger count, then the larger total.
  const offer = (w: string, v: SettledMoves, key: string | null) => {
    const had = settled.get(w);
    if (!had || v.n > had.n || (v.n === had.n && v.drawn > had.drawn)) {
      if (had?.key) stale.push(had.key);
      settled.set(w, {
        n: v.n, drawn: v.drawn, floor: v.floor, recent: v.recent.map(cleanMove), done: (v.done ?? []).map(cleanMove), key,
      });
    } else if (key) stale.push(key);
  };
  for (const [k, v] of moveLog.entries()) {
    // Every key visited counts, whatever it holds: the walk itself is bounded.
    if (++scanned > MOVE_SCAN_MAX) { complete = false; break; }
    if (k.startsWith(SETTLED_PREFIX)) {
      if (isSettledMoves(v)) offer(writerOf(k, SETTLED_PREFIX), v, k);
      else stale.push(k);
      continue;
    }
    if (k.startsWith(FOLD_PREFIX)) {
      if (bucketOfKey(k) === null || !isFoldBundle(v)) { stale.push(k); continue; }
      for (const [w, r] of Object.entries(v.settled)) {
        if (++unpacked <= MOVE_FOLD_READ_MAX) offer(w, r, null);
        else complete = false;
      }
      for (const [ek, m] of Object.entries(v.entries)) {
        if (++unpacked > MOVE_FOLD_READ_MAX) complete = false;
        else if (!folded.has(ek)) folded.set(ek, cleanMove(m));
      }
      continue;
    }
    if (!k.startsWith(ENTRY_PREFIX)) { stale.push(k); continue; }
    const m = validMove(v);
    if (m) keyed.push({ key: k, move: m });
    else stale.push(k);
  }
  return {
    entries: keyed.map((e) => e.move), keyed, legacy: validMove(keep.get(LEGACY_KEY)), settled, folded: [...folded.values()], stale, complete,
  };
}

/** The moves this room's doc holds for deciding where stations are: its
 *  legacy record, its entries, and the entries bundled past the caps. */
function roomOwn(): StationMove[] {
  const { entries, legacy, folded } = roomMoves();
  return [...(legacy ? [legacy] : []), ...entries, ...folded];
}

/** The move a record stands for: a pin's settled move, else itself. */
function flownOf(m: StationMove): StationMove {
  return m.settles ?? m;
}

/** Is this move out of the running: beaten by a concurrent move of its
 *  station, or outbid by another tow of the same tug? */
function superseded(m: StationMove, known: StationMove[]): boolean {
  return beatenForStation(m, known) || outbidForTug(m, known) || outbidForAltitude(m, known);
}

/** 🎚️ Did this altitude change lose the orbit it ends in to an earlier claim
 *  of another station (stations.lostAltitudeClaims)? The station list aborts
 *  it, so it neither flies, holds docks nor draws fuel. */
function outbidForAltitude(m: StationMove, known: StationMove[]): boolean {
  if (m.mode !== 'orbit' || m.settles) return false;
  let lost = lostCache.get(known);
  if (!lost) lostCache.set(known, lost = lostAltitudeClaims(flownAmong(known)));
  return lost.has(altitudeMoveKey(m));
}

/** The losing claims per list of known moves: superseded asks once per entry. */
const lostCache = new WeakMap<StationMove[], Set<string>>();

/** 🎚️ The known moves that flew: a concurrent move its own station (or tug)
 *  preferred never did, so it claims no orbit. */
function flownAmong(known: StationMove[]): StationMove[] {
  return known.filter((m) => !beatenForStation(m, known) && !outbidForTug(m, known));
}

/** Every move this install knows: the bound room's log and the remembered
 *  ones. */
function allKnownMoves(): StationMove[] {
  if (!docAlive()) return readRememberedMoves();
  const { entries, legacy } = roomMoves();
  return knownMoves(legacy ? [legacy, ...entries] : entries);
}

/** 🎚️ The moves listStations weighs altitude claims among: every known one
 *  that flew. */
function flownKnownMoves(): StationMove[] {
  return flownAmong(allKnownMoves());
}

/** 🎚️ Is this an altitude change another station's claimed the orbit for
 *  first, by every move this install knows? */
export function isAbortedAltitudeChange(m: StationMove): boolean {
  return m.mode === 'orbit' && !m.settles && lostAltitudeClaims([m, ...flownKnownMoves()]).has(altitudeMoveKey(m));
}

/** Did a concurrent move of the same station win over this one? Another
 *  move booked at the same time (concurrentMoves: each before the other
 *  arrived, however far apart their flights) that wins the one order
 *  (compareMoves), or a cancel of this very move. A pin stands for the move
 *  it settles on both counts, so the winner's arrival pin still beats every
 *  move its flight beat, and a cancel beats its move's own arrival pin. The
 *  winner is also what the station list follows, so the loser never flies:
 *  it holds no tug, and its fuel is not drawn. */
function beatenForStation(m: StationMove, known: StationMove[]): boolean {
  const self = JSON.stringify(cleanMove(flownOf(m)));
  return known.some((o) => {
    if (!sameStation(o, m) || compareMoves(o, m) <= 0) return false;
    // A pin of this same move: only a cancel undoes it, however late.
    if (JSON.stringify(cleanMove(flownOf(o))) === self) return isCancelPin(o);
    return concurrentMoves(flownOf(o), flownOf(m));
  });
}

/** Two tows by one tug booked at once, of different stations: one tug has
 *  one set of tanks and flies one tow at a time, so only the one that ranks
 *  first (compareFlown, the same everywhere) flies and is paid for. Cancel
 *  pins take no part: they fly nothing and draw nothing, and the loser's own
 *  cancel must stand. */
function tugRivals(a: StationMove, b: StationMove): boolean {
  if (isCancelPin(a) || isCancelPin(b)) return false;
  const fa = flownOf(a), fb = flownOf(b);
  return fa.mode === 'tug' && fb.mode === 'tug' && !!fa.tugRoomId && fa.tugRoomId === fb.tugRoomId
    && !sameStation(fa, fb) && concurrentMoves(fa, fb);
}

/** Did a concurrent tow of another station by the same tug outrank this
 *  one (tugRivals)? */
function outbidForTug(m: StationMove, known: StationMove[]): boolean {
  return known.some((o) => tugRivals(o, m) && compareFlown(flownOf(o), flownOf(m)) > 0);
}

/** Can one of these two moves decide whether the other is superseded? */
function related(a: StationMove, b: StationMove): boolean {
  if (tugRivals(a, b)) return true;
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
  const own = roomOwn();
  const moves = standingMoves(own, knownMoves(own));
  standingCache = { version, moves };
  return moves;
}

/** The room's latest move that is not beaten by a concurrent one, or null
 *  (none, unbound, or malformed). */
export function readStationMove(): StationMove | null {
  const own = roomOwn();
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
  const { entries, legacy, settled, folded } = roomMoves();
  const recent = [...recentMoves(settled), ...folded];
  const known = knownMoves([...(legacy ? [legacy] : []), ...entries, ...recent]);
  let base = legacy?.fuelDrawn ?? 0;
  let settledFloor = 0;
  for (const r of settled.values()) { base += r.drawn; settledFloor = Math.max(settledFloor, r.floor); }
  // Recently pruned moves, and bundled entries, count like live ones: paid
  // unless beaten, and unless a copy was already made final (and so counted
  // in a drawn total).
  const done = doneIds(settled);
  const { sum, floor } = meterParts([...entries, ...recent].filter((m) => !done.has(moveId(m))), known, base);
  // Each record is capped, their sum is not: a reading past the meter's range
  // would read as none at all (shipDoc), so it stops at the cap.
  return Math.min(FUEL_METER_MAX, Math.max(sum, floor, settledFloor));
}

/** Every settled record's final moves it still remembers, by identity. */
function doneIds(settled: Map<string, SettledMoves>): Set<string> {
  return new Set([...settled.values()].flatMap((r) => (r.done ?? []).map(moveId)));
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
  const { entries, keyed, legacy, settled, folded, stale } = roomMoves();
  for (const k of stale) moveMap!.delete(k);
  const own = legacy ? [legacy, ...entries] : entries;
  const known = knownMoves([...own, ...recentMoves(settled), ...folded]);
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
  const counted = new Set(keptMoves.map(moveId));
  // …and so does a copy another writer's record holds: final there, or
  // still reversible there (the smaller writer id keeps a copy both hold).
  const heldBy = (w: string, id: string, onlyBefore: boolean): boolean => [...settled].some(([o, r]) =>
    o !== w && ((r.done ?? []).some((m) => moveId(m) === id)
      || ((!onlyBefore || o < w) && r.recent.some((m) => moveId(m) === id))));
  for (const [w, list] of byWriter) {
    const gone = list.filter((e) => !kept.has(e));
    if (gone.length === 0) continue;
    const had = settled.get(w);
    let drawn = had?.drawn ?? 0;
    let floor = had?.floor ?? 0;
    // Pruned moves nothing beats stay whole (reversible) for a while; one
    // already beaten was never paid and is dropped.
    const recent = (had?.recent ?? []).filter((m) => !heldBy(w, moveId(m), true));
    for (const e of gone) {
      moveMap!.delete(e.key);
      const id = moveId(e.move);
      if (counted.has(id) || superseded(e.move, known) || heldBy(w, id, false)) continue;
      counted.add(id);
      recent.push(e.move);
    }
    // The oldest past MOVE_FINAL_MS, or past the cap, become final: paid
    // unless something beats them by now.
    recent.sort((x, y) => x.arriveAt - y.arriveAt || compareMoves(x, y));
    const final = recent.filter((m, i) => m.arriveAt < now - MOVE_FINAL_MS || i < recent.length - SETTLED_RECENT_MAX);
    const done = [...(had?.done ?? [])];
    for (const m of final) {
      if (superseded(m, known)) continue;
      drawn += m.fuel;
      floor = Math.max(floor, m.fuelDrawn);
      done.push(m);
    }
    const n = (had?.n ?? 0) + gone.length;
    // A bundled record stays in its bundle: this one's larger count covers it.
    if (had?.key) moveMap!.delete(had.key);
    moveMap!.set(`${SETTLED_PREFIX}${w}:${n}`, {
      n,
      drawn: Math.min(FUEL_METER_MAX, drawn),
      floor: Math.min(FUEL_METER_MAX, floor),
      recent: recent.filter((m) => !final.includes(m)),
      done: done.slice(-SETTLED_RECENT_MAX),
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
    const own = roomOwn();
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

/** At most this many move entries and settled records stay at the top level
 *  after a sweep: an honest log (pruned to about a day) is far below either,
 *  and with the bundles (FOLD_BUCKETS) they leave the entry a write adds
 *  inside MOVE_SCAN_MAX. */
export const MOVE_ENTRIES_KEEP = MOVE_SCAN_MAX / 2;
export const MOVE_SETTLED_KEEP = MOVE_SCAN_MAX / 4;

/** At most this many keys one sweep pass walks. A log longer than that (a
 *  flood) is cleared over the passes that follow (sweepLater), each as
 *  bounded, so no write stalls on it. */
export const SWEEP_BATCH = 4 * MOVE_SCAN_MAX;

/**
 * One bounded pass over the move log, inside a write's transaction: it
 * walks at most SWEEP_BATCH keys, clears every one that is not a
 * well-formed entry, settled record or bundle, and any settled record its
 * writer's later one covers. The entries past the cap among those it met
 * move into bundles (entries still under way stay first, then the ones
 * booked latest), and so do the settled records past theirs (those that
 * drew most stay) — or every settled record it met, when it saw only part
 * of the log (more keys than one pass walks: a flood). Bundling keeps each
 * item whole (repack), and readers unpack bundles into the same places, so
 * the meter, where each station is, and every move that decides another
 * read the same. Returns whether it saw the whole log, and whether it
 * changed anything.
 */
function sweepLog(now: number): { complete: boolean; progress: boolean } {
  const junk: string[] = [];
  const entries: Array<{ key: string; move: StationMove }> = [];
  const best = new Map<string, { key: string; record: SettledMoves }>();
  const bundles: Array<{ key: string; bucket: string; bundle: FoldBundle }> = [];
  let walked = 0;
  let complete = true;
  for (const [k, v] of moveMap!.entries()) {
    if (++walked > SWEEP_BATCH) { complete = false; break; }
    if (k.startsWith(SETTLED_PREFIX)) {
      if (!isSettledMoves(v)) { junk.push(k); continue; }
      // Each writer's largest record covers its others (roomMoves).
      const w = writerOf(k, SETTLED_PREFIX);
      const had = best.get(w);
      if (!had || v.n > had.record.n || (v.n === had.record.n && v.drawn > had.record.drawn)) {
        if (had) junk.push(had.key);
        best.set(w, { key: k, record: v });
      } else junk.push(k);
      continue;
    }
    if (k.startsWith(FOLD_PREFIX)) {
      const bucket = bucketOfKey(k);
      if (bucket !== null && isFoldBundle(v)) bundles.push({ key: k, bucket, bundle: v });
      else junk.push(k);
      continue;
    }
    const m = k.startsWith(ENTRY_PREFIX) ? validMove(v) : null;
    if (m) entries.push({ key: k, move: m });
    else junk.push(k);
  }
  for (const k of junk) moveMap!.delete(k);
  const settled = [...best.values()];
  const byKey = (x: { key: string }, y: { key: string }) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  const active = (m: StationMove) => (m.arriveAt > now ? 1 : 0);
  // The entries keep one order and cap whether or not the pass saw the
  // whole log, so a flood of moves still under way is bundled a pass at a
  // time like any other; past the cap only the settled records differ.
  entries.sort((x, y) => active(y.move) - active(x.move) || bookedOf(y.move) - bookedOf(x.move) || byKey(x, y));
  const foldEntries = entries.slice(MOVE_ENTRIES_KEEP);
  let foldSettled = settled;
  let liveSettled: Array<{ key: string; record: SettledMoves }> = [];
  if (complete) {
    settled.sort((x, y) => y.record.drawn - x.record.drawn || byKey(x, y));
    foldSettled = settled.slice(MOVE_SETTLED_KEEP);
    liveSettled = settled.slice(0, MOVE_SETTLED_KEEP);
  }
  // The move each station follows among those this pass sees, worked out
  // only when a bundle overflows: those stay first.
  let stands: Set<string> | null = null;
  const standingIds = (): Set<string> => {
    if (!stands) {
      const seen = [...entries.map((e) => e.move), ...bundles.flatMap((b) => Object.values(b.bundle.entries))];
      stands = new Set(standingMoves(seen, knownMoves(seen)).map(moveId));
    }
    return stands;
  };
  const repacked = repack(bundles, foldSettled, foldEntries, liveSettled, standingIds);
  return { complete, progress: junk.length > 0 || repacked };
}

/**
 * Move settled records and entries out of the top level into bundles, each
 * whole under its identity, bucket by bucket: a bucket that gains items, or
 * that holds more than one bundle (two replicas packed it at once) or items
 * of another bucket, is rewritten as one bundle of everything it holds; the
 * others stay as they are. Within a bucket a writer keeps its best record
 * (dropped when a record of its own still at the top level covers it, or
 * when it holds nothing to pay or decide: no total, no running total, no
 * move still reversible), and an entry its key. Past FOLD_ITEMS_MAX in one
 * bucket (a flood of well-formed records, never an honest log) the items
 * worth least go, after every move a station follows (`standingIds`).
 * Returns whether the map changed.
 */
function repack(
  bundles: Array<{ key: string; bucket: string; bundle: FoldBundle }>,
  foldSettled: Array<{ key: string; record: SettledMoves }>,
  foldEntries: Array<{ key: string; move: StationMove }>,
  liveSettled: Array<{ key: string; record: SettledMoves }>,
  standingIds: () => Set<string>,
): boolean {
  type Bucket = { keys: string[]; settled: Map<string, SettledMoves>; entries: Map<string, StationMove>; dirty: boolean };
  const buckets = new Map<string, Bucket>();
  const bucket = (b: string): Bucket => {
    let at = buckets.get(b);
    if (!at) buckets.set(b, at = { keys: [], settled: new Map(), entries: new Map(), dirty: false });
    return at;
  };
  const offer = (w: string, r: SettledMoves): boolean => {
    const at = bucket(bucketOfItem(`s:${w}`));
    const had = at.settled.get(w);
    if (had && !(r.n > had.n || (r.n === had.n && r.drawn > had.drawn))) return false;
    at.settled.set(w, r);
    return true;
  };
  for (const { key, bucket: b, bundle } of bundles) {
    const own = bucket(b);
    own.keys.push(key);
    if (own.keys.length > 1) own.dirty = true;
    for (const [w, r] of Object.entries(bundle.settled)) {
      offer(w, r);
      if (bucketOfItem(`s:${w}`) !== b) { own.dirty = true; bucket(bucketOfItem(`s:${w}`)).dirty = true; }
    }
    for (const [k, m] of Object.entries(bundle.entries)) {
      const at = bucket(bucketOfItem(`e:${k}`));
      if (!at.entries.has(k)) at.entries.set(k, m);
      if (bucketOfItem(`e:${k}`) !== b) { own.dirty = true; at.dirty = true; }
    }
  }
  for (const { key, record } of foldSettled) {
    const w = writerOf(key, SETTLED_PREFIX);
    offer(w, record);
    bucket(bucketOfItem(`s:${w}`)).dirty = true;
  }
  for (const { key, move } of foldEntries) {
    const at = bucket(bucketOfItem(`e:${key}`));
    at.entries.set(key, move);
    at.dirty = true;
  }
  const live = new Map(liveSettled.map(({ key, record }) => [writerOf(key, SETTLED_PREFIX), record]));
  const covered = (w: string, r: SettledMoves): boolean => {
    const l = live.get(w);
    return !!l && (l.n > r.n || (l.n === r.n && l.drawn >= r.drawn));
  };
  const idle = (r: SettledMoves) => r.drawn === 0 && r.floor === 0 && r.recent.length === 0;
  let changed = false;
  for (const k of [...foldSettled, ...foldEntries].map((e) => e.key)) { moveMap!.delete(k); changed = true; }
  for (const [b, at] of buckets) {
    if (!at.dirty) continue;
    type Item = { id: string; value: number; move?: StationMove; rank: number; put: (into: FoldBundle) => void };
    const items: Item[] = [];
    for (const [w, r] of at.settled) {
      if (bucketOfItem(`s:${w}`) !== b || covered(w, r) || idle(r)) continue;
      items.push({
        id: `s:${w}`, value: r.drawn + r.recent.reduce((sum, m) => sum + m.fuel, 0), rank: 1, put: (into) => { into.settled[w] = r; },
      });
    }
    for (const [k, m] of at.entries) {
      if (bucketOfItem(`e:${k}`) !== b) continue;
      items.push({ id: `e:${k}`, value: m.fuel, move: m, rank: 1, put: (into) => { into.entries[k] = m; } });
    }
    // Overflowing (a flood): the move each station follows stays first.
    if (items.length > FOLD_ITEMS_MAX) {
      const stands = standingIds();
      for (const it of items) if (it.move && stands.has(moveId(it.move))) it.rank = 0;
    }
    const byId = (x: Item, y: Item) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    items.sort((x, y) => x.rank - y.rank || y.value - x.value || byId(x, y));
    const kept = items.slice(0, FOLD_ITEMS_MAX).sort(byId);
    const next: FoldBundle = { settled: {}, entries: {} };
    for (const it of kept) it.put(next);
    const key = kept.length > 0 ? `${FOLD_PREFIX}${b}:${contentHash(JSON.stringify(next))}` : null;
    for (const old of at.keys) if (old !== key) { moveMap!.delete(old); changed = true; }
    if (key && !at.keys.includes(key)) { moveMap!.set(key, next); changed = true; }
  }
  return changed;
}

let sweepQueued = false;

/** Carry a sweep that met more keys than one pass walks over the turns that
 *  follow, a bounded pass at a time, so a flood never stalls the write that
 *  met it. It stops once a pass sees the whole log, or can clear nothing
 *  more. */
function sweepLater(): void {
  if (sweepQueued) return;
  sweepQueued = true;
  setTimeout(() => {
    sweepQueued = false;
    if (!docAlive()) return;
    let pass = { complete: true, progress: false };
    boundDoc!.transact(() => { pass = sweepLog(Date.now()); });
    if (!pass.complete && pass.progress) sweepLater();
  }, 0);
}

/** Publish a move (owner-gated at the caller). Returns whether it wrote. */
export function writeStationMove(move: StationMove): boolean {
  if (!docAlive()) return false;
  const clean = cleanMove(move);
  if (!isStationMove(clean)) {
    console.warn('[station move] refused to write a malformed move', move);
    return false;
  }
  let sweep = { complete: true, progress: false };
  boundDoc!.transact(() => {
    sweep = sweepLog(Date.now());
    pruneMoveLog(Date.now());
    // One key per move: a writer's moves of two stations can leave at once.
    moveMap!.set(`${ENTRY_PREFIX}${boundDoc!.clientID}:${clean.departAt}:${clean.welcomeRoomId || clean.stationId}`, clean);
  });
  if (!sweep.complete && sweep.progress) sweepLater();
  rememberMove(clean);
  return true;
}
