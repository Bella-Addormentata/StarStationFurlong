/**
 * 🚚 Station moves — a station leaves its planet for another one under its
 * own thrusters (owner ask, 2026-09-27: "stations … should be able to be
 * moved to other planets, perhaps slowly with its own thrusters, or fast with
 * the help of a powerful tug like ship"). This is the thruster half; tugs come
 * next and reuse the same record with `mode: 'tug'`.
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
 * Storage: the `stationKeeping` map in the HELM ROOM's doc (key 'move'),
 * beside the trim record — shared by everyone in the room. Station records are
 * still kept per install, so each install also REMEMBERS every move it has
 * seen (localStorage), keyed by station id: the station stays moved when you
 * walk to another room — and the per-planet summary (planetSummary.ts)
 * carries each station's latest move to every install around the planet.
 *
 * Fuel rides the tank's draw meter, like a trim burn: the record carries the
 * running total drawn, and the meter reads the higher of the trim's and the
 * move's totals (each write starts from the meter's reading).
 *
 * Pure except for the doc binding and the saved list. Pinned by
 * stationMove.test.ts.
 */

import * as Y from 'yjs';
import { ORBIT_EPOCH_MS } from './orbits';
import { FUEL_METER_MAX } from './shipDoc';
import { planPlanetTransfer } from './solarOrbits';
import type { InterplanetaryPlan } from './solarOrbits';
import { FUEL_PER_KMS } from './stationDirectory';
import { MAX_ORBIT_SLOTS, PLANETS, moveBelongsTo, planetById, setStationMoveResolver } from './stations';
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
    && r.mode === 'thrusters'
    && typeof r.fuel === 'number' && Number.isInteger(r.fuel) && r.fuel >= 0 && r.fuel <= FUEL_METER_MAX
    && typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX;
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
  };
}

export type MovePhase = 'scheduled' | 'transit' | 'arrived';

export function movePhase(move: StationMove, realMs: number): MovePhase {
  if (realMs < move.departAt) return 'scheduled';
  return realMs < move.arriveAt ? 'transit' : 'arrived';
}

/** The interplanetary plan a move follows, rebuilt from its record: the same
 *  sun orbits, pinned to the record's own departure. */
export function movePlan(move: StationMove): InterplanetaryPlan | null {
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
  /** Where this draw starts the tank's meter (shipDoc.fuelDrawFloor). */
  meter: number;
  /** Modules in the station (its atlas component): the mass the burns push. */
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

/** The lowest orbit slot around `planetId` no listed station holds. */
export function freeSlotAround(planetId: string, stations: StationRecord[], exceptId?: string): number | null {
  const id = planetById(planetId).id;
  const used = new Set(stations.filter((s) => s.id !== exceptId && planetById(s.planetId).id === id).map((s) => s.orbitSlot));
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
  if (!station) return null;
  const to = planetById(toPlanetId).id;
  if (to === planetById(station.planetId).id) return null;
  const toSlot = freeSlotAround(to, stations, station.id);
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
      fuel: quote.fuel,
      fuelDrawn: ctx.meter + quote.fuel,
    },
  };
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
    case 'no-thrusters': return 'Fit an ENGINE BLOCK to this module to burn for another planet.';
    case 'no-fuel': return `Needs ${quote?.fuel ?? '?'} fuel for both burns; ${Math.floor(fuel)} aboard. Fit more FUEL TANKs and refuel, or wait for a tug.`;
  }
}

/** The status line for a move in progress. */
export function describeMove(move: StationMove, realMs: number): string {
  const to = planetById(move.toPlanetId).name;
  switch (movePhase(move, realMs)) {
    case 'scheduled': return `Leaving for ${to} at the launch window in ${formatLongSpan(move.departAt - realMs)}.`;
    case 'transit': return `In transit to ${to}: arriving in ${formatLongSpan(move.arriveAt - realMs)}.`;
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
const MAX_REMEMBERED = 32;

export function readRememberedMoves(): StationMove[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isStationMove).slice(0, MAX_REMEMBERED).map(cleanMove);
  } catch { return []; }
}

/** Two moves of the same station: by welcome room, or by id without one. */
function sameStation(a: StationMove, b: StationMove): boolean {
  return a.welcomeRoomId ? a.welcomeRoomId === b.welcomeRoomId : !b.welcomeRoomId && a.stationId === b.stationId;
}

/** Remember a move this install has seen — from the helm room, or from the
 *  per-planet summary. A later departure for the same station replaces an
 *  earlier one; an older one is ignored. Returns whether the list changed. */
export function rememberMove(move: StationMove): boolean {
  if (!isStationMove(move)) return false;
  const list = readRememberedMoves();
  const at = list.findIndex((m) => sameStation(m, move));
  if (at >= 0) {
    const old = list[at];
    if (old.departAt > move.departAt) return false;
    if (JSON.stringify(old) === JSON.stringify(cleanMove(move))) return false;
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
  return readRememberedMoves().find((m) => moveBelongsTo(m, station)) ?? null;
}

/** Point stations.listStations at the remembered moves. */
export function installStationMoveResolver(): void {
  setStationMoveResolver(rememberedMoveFor);
}

// ── The room doc ─────────────────────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
let keepMap: Y.Map<unknown> | null = null;
let unobserve: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch (err) { console.warn('[station move] listener failed', err); }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && keepMap !== null;
}

/** The room's move record, or null (none, unbound, or malformed). */
export function readStationMove(): StationMove | null {
  if (!docAlive()) return null;
  const raw = keepMap!.get('move');
  return isStationMove(raw) ? cleanMove(raw) : null;
}

/** Bind the room doc — beside bindStationKeepingDoc. Every move the room
 *  carries is remembered on this install. */
export function bindStationMoveDoc(doc: Y.Doc): void {
  unobserve?.();
  boundDoc = doc;
  const map = doc.getMap('stationKeeping');
  keepMap = map;
  const onChange = () => {
    const move = readStationMove();
    if (move) rememberMove(move);
    notify();
  };
  map.observe(onChange);
  unobserve = () => map.unobserve(onChange);
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
    keepMap!.set('move', clean);
  });
  rememberMove(clean);
  return true;
}
