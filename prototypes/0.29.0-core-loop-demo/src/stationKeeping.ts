/**
 * 🛰️ Station keeping — the station's own small stick (owner request,
 * 2026-09-27: "stations and ships should have slightly different flight
 * control dashboards … the station could have a small one for fine orbital
 * maintenance control").
 *
 * WHICH FACE THE HELM SHOWS. The helm console is one piece of furniture with
 * two faces. A module BOLTED into a station (a door connected by a gangway,
 * which is structure: a dock can be released, a gangway cannot) steers the
 * STATION, so its helm opens the station keeping face (stationHelm.ts). Any
 * other module flies ITSELF: the ship helm (devices.ts createHelmUI). It is
 * the same line the ship helm already draws when it says a bolted module
 * cannot fly.
 *
 * THE ORBIT. Stations fly perfect circles (orbits.ts, owner pick 2026-09-27):
 * a station's slot fixes its radius and its phase. Station keeping adds a
 * TRIM on top — the orbit's radius offset from the slot's, and how far along
 * the orbit the station sits from its slot's nominal position. The trimmed
 * orbit is just another CircularOrbit, so everything orbits.ts does works on
 * it.
 *
 * Kepler stays honest: a lower orbit is a faster one. A station trimmed 2 km
 * below its slot creeps AHEAD of the slot (about 6° per real hour at
 * Furlong's altitude) and one trimmed high falls behind. Keeping the station
 * on its slot is the maintenance job: bring the radius back and nudge the
 * phase home.
 *
 * Derive, don't tick (STUDY-Architecture v006 §8.2; the Phase 2 plan's
 * "station-keeping burns are discrete events"): each nudge is ONE burn, kept
 * as its own entry: which way it pushed, the orbit it trimmed, when, and the
 * fuel it took. The trim is the burns replayed in time order: the radius
 * offset, the phase offset AT the last burn, and that burn's time. Where the
 * station is at any other moment is computed from those three numbers, never
 * stored or ticked. The burns' fuel, added up, is station keeping's draw
 * meter on the tank (shipDoc.setFuelDrawMeter), so a burn and a REFUEL or
 * DEPART from another tab both keep their cost when they sync.
 *
 * Storage: the `stationKeeping` map in the HELM ROOM's doc, shared by
 * everyone in the room like the ship doc. Each burn is written once under a
 * key of its own (writeTrimBurn) and never replaced, so two burns fired at
 * once from two tabs, or one from a tab that was offline, both land: every
 * client replays the same burns to the same trim, and the meter only grows
 * (a merge never refunds a burn). The log grows by one small entry per burn.
 * A room trimmed before the log keeps its one 'trim' record, and the replay
 * starts from it. A burn names the orbit it trims by its BASIS — planet and
 * slot, the two numbers the slot's orbit is derived from — not by a station
 * id: station records are still kept per install, so two people in the room
 * may know the station by different ids, but everyone who puts it in the
 * same slot derives the same trimmed orbit, and anyone who puts it elsewhere
 * ignores the trim rather than misapplying it. Trust: owner-writes at the
 * UI, honest-client reads with shape guards and clamps (the shipDoc
 * posture). Other rooms of the station do not see a trim until station
 * records are shared (the per-planet summary); until then the holotable and
 * ship transfers keep using the slot's orbit.
 *
 * Pure except for the doc binding. Pinned by stationKeeping.test.ts.
 */

import * as Y from 'yjs';
import type { DoorRecord } from './doorsDoc';
import { ORBIT_EPOCH_MS, ORBIT_TIME_SCALE, circularOrbit, orbitForSlot, orbitalSeconds, wrapAngle } from './orbits';
import type { CircularOrbit } from './orbits';
import { FUEL_METER_MAX, setFuelDrawMeter } from './shipDoc';
import { isBerthDoor } from './stationAtlas';
import { MAX_ORBIT_SLOTS, planetById } from './stations';
import type { StationRecord } from './stations';

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

// ── Which face the helm shows ────────────────────────────────────────────────

/**
 * Is this module part of a station's structure? True when any of its doors is
 * paired and is not a berth — the same line station grouping draws
 * (stationAtlas.isBerthDoor: a transient guest berth or a docking-adapter
 * chain is a ship calling, not structure).
 */
export function isBoltedIntoStation(doors: Iterable<DoorRecord>): boolean {
  for (const rec of doors) {
    if (rec.paired !== true) continue;
    if (isBerthDoor(rec)) continue;
    return true;
  }
  return false;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** RAISE / LOWER: one burn moves the orbit this far from the planet. */
export const TRIM_STEP_KM = 2;

/** The trim keeps the orbit within this of its slot's radius. Slots are
 *  1,690 km apart or more (orbits.ts), so a trimmed station never strays
 *  near a neighbour's orbit. */
export const MAX_TRIM_KM = 20;

/** AHEAD / BACK: one burn slides the station this far along its orbit. */
export const PHASE_STEP_DEG = 0.5;
export const PHASE_STEP_RAD = PHASE_STEP_DEG * DEG;

/** A burn fires for this long (real ms); the next one waits for it. */
export const BURN_MS = 2_500;

/** Fuel units one burn takes from the module's own tanks (shipDoc fuel). */
export const TRIM_FUEL = 1;

/** Within this of its slot, at the slot's altitude, a station is on station. */
export const ON_STATION_DEG = 1;

export type TrimDirection = 'raise' | 'lower' | 'ahead' | 'back';

export const TRIM_DIRECTIONS: readonly TrimDirection[] = ['raise', 'lower', 'ahead', 'back'];

// ── The trim record ──────────────────────────────────────────────────────────

/** One station's trim: where its burns have left it (replayBurns). Plain
 *  JSON. The orbit it trims is named by its basis (planet and slot), never
 *  by a station id: see the header. */
export interface OrbitTrim {
  /** The planet the orbit goes round (a PLANETS id, as orbits.ts resolves
   *  it). */
  planetId: string;
  /** The slot it was trimmed in. A station moved to another slot or planet
   *  flies that slot's orbit untrimmed until its next burn. */
  slot: number;
  /** Orbit radius minus the slot's, km, within ±MAX_TRIM_KM. */
  dRadiusKm: number;
  /** Angle from the slot's nominal position at `at`, radians in (−π, π];
   *  positive is ahead (the direction of travel). */
  dPhase: number;
  /** Real ms of the last burn. */
  at: number;
  /** Which way that burn pushed. */
  last: TrimDirection;
  /** Only on the 'trim' record kept before the burn log: the fuel its burns
   *  had drawn. The log's burns add theirs on top. */
  fuelDrawn?: number;
}

/** One burn of the stick, as the log keeps it. Plain JSON. */
export interface TrimBurn {
  /** The basis of the orbit it trimmed: a PLANETS id and a slot. */
  planetId: string;
  slot: number;
  /** Which way it pushed. */
  dir: TrimDirection;
  /** Real ms it fired. */
  at: number;
  /** Fuel it took from this module's tanks. */
  fuel: number;
}

/** An angle folded into (−π, π]. */
export function signedAngle(a: number): number {
  const w = wrapAngle(a);
  return w > Math.PI ? w - TAU : w;
}

const MAX_PLANET_ID_LEN = 128;
/** A burn's time must sit between the orbital epoch and a century after it —
 *  a bound that keeps the phase arithmetic finite and exact enough, not a
 *  freshness rule (a peer's clock may run ahead; the offset line is
 *  continuous either side of `at`). */
const MAX_AT_MS = ORBIT_EPOCH_MS + 100 * 365.25 * 24 * 3600 * 1000;

/** A burn takes at most this much fuel: a bound on a peer-written entry, far
 *  above TRIM_FUEL. */
const MAX_BURN_FUEL = 1_000;

function isBasis(planetId: unknown, slot: unknown): boolean {
  return typeof planetId === 'string' && planetId.length > 0 && planetId.length <= MAX_PLANET_ID_LEN
    && Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < MAX_ORBIT_SLOTS;
}

function isBurnTime(at: unknown): boolean {
  return typeof at === 'number' && Number.isFinite(at) && at >= ORBIT_EPOCH_MS && at <= MAX_AT_MS;
}

function isDirection(v: unknown): v is TrimDirection {
  return typeof v === 'string' && (TRIM_DIRECTIONS as readonly string[]).includes(v);
}

/** Shape guard — a hostile peer can write anything into the map. */
export function isOrbitTrim(v: unknown): v is OrbitTrim {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof OrbitTrim, unknown>>;
  return isBasis(r.planetId, r.slot)
    && typeof r.dRadiusKm === 'number' && Number.isFinite(r.dRadiusKm) && Math.abs(r.dRadiusKm) <= MAX_TRIM_KM
    && typeof r.dPhase === 'number' && Number.isFinite(r.dPhase) && Math.abs(r.dPhase) <= Math.PI
    && isBurnTime(r.at)
    && isDirection(r.last)
    && (r.fuelDrawn === undefined
      || (typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX));
}

/** Shape guard for a burn off the wire. */
export function isTrimBurn(v: unknown): v is TrimBurn {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof TrimBurn, unknown>>;
  return isBasis(r.planetId, r.slot)
    && isDirection(r.dir)
    && isBurnTime(r.at)
    && typeof r.fuel === 'number' && r.fuel > 0 && r.fuel <= MAX_BURN_FUEL;
}

/** A trim's orbit fields only (a record from before the log also carries
 *  its fuel, which the meter reads apart). */
function cleanTrim(t: OrbitTrim): OrbitTrim {
  return { planetId: t.planetId, slot: t.slot, dRadiusKm: t.dRadiusKm, dPhase: t.dPhase, at: t.at, last: t.last };
}

/** Only the fields a burn has — what a write publishes. */
function cleanBurn(b: TrimBurn): TrimBurn {
  return { planetId: b.planetId, slot: b.slot, dir: b.dir, at: b.at, fuel: b.fuel };
}

/** The trim that applies to `station`: the record, while it names the
 *  planet and slot the station flies (the planet as orbits.ts resolves it,
 *  so an unknown id matches the default planet it orbits); otherwise none. */
export function trimFor(
  station: Pick<StationRecord, 'planetId' | 'orbitSlot'> | null,
  trim: OrbitTrim | null,
): OrbitTrim | null {
  if (!station || !trim) return null;
  return trim.planetId === planetById(station.planetId).id && trim.slot === station.orbitSlot ? trim : null;
}

// ── The trimmed orbit (on orbits.ts) ─────────────────────────────────────────

/** The station's UNTRIMMED slot orbit — the basis every trim is measured
 *  from. Not orbits.stationOrbit: that one follows a station's trim once a
 *  trim resolver is installed, and measuring from it would apply the trim
 *  twice. */
export function slotOrbit(station: Pick<StationRecord, 'planetId' | 'orbitSlot'>): CircularOrbit {
  return orbitForSlot(station.planetId, station.orbitSlot);
}

/**
 * The station's orbit with its trim applied: a circle `dRadiusKm` farther out,
 * with that radius's own Kepler speed and period, phased so the station sits
 * `dPhase` from the slot's nominal position at the burn. No trim ⇒ the slot's
 * orbit, unchanged.
 */
export function trimmedOrbit(base: CircularOrbit, trim: OrbitTrim | null): CircularOrbit {
  if (!trim) return base;
  const radiusKm = base.radiusKm + trim.dRadiusKm;
  const meanMotion = Math.sqrt(base.planet.mu / radiusKm ** 3);
  return circularOrbit(
    base.planet,
    radiusKm,
    base.phase0 + trim.dPhase - (meanMotion - base.meanMotion) * orbitalSeconds(trim.at),
  );
}

/** How far along its orbit the station sits from its slot's nominal position
 *  at a real time — radians in (−π, π], positive ahead. */
export function slotOffsetAt(base: CircularOrbit, trim: OrbitTrim | null, realMs: number): number {
  if (!trim) return 0;
  const drift = trimmedOrbit(base, trim).meanMotion - base.meanMotion;
  return signedAngle(trim.dPhase + drift * (orbitalSeconds(realMs) - orbitalSeconds(trim.at)));
}

/** How fast the station drifts from its slot — radians per REAL hour,
 *  positive ahead. Zero at the slot's own radius. */
export function slotDriftPerHour(base: CircularOrbit, trim: OrbitTrim | null): number {
  if (!trim) return 0;
  return (trimmedOrbit(base, trim).meanMotion - base.meanMotion) * ORBIT_TIME_SCALE * 3600;
}

/** Is the station on its slot: at the slot's radius and within ON_STATION_DEG
 *  of the slot's position? */
export function isOnStation(base: CircularOrbit, trim: OrbitTrim | null, realMs: number): boolean {
  if (!trim) return true;
  return Math.abs(trim.dRadiusKm) < 1e-9 && Math.abs(slotOffsetAt(base, trim, realMs)) < ON_STATION_DEG * DEG;
}

/** Is a burn firing at `realMs`? A burn stamped ahead of our clock (a peer
 *  running fast) is not yet firing here — it never blocks the stick. */
export function isBurning(trim: OrbitTrim | null, realMs: number): boolean {
  return !!trim && realMs >= trim.at && realMs - trim.at < BURN_MS;
}

// ── Burns ────────────────────────────────────────────────────────────────────

/** Why the stick will not fire, in the order the helm checks. */
export type TrimRefusal =
  | 'not-bolted' // the module is no longer station structure (a gangway came down)
  | 'no-station' // the atlas does not place this module in a station yet
  | 'not-commander' // only the module's owner flies the station
  | 'no-thrusters' // no engine block on this module
  | 'no-fuel' // the module's tanks are dry (or it has none)
  | 'burning' // the last burn is still firing
  | 'at-limit'; // RAISE / LOWER would leave the trim band

export interface TrimContext {
  /** Is the module STILL bolted into a station (isBoltedIntoStation, read
   *  live — the face was picked when the helm opened, and a peer can take a
   *  gangway down while it is open)? */
  bolted: boolean;
  station: Pick<StationRecord, 'planetId' | 'orbitSlot'> | null;
  /** The room's trim, as read — trimFor is applied here, not by the caller. */
  trim: OrbitTrim | null;
  commander: boolean;
  /** Engine blocks mounted on this module (its thrusters). */
  engines: number;
  /** Fuel aboard, already clamped to the tanks' capacity. */
  fuel: number;
  now: number;
}

/** A burn the stick may fire — the entry to write and the trim it leaves —
 *  or why it cannot fire. */
export type TrimPlan = { ok: true; burn: TrimBurn; trim: OrbitTrim } | { ok: false; refusal: TrimRefusal };

/**
 * One burn applied to the trim it finds: the trim after it, or null when it
 * would take the radius past ±MAX_TRIM_KM. A trim on another basis does not
 * carry over: the burn starts from its slot's own orbit. RAISE / LOWER move
 * the radius a step and keep the station where it is at the burn (its offset
 * from the slot carries across, so nothing jumps); AHEAD / BACK slide it a
 * step along the orbit and keep the radius.
 */
export function applyBurn(before: OrbitTrim | null, burn: Pick<TrimBurn, 'planetId' | 'slot' | 'dir' | 'at'>): OrbitTrim | null {
  const current = before && before.planetId === burn.planetId && before.slot === burn.slot ? before : null;
  const base = orbitForSlot(burn.planetId, burn.slot);
  const radius = current?.dRadiusKm ?? 0;
  const offset = slotOffsetAt(base, current, burn.at);
  let dRadiusKm = radius;
  let dPhase = offset;
  if (burn.dir === 'raise') dRadiusKm = radius + TRIM_STEP_KM;
  else if (burn.dir === 'lower') dRadiusKm = radius - TRIM_STEP_KM;
  else if (burn.dir === 'ahead') dPhase = offset + PHASE_STEP_RAD;
  else dPhase = offset - PHASE_STEP_RAD;
  // Whole steps from zero stay exact in binary; the rounding only mops up a
  // peer-written radius that was not a whole step.
  dRadiusKm = Math.round(dRadiusKm * 1000) / 1000;
  if (Math.abs(dRadiusKm) > MAX_TRIM_KM) return null;
  return { planetId: burn.planetId, slot: burn.slot, dRadiusKm, dPhase: signedAngle(dPhase), at: burn.at, last: burn.dir };
}

/** Burn order: by time, then by every other field, so all clients replay
 *  the same burns in the same order (plain code-unit order: never the
 *  locale's). */
function burnOrder(a: TrimBurn, b: TrimBurn): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
  if (a.planetId !== b.planetId) return a.planetId < b.planetId ? -1 : 1;
  if (a.slot !== b.slot) return a.slot - b.slot;
  return a.fuel - b.fuel;
}

/**
 * Where a run of burns leaves the trim, and the fuel they drew: each burn in
 * time order, from the trim and fuel before them. A burn that would leave
 * the band changes nothing but still pays — its fuel burned wherever it
 * fired, and a burn that arrives late (from a tab that was offline) must
 * never make an earlier one free.
 */
export function replayBurns(
  burns: readonly TrimBurn[],
  start: OrbitTrim | null = null,
  startFuel = 0,
): { trim: OrbitTrim | null; fuelDrawn: number } {
  let trim = start;
  let fuelDrawn = startFuel;
  for (const burn of [...burns].sort(burnOrder)) {
    fuelDrawn += burn.fuel;
    trim = applyBurn(trim, burn) ?? trim;
  }
  return { trim, fuelDrawn };
}

/**
 * One burn of the stick: the burn to write and the trim it leaves, or why it
 * cannot fire (see applyBurn for what each direction does).
 */
export function planTrim(ctx: TrimContext, dir: TrimDirection): TrimPlan {
  const { station, now } = ctx;
  if (!ctx.bolted) return { ok: false, refusal: 'not-bolted' };
  if (!station) return { ok: false, refusal: 'no-station' };
  if (!ctx.commander) return { ok: false, refusal: 'not-commander' };
  if (ctx.engines < 1) return { ok: false, refusal: 'no-thrusters' };
  if (!(ctx.fuel >= TRIM_FUEL)) return { ok: false, refusal: 'no-fuel' };
  const current = trimFor(station, ctx.trim);
  if (isBurning(current, now)) return { ok: false, refusal: 'burning' };
  const burn: TrimBurn = { planetId: planetById(station.planetId).id, slot: station.orbitSlot, dir, at: now, fuel: TRIM_FUEL };
  const trim = applyBurn(current, burn);
  return trim ? { ok: true, burn, trim } : { ok: false, refusal: 'at-limit' };
}

// ── What the dashboard says ──────────────────────────────────────────────────

const DIRECTION_WORDS: Record<TrimDirection, string> = {
  raise: `raising the orbit ${TRIM_STEP_KM} km`,
  lower: `lowering the orbit ${TRIM_STEP_KM} km`,
  ahead: `sliding ${PHASE_STEP_DEG}° ahead`,
  back: `sliding ${PHASE_STEP_DEG}° back`,
};

/** "0.8° ahead of the slot" / "on the slot". */
export function describeOffset(offset: number): string {
  const deg = Math.abs(offset) / DEG;
  if (deg < 0.05) return 'on the slot';
  return `${deg.toFixed(1)}° ${offset > 0 ? 'ahead of' : 'behind'} the slot`;
}

/** "drifting ahead 6.2°/h" / "holding". */
export function describeDrift(perHour: number): string {
  const deg = Math.abs(perHour) / DEG;
  if (deg < 0.05) return 'holding';
  return `drifting ${perHour > 0 ? 'ahead' : 'back'} ${deg.toFixed(1)}°/h`;
}

/** Why the stick will not fire, in the dashboard's words. `tanks` picks
 *  between "fit a tank" and "refuel it". */
export function describeRefusal(refusal: TrimRefusal, tanks: number, dRadiusKm = 0): string {
  switch (refusal) {
    case 'not-bolted':
      return 'This module is no longer bolted into a station, so it flies as a ship now. Its helm is on the FUEL & DOCKING tab.';
    case 'no-station':
      return 'The station map does not place this module in a station yet.';
    case 'not-commander':
      return 'Only the owner of this module flies the station.';
    case 'no-thrusters':
      return 'No thrusters. Mount an ENGINE BLOCK on this module\'s hull (edit mode) to fire trim burns.';
    case 'no-fuel':
      return tanks > 0
        ? `The tanks are dry. Refuel on the FUEL & DOCKING tab; each burn takes ${TRIM_FUEL} fuel.`
        : `No propellant. Fit a FUEL TANK to this module; each burn takes ${TRIM_FUEL} fuel.`;
    case 'burning':
      return 'A burn is firing. The stick is ready again when it ends.';
    case 'at-limit':
      return `The orbit is already ${MAX_TRIM_KM} km ${dRadiusKm > 0 ? 'above' : 'below'} its slot, as far as trim goes.`;
  }
}

/** The dashboard's status line when nothing refuses: the burn firing, on
 *  station, or what to do to get back there. */
export function describeTrimStatus(base: CircularOrbit, trim: OrbitTrim | null, realMs: number): string {
  if (trim && isBurning(trim, realMs)) return `BURNING: ${DIRECTION_WORDS[trim.last]}.`;
  if (isOnStation(base, trim, realMs)) return 'ON STATION. The station is holding its slot.';
  const offset = slotOffsetAt(base, trim, realMs);
  const dR = trim?.dRadiusKm ?? 0;
  if (Math.abs(dR) > 1e-9) {
    const low = dR < 0;
    return `The orbit is ${Math.abs(dR).toFixed(1)} km ${low ? 'below' : 'above'} its slot, so the station runs `
      + `${low ? 'faster and creeps ahead' : 'slower and falls behind'}. ${low ? 'RAISE' : 'LOWER'} it back to stop the drift.`;
  }
  return `At the slot's height, ${describeOffset(offset)}. Nudge ${offset > 0 ? 'BACK' : 'AHEAD'} to return.`;
}

// ── Doc binding (mirror of bindShipDoc) ──────────────────────────────────────

/** The record a room trimmed before the burn log kept: where replay starts. */
const TRIM_KEY = 'trim';
/** Every burn's key starts so; the rest names the client and the time. */
const BURN_KEY_PREFIX = 'burn:';

let boundDoc: Y.Doc | null = null;
let keepMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();
/** The bound map's burns replayed: dropped whenever the map changes. */
let replayed: { trim: OrbitTrim | null; fuelDrawn: number } | null = null;

function notify(): void {
  // Copy: a listener may unsubscribe mid-notify. Isolate: one throwing
  // listener must not kill the others or Yjs's transaction cleanup.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[station keeping] listener threw during doc notify:', err);
    }
  }
}

/** Bind the room doc — at the T0 seam beside bindShipDoc. The burns' fuel,
 *  added up, becomes one of the tank's draw meters. */
export function bindStationKeepingDoc(doc: Y.Doc): void {
  boundDoc = doc;
  const map = doc.getMap('stationKeeping');
  keepMap = map;
  replayed = null;
  map.observe(() => {
    if (keepMap === map) replayed = null;
    notify();
  });
  setFuelDrawMeter('stationKeeping', { read: readFuelDrawn, subscribe: subscribeStationKeeping });
  notify();
}

export function subscribeStationKeeping(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && keepMap !== null;
}

/** The bound room's burns, replayed from its record from before the log.
 *  Malformed entries are skipped, the same on every client. */
function replayRoom(): { trim: OrbitTrim | null; fuelDrawn: number } {
  if (replayed) return replayed;
  const record = keepMap!.get(TRIM_KEY);
  const start = isOrbitTrim(record) ? record : null;
  const burns: TrimBurn[] = [];
  keepMap!.forEach((v, key) => {
    if (key.startsWith(BURN_KEY_PREFIX) && isTrimBurn(v)) burns.push(cleanBurn(v));
  });
  replayed = replayBurns(burns, start && cleanTrim(start), start?.fuelDrawn ?? 0);
  return replayed;
}

/** The room's trim (its burns replayed), or null: none, unbound, or nothing
 *  well-formed. */
export function readOrbitTrim(): OrbitTrim | null {
  if (!docAlive()) return null;
  const { trim } = replayRoom();
  return trim && { ...trim };
}

/** Fuel trim burns have drawn in this room — every burn's, added up:
 *  station keeping's draw meter. It only grows. */
export function readFuelDrawn(): number {
  return docAlive() ? replayRoom().fuelDrawn : 0;
}

/**
 * Publish a burn: its own entry, under a key that names this client and the
 * burn's time, so no other write replaces it — two burns fired at once from
 * two tabs (or an offline one) both land, and every client replays the same
 * burns to the same trim. The burn's fuel rides the same entry, so peers
 * never see one without the other, and the meter it adds to only grows. The
 * burn never writes the fuel level itself, so a REFUEL or DEPART fired at
 * the same moment keeps its cost too (see shipDoc.setFuelDrawMeter).
 * Owner-gated at the caller. Returns whether it wrote: a malformed burn, or
 * a second one from this client in the same millisecond, is refused.
 */
export function writeTrimBurn(burn: TrimBurn): boolean {
  if (!docAlive()) return false;
  const clean = cleanBurn(burn);
  if (!isTrimBurn(clean)) {
    console.warn('[station keeping] refused to write a malformed burn', burn);
    return false;
  }
  const key = `${BURN_KEY_PREFIX}${boundDoc!.clientID}:${clean.at}`;
  if (keepMap!.has(key)) return false;
  boundDoc!.transact(() => {
    keepMap!.set(key, clean);
  });
  return true;
}
