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
 * "station-keeping burns are discrete events"): each nudge is ONE burn that
 * rewrites the trim record — the radius offset, the phase offset AT the burn,
 * and the burn's time. Where the station is at any other moment is computed
 * from those three numbers, never stored or ticked. The burn's fuel rides the
 * same write: the record carries the fuel trim burns have drawn so far, which
 * the tank reads as station keeping's draw meter (shipDoc.setFuelDrawMeter),
 * so a burn and a REFUEL or DEPART from another tab both keep their cost when
 * they sync.
 *
 * Storage: the `stationKeeping` map in the HELM ROOM's doc (key 'trim') —
 * shared by everyone in the room, like the ship doc. The record names the
 * orbit it trims by its BASIS — planet and slot, the two numbers the slot's
 * orbit is derived from — not by a station id: station records are still
 * kept per install, so two people in the room may know the station by
 * different ids, but everyone who puts it in the same slot derives the same
 * trimmed orbit, and anyone who puts it elsewhere ignores the trim rather
 * than misapplying it. Trust: owner-writes at the UI, honest-client reads
 * with shape guards and clamps (the shipDoc posture). Other rooms of the
 * station do not see a trim until station records are shared (the
 * per-planet summary); until then the holotable and ship transfers keep
 * using the slot's orbit.
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

/** One station's trim — written whole by each burn. Plain JSON. The orbit
 *  it trims is named by its basis (planet and slot), never by a station id:
 *  see the header. */
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
  /** Real ms of the burn that wrote this record. */
  at: number;
  /** Which way that burn pushed. */
  last: TrimDirection;
  /** Fuel trim burns have drawn from this module's tanks, every burn so far:
   *  station keeping's draw meter. Each burn raises it by TRIM_FUEL in the
   *  same write as the burn. Absent on a record from before the meter: 0. */
  fuelDrawn?: number;
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

/** Shape guard — a hostile peer can write anything into the map. */
export function isOrbitTrim(v: unknown): v is OrbitTrim {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof OrbitTrim, unknown>>;
  return typeof r.planetId === 'string' && r.planetId.length > 0 && r.planetId.length <= MAX_PLANET_ID_LEN
    && Number.isInteger(r.slot) && (r.slot as number) >= 0 && (r.slot as number) < MAX_ORBIT_SLOTS
    && typeof r.dRadiusKm === 'number' && Number.isFinite(r.dRadiusKm) && Math.abs(r.dRadiusKm) <= MAX_TRIM_KM
    && typeof r.dPhase === 'number' && Number.isFinite(r.dPhase) && Math.abs(r.dPhase) <= Math.PI
    && typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= ORBIT_EPOCH_MS && r.at <= MAX_AT_MS
    && typeof r.last === 'string' && (TRIM_DIRECTIONS as readonly string[]).includes(r.last)
    && (r.fuelDrawn === undefined
      || (typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX));
}

/** Only the fields a trim has — what a write publishes. */
function cleanTrim(t: OrbitTrim): OrbitTrim {
  const clean: OrbitTrim = {
    planetId: t.planetId,
    slot: t.slot,
    dRadiusKm: t.dRadiusKm,
    dPhase: t.dPhase,
    at: t.at,
    last: t.last,
  };
  if (t.fuelDrawn !== undefined) clean.fuelDrawn = t.fuelDrawn;
  return clean;
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
  /** The doc's record, as read — trimFor is applied here, not by the caller. */
  trim: OrbitTrim | null;
  commander: boolean;
  /** Engine blocks mounted on this module (its thrusters). */
  engines: number;
  /** Fuel aboard, already clamped to the tanks' capacity. */
  fuel: number;
  /** What the tank's meter owes its level (shipDoc.fuelDrawDeficit), added
   *  to this burn's draw. */
  deficit: number;
  now: number;
}

export type TrimPlan = { ok: true; trim: OrbitTrim } | { ok: false; refusal: TrimRefusal };

/**
 * One burn of the stick: the trim record it writes, or why it cannot fire.
 * RAISE / LOWER move the radius a step and keep the station where it is right
 * now (its offset from the slot carries across the burn, so nothing jumps);
 * AHEAD / BACK slide it a step along the orbit and keep the radius.
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

  const base = slotOrbit(station);
  const radius = current?.dRadiusKm ?? 0;
  const offset = slotOffsetAt(base, current, now);
  let dRadiusKm = radius;
  let dPhase = offset;
  if (dir === 'raise') dRadiusKm = radius + TRIM_STEP_KM;
  else if (dir === 'lower') dRadiusKm = radius - TRIM_STEP_KM;
  else if (dir === 'ahead') dPhase = offset + PHASE_STEP_RAD;
  else dPhase = offset - PHASE_STEP_RAD;
  // Whole steps from zero stay exact in binary; the rounding only mops up a
  // peer-written radius that was not a whole step.
  dRadiusKm = Math.round(dRadiusKm * 1000) / 1000;
  if (Math.abs(dRadiusKm) > MAX_TRIM_KM) return { ok: false, refusal: 'at-limit' };
  return {
    ok: true,
    trim: {
      planetId: base.planet.id,
      slot: station.orbitSlot,
      dRadiusKm,
      dPhase: signedAngle(dPhase),
      at: now,
      last: dir,
      // The record's own running total, whatever basis it trimmed.
      fuelDrawn: (ctx.trim?.fuelDrawn ?? 0) + ctx.deficit + TRIM_FUEL,
    },
  };
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

let boundDoc: Y.Doc | null = null;
let keepMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

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

/** Bind the room doc — at the T0 seam beside bindShipDoc. The trim record's
 *  running fuel total becomes one of the tank's draw meters. */
export function bindStationKeepingDoc(doc: Y.Doc): void {
  boundDoc = doc;
  keepMap = doc.getMap('stationKeeping');
  keepMap.observe(() => notify());
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

/** The room's trim record, or null (none, unbound, or malformed). */
export function readOrbitTrim(): OrbitTrim | null {
  if (!docAlive()) return null;
  const raw = keepMap!.get('trim');
  return isOrbitTrim(raw) ? cleanTrim(raw) : null;
}

/** Fuel trim burns have drawn in this room: station keeping's draw meter. */
export function readFuelDrawn(): number {
  return readOrbitTrim()?.fuelDrawn ?? 0;
}

/**
 * Publish a burn's trim record: the burn and its fuel (fuelDrawn) in one
 * write, so peers never see one without the other. Owner-gated at the caller.
 * Returns whether it wrote.
 *
 * The burn never writes the fuel level itself, so a REFUEL or DEPART fired at
 * the same moment from another tab (or an offline one) cannot wipe out its
 * cost, nor it theirs: after the sync the tank reads both debits (see
 * shipDoc.setFuelDrawMeter). Two burns fired at once both write this one key,
 * and Yjs keeps one of them whole: the room converges on one burn and that
 * burn's fuel. The other press drops whole, and its dashboard redraws from
 * the doc on the next sync.
 */
export function writeOrbitTrim(trim: OrbitTrim): boolean {
  if (!docAlive()) return false;
  const clean = cleanTrim(trim);
  if (!isOrbitTrim(clean)) {
    console.warn('[station keeping] refused to write a malformed trim', trim);
    return false;
  }
  boundDoc!.transact(() => {
    keepMap!.set('trim', clean);
  });
  return true;
}
