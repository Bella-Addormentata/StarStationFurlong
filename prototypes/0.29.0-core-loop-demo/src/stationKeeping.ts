/**
 * 🛰️ Station keeping — the station's own small stick (owner request,
 * 2026-09-27: "stations and ships should have slightly different flight
 * control dashboards … the station could have a small one for fine orbital
 * maintenance control").
 *
 * WHICH FACE THE HELM SHOWS. The helm console is one piece of furniture with
 * two faces. A module BOLTED into a station (a door connected by a gangway,
 * which is structure: a dock can be released, a gangway cannot) steers the
 * STATION, so its helm opens the station keeping face (stationHelm.ts), and
 * so does a station's own welcome room standing alone, a one-module station
 * (steersStation). Any other module flies ITSELF: the ship helm (devices.ts
 * createHelmUI), which the station face keeps one tab away. "Bolted" is the
 * line the ship helm already draws when it says a bolted module cannot fly,
 * except that a pairing whose address names no room (none at all, or one the
 * atlas cannot read) or names the room itself joins nothing, and a connection
 * flagged as a berth at either end is a berth, as in the atlas.
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
 * A burn only fires if the fuel covers it. Two tabs can each see the last
 * unit of fuel and both burn, or one can burn beside a DEPART that takes the
 * rest; when they sync, every client drops the burns the level cannot cover
 * (shipDoc.fuelCeiling), the latest first, and a dropped burn neither moves
 * the orbit nor takes fuel. Each burn carries what its tanks held when it
 * fired, so it is held to the fuel it could draw on then: never fuel
 * stranded by a tank taken off before it, and a tank taken off after it
 * never takes it back. Station keeping yields to every other draw, because
 * a trim nudge is the one fuel spend here that can be taken back.
 *
 * Storage: the `stationKeeping` map in the HELM ROOM's doc, shared by
 * everyone in the room like the ship doc. Each burn is written once under a
 * key of its own (writeTrimBurn) and never replaced, so two burns fired at
 * once from two tabs, or one from a tab that was offline, both land: every
 * client replays the same burns to the same trim, and merging burns never
 * loses one or its fuel. Each level write (REFUEL, DEPART) SETTLES the log:
 * the fuel record keeps, beside the meter's reading, where the burns so far
 * left the trim, the fuel they drew, the keys of the burns it covered, paid
 * for or dropped, and each orbit's last burn to fire, which that orbit's
 * lockout still follows (KeepingSettlement). Nothing it keeps is dated past
 * the write by the writer's clock: a trim that a burn stamped ahead (a peer's
 * clock running fast) dates later is re-dated to the write, on the same
 * orbit, so the burns after the write still fire at their own times, and the
 * lockout keeps the burn firing at the write. The replay starts from the
 * settlement, a dropped burn stays dropped whatever the next REFUEL brings,
 * and the next burn clears the entries it covered. So the log holds only the
 * burns since the last level write. A burn that reaches us after a level
 * write settled later ones cannot be replayed before them: it applies, and
 * fires, at the time of the last one. The level is still one value: a stale
 * level write that wins the merge (from a tab offline across other level
 * writes) brings back its own settlement, and the burns settled since it
 * whose entries a later burn cleared are taken back, orbit and fuel, as that
 * write takes back the levels written since. A room trimmed before the log
 * keeps its one 'trim' record, and the replay starts from it until the first
 * settlement.
 *
 * A burn names the orbit it trims by its BASIS — planet and slot, the two
 * numbers the slot's orbit is derived from — not by a station id: station
 * records are still kept per install, so two people in the room may know the
 * station by different ids, but everyone who puts it in the same slot
 * derives the same trimmed orbit, and anyone who puts it elsewhere ignores
 * the trim rather than misapplying it. Each orbit keeps its own trim, through
 * the replay and every settlement, so a burn on one never undoes another's:
 * two tabs that place the room in different slots each keep theirs and read
 * their own (readOrbitTrim with the station). Trust: owner-writes at the UI,
 * honest-client reads with shape guards and clamps (the shipDoc posture);
 * the replay takes at most MAX_LOG burns since the last settlement, however
 * many a peer writes, and the rest wait for the next (a peer that writes
 * three times that many holds the stick at 'log-full' for good: the
 * settlements fill with keys only a burn clears). Other rooms of the
 * station do not see a trim until station records are shared (the
 * per-planet summary); until then the holotable and ship transfers keep
 * using the slot's orbit. Every room bolted into a station steers it, and
 * each keeps its own log: once the summary shares the station's trim
 * (setSharedTrimSource), a burn from a room whose own trim is not the newer
 * goes on from the shared one and carries it (TrimBurn.from). Each trim
 * counts the burns along its line (OrbitTrim.seq), so burns from any of the
 * station's helm rooms continue one orbit, whatever their clocks
 * (isNewerTrim). A burn replays after every burn its writer knew of, in
 * its room's log or along the trim it went on from, even one stamped ahead
 * of the writer's clock (TrimBurn.order, OrbitTrim.place), and each trim
 * knows whose burns its line holds (OrbitTrim.seen, and past its last
 * sixteen writers OrbitTrim.seenFloor), so no burn lands twice through a
 * trim carried past it, whenever that burn reaches the log, even after a
 * REFUEL settled that trim: it pays and fires, and the orbit stays.
 *
 * Pure except for the doc binding. Pinned by stationKeeping.test.ts.
 */

import * as Y from 'yjs';
import type { DoorRecord } from './doorsDoc';
import { ORBIT_EPOCH_MS, ORBIT_TIME_SCALE, baseOrbit, circularOrbit, isUsableOrbit, orbitalSeconds, wrapAngle } from './orbits';
import type { CircularOrbit } from './orbits';
import { FUEL_METER_MAX, fuelCeiling, readFuelSettlement, setFuelDrawMeter, shipVersion, subscribeShip } from './shipDoc';
import { berthDoorIds, isBerthDoor, readAtlas, roomIdFromSeed } from './stationAtlas';
import type { AtlasDoor, AtlasEntry } from './stationAtlas';
import { MAX_ORBIT_SLOTS, isStationRoom, orbitAfterMove, planetById } from './stations';
import type { StationOrbit, StationRecord } from './stations';

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

// ── Which face the helm shows ────────────────────────────────────────────────

/**
 * Is this module part of a station's structure? True when any of its doors is
 * paired to another room through a connection that is not a berth — the same
 * line station grouping draws. The atlas joins rooms only through an address
 * that names a room (stationAtlas.roomIdFromSeed), and calls a connection a
 * berth when EITHER end says so (stationAtlas.berthDoorIds): a transient
 * guest berth or a docking-adapter chain is a ship calling, not structure.
 * Given the room's id, a pairing addressed back to the room itself joins
 * nothing (the atlas still finds the room alone), and its live records are
 * matched with what the atlas holds of the far rooms the way the atlas
 * matches them, so a berth flagged only at the far end is a berth, and a
 * permanent gangway between the same two rooms still joins them; pass
 * readPhysicalDoors' map: the room's own doors, each read past readAllDoors'
 * cap, keyed by the door ids a far record can name.
 * Without the room's id, only its own flags count, and a pairing back to the
 * room itself cannot be told apart.
 */
export function isBoltedIntoStation(
  doors: Iterable<DoorRecord> | ReadonlyMap<string, DoorRecord>,
  roomId = '',
  atlas?: Record<string, AtlasEntry>,
): boolean {
  // The room's pairings that name a room, filed the way a harvest files them.
  const live: Record<string, AtlasDoor> = Object.create(null);
  let unnamed = 0;
  const records: Iterable<readonly [string, DoorRecord]> = doors instanceof Map
    ? doors
    : [...(doors as Iterable<DoorRecord>)].map((rec) => [`#${unnamed++}`, rec] as const);
  for (const [doorId, rec] of records) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    const target = namedRoom(rec.connectedRoomAddress);
    // A pairing back to the room itself joins it to no other room.
    if (!target || target === roomId) continue;
    live[doorId] = {
      targetSeed: rec.connectedRoomAddress,
      targetRoomId: target,
      segments: rec.segments,
      farDoor: rec.farDoor,
      ...(typeof rec.transient === 'boolean' ? { transient: rec.transient } : {}),
    };
  }
  const ids = Object.keys(live);
  if (ids.length === 0) return false;
  const berths = roomId ? berthsHere(roomId, live, atlas ?? readAtlas()) : null;
  return ids.some((id) => !isBerthDoor(live[id]) && !berths?.has(id));
}

/** The room a pairing's address names, as the atlas reads it, or '': a
 *  malformed peer-written one names none, or makes the parser throw, and
 *  joins nothing. */
function namedRoom(address: string): string {
  try {
    return roomIdFromSeed(address);
  } catch {
    return '';
  }
}

/** The room's doors the atlas calls berths: its live pairings matched with
 *  the records the atlas holds of each far room (berthDoorIds, over just
 *  those rooms — a pairing between two rooms is matched from their records
 *  alone). */
function berthsHere(roomId: string, live: Record<string, AtlasDoor>, atlas: Record<string, AtlasEntry>): Set<string> {
  const view: Record<string, AtlasEntry> = Object.create(null);
  view[roomId] = { roomId, name: '', doors: live, lastSeen: 0 };
  for (const door of Object.values(live)) {
    const far = door.targetRoomId;
    if (far !== roomId && Object.prototype.hasOwnProperty.call(atlas, far)) view[far] = atlas[far];
  }
  return berthDoorIds(view).get(roomId) ?? new Set();
}

/**
 * Does a helm in this room steer a STATION, rather than fly the room as a
 * ship? When the room is bolted into a station (isBoltedIntoStation), and
 * when it is a saved or built-in station's own welcome room, even standing
 * alone: a one-module station keeps its orbit with the trim stick too
 * (#172's stations.isStationRoom, asked of the station records alone, since
 * a door counts here only by the stricter rule above). Its ship face stays
 * one tab away.
 */
export function steersStation(
  roomId: string,
  doors: Iterable<DoorRecord> | ReadonlyMap<string, DoorRecord>,
  atlas?: Record<string, AtlasEntry>,
  stations?: StationRecord[],
): boolean {
  return isBoltedIntoStation(doors, roomId, atlas) || isStationRoom(roomId, [], stations);
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

/** The replay takes at most this many burns since the last level write
 *  settled the log, and the stick holds the next until one does: far more
 *  than a module's tanks pay for between two REFUELs (TANK_CAPACITY each). */
export const MAX_LOG = 1_024;

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
  /** The slot it was trimmed in. Each slot keeps its own trim: a station
   *  moved to another slot or planet flies that one's, untrimmed until a
   *  burn there. */
  slot: number;
  /** 🎚️ The altitude orbit it was trimmed on (StationRecord.orbit), when the
   *  station flew one; left out, the slot's. Part of the basis: a station
   *  that changes altitude flies its new orbit untrimmed until its next burn.
   *  "The slot" below means this base orbit. */
  base?: StationOrbit;
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
  /** How many burns its orbit has had along the line this trim continues:
   *  each burn adds one to the trim it starts from, in whichever of the
   *  station's helm rooms it fired (TrimBurn.from), so of two trims on one
   *  orbit the one further along is the newer, whatever clocks stamped them
   *  (isNewerTrim). Left out (a trim from before), none. */
  seq?: number;
  /** The latest place in the replay (TrimBurn.order, else the time) of the
   *  burns along that line, when it is after `at`: a burn that goes on from
   *  this trim replays after every one of them, in whichever room's log
   *  they reach (writeTrimBurn), so none of them lands twice. Left out,
   *  `at`. */
  place?: number;
  /** Whose burns that line holds, and how far: for each writer (the client a
   *  burn's log key names), the latest place of its burns along the line,
   *  in writer order, the MAX_SEEN latest (the rest fold into `seenFloor`).
   *  A burn its room's log gets only after a trim that holds it (one
   *  carried back into the room, or one a REFUEL settled first) pays and
   *  fires, but moves the orbit no further. Left out, none. */
  seen?: [number, number][];
  /** The latest place of the burns that line holds from writers `seen` no
   *  longer names: a burn placed at or before it counts as held, whichever
   *  writer its log key names, so a forgotten writer's burn never lands
   *  twice, and an independent one placed there that reaches the log that
   *  late pays and fires without moving the orbit. Left out, none. */
  seenFloor?: number;
}

/** One burn of the stick, as the log keeps it. Plain JSON. */
export interface TrimBurn {
  /** The basis of the orbit it trimmed: a PLANETS id and a slot, and the
   *  altitude orbit when the station flew one (OrbitTrim.base). */
  planetId: string;
  slot: number;
  base?: StationOrbit;
  /** Which way it pushed. */
  dir: TrimDirection;
  /** Real ms it fired. */
  at: number;
  /** Fuel it took from this module's tanks. */
  fuel: number;
  /** What those tanks held when it fired (TANK_CAPACITY each): the fuel it
   *  could draw on (shipDoc.fuelCeiling). Left out (a burn from before), the
   *  level as written. */
  cap?: number;
  /** The station's shared trim this burn went on from, on the same orbit,
   *  when it was newer than this room's own (another of the station's helm
   *  rooms burned since: readSharedTrim, isNewerTrim). The replay starts the
   *  orbit from it at this burn, unless this room's own trim there is newer
   *  by then. */
  from?: OrbitTrim;
  /** Where the replay takes it, when that is after `at`: just past the
   *  latest burn its writer knew of, in its room's log or along the trims
   *  it went on from (OrbitTrim.place), when it was written
   *  (writeTrimBurn). So a burn pressed after one stamped ahead of this
   *  clock (a tab running fast) still replays after it, as its writer saw
   *  them, even in a log that gets that burn only later, and a trim it
   *  carries never meets that burn again. Left out, `at`. */
  order?: number;
}

/** A burn that fired, as the stick and the dashboard show it. */
export type FiredBurn = Pick<TrimBurn, 'planetId' | 'slot' | 'base' | 'dir' | 'at'>;

/** What a level write keeps of the room's burn log, beside station keeping's
 *  meter reading on the fuel record (shipDoc.writeFuelLevel asks the meter
 *  for it). Plain JSON. */
export interface KeepingSettlement {
  /** Where every burn it covered left the trim, the record from before the
   *  log included, dated no later than the write: one dated ahead of the
   *  writer's clock is re-dated to it, on the same orbit. */
  trim: OrbitTrim | null;
  /** The same for every orbit a station can take here, one trim each, the
   *  latest last: the replay starts each orbit from its own, so a burn on
   *  one never undoes another's. Left out (a settlement from before), `trim`
   *  alone; `trim` stays for builds that read it alone. */
  trims?: OrbitTrim[];
  /** The fuel those burns drew: the meter's reading at the write. */
  fuelDrawn: number;
  /** The log keys it covered: the burns paid for, and the ones dropped
   *  because the fuel could not cover them. */
  burns: string[];
  /** The last burn to fire on each orbit a station can take here, at the
   *  time it applied (lastFiredPerOrbit), by the write: the replay skips the
   *  burns the settlement covers, and the stick's lockout on each orbit still
   *  follows its own, however many burns fired on other orbits since, and
   *  whatever burn is stamped ahead of the writer's clock. Left out (a
   *  settlement from before), the trim's last burn. */
  fired?: FiredBurn[];
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

/** A trim counts at most this many burns along its line (OrbitTrim.seq): a
 *  bound on a peer-written count, far below where adding one stops being
 *  exact. */
const MAX_TRIM_SEQ = 2 ** 40;

/** A place in the replay (TrimBurn.order, OrbitTrim.place) is at most this:
 *  past the latest time a burn may carry by one per burn a log can hold,
 *  twice over. */
const MAX_ORDER = MAX_AT_MS + 2 * MAX_LOG;

/** A trim names at most this many writers whose burns its line holds
 *  (OrbitTrim.seen): the latest. The rest fold into its floor
 *  (OrbitTrim.seenFloor). */
const MAX_SEEN = 16;
/** A writer is a Yjs client id: a uint32. */
const MAX_CLIENT = 2 ** 32 - 1;

/** A burn takes at most this much fuel: a bound on a peer-written entry, far
 *  above TRIM_FUEL. */
const MAX_BURN_FUEL = 1_000;

function isBasis(planetId: unknown, slot: unknown, base?: unknown): boolean {
  return typeof planetId === 'string' && planetId.length > 0 && planetId.length <= MAX_PLANET_ID_LEN
    && Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < MAX_ORBIT_SLOTS
    && (base === undefined || isBaseOrbit(base));
}

/** 🎚️ An altitude orbit off the wire: plain finite numbers, nothing else. */
function isBaseOrbit(v: unknown): v is StationOrbit {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<Record<keyof StationOrbit, unknown>>;
  return typeof o.radiusKm === 'number' && Number.isFinite(o.radiusKm) && o.radiusKm > 0
    && typeof o.phase0 === 'number' && Number.isFinite(o.phase0) && Math.abs(o.phase0) <= TAU;
}

/** 🎚️ The basis orbit a station flies: its altitude orbit when it has one it
 *  can fly (StationRecord.orbit, or for a record that carries its latest
 *  move instead, what that move left), else none (the slot's). */
export function basisOf(
  station: Pick<StationRecord, 'planetId' | 'orbit'> & { move?: StationRecord['move'] },
  nowMs: number = Date.now(),
): StationOrbit | undefined {
  const o = station.orbit ?? orbitAfterMove(station.move, nowMs);
  return isUsableOrbit(planetById(station.planetId), o) ? { radiusKm: o.radiusKm, phase0: o.phase0 } : undefined;
}

/** Do two bases name the same orbit: both the slot's, or one altitude orbit
 *  (the very numbers its move carries, so equal everywhere)? */
export function sameBase(a: StationOrbit | undefined, b: StationOrbit | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.radiusKm === b.radiusKm && a.phase0 === b.phase0;
}

/** Is `t` a trim on the orbit a burn names (its planet, slot and base), so
 *  the line the burn goes on from? One on the slot at another altitude is
 *  another orbit's line. */
function onOrbit(t: OrbitTrim | null, b: Pick<TrimBurn, 'planetId' | 'slot' | 'base'>): t is OrbitTrim {
  return t !== null && t.planetId === b.planetId && t.slot === b.slot && sameBase(t.base, b.base);
}

/** The untrimmed orbit a basis names. */
function basisOrbit(b: { planetId: string; slot: number; base?: StationOrbit }): CircularOrbit {
  return baseOrbit({ planetId: b.planetId, orbitSlot: b.slot, orbit: b.base });
}

/** The basis fields, as a record carries them (no `base` for the slot's). */
function basisFields(b: { planetId: string; slot: number; base?: StationOrbit }): { planetId: string; slot: number; base?: StationOrbit } {
  return { planetId: b.planetId, slot: b.slot, ...(b.base ? { base: { radiusKm: b.base.radiusKm, phase0: b.base.phase0 } } : {}) };
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
  return isBasis(r.planetId, r.slot, r.base)
    && typeof r.dRadiusKm === 'number' && Number.isFinite(r.dRadiusKm) && Math.abs(r.dRadiusKm) <= MAX_TRIM_KM
    && typeof r.dPhase === 'number' && Number.isFinite(r.dPhase) && Math.abs(r.dPhase) <= Math.PI
    && isBurnTime(r.at)
    && isDirection(r.last)
    && (r.fuelDrawn === undefined
      || (typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX))
    && (r.seq === undefined || (typeof r.seq === 'number' && Number.isInteger(r.seq) && r.seq >= 0 && r.seq <= MAX_TRIM_SEQ))
    && (r.place === undefined
      || (typeof r.place === 'number' && r.place > (r.at as number) && r.place <= MAX_ORDER))
    && (r.seen === undefined || isSeenList(r.seen, (r.place ?? r.at) as number))
    && (r.seenFloor === undefined || isLinePlace(r.seenFloor, (r.place ?? r.at) as number));
}

/** Shape guard for the writers a trim's line holds (OrbitTrim.seen), each
 *  placed no later than the line itself. */
function isSeenList(v: unknown, linePlace: number): boolean {
  return Array.isArray(v) && v.length <= MAX_SEEN && v.every((e: unknown) => Array.isArray(e) && e.length === 2
    && Number.isInteger(e[0]) && e[0] >= 0 && e[0] <= MAX_CLIENT
    && isLinePlace(e[1], linePlace));
}

/** A place along a line: a number from the orbits' epoch to the line's own
 *  place (OrbitTrim.place, else its time). */
function isLinePlace(v: unknown, linePlace: number): boolean {
  return typeof v === 'number' && v >= ORBIT_EPOCH_MS && v <= linePlace;
}

/** Shape guard for a burn off the wire. */
export function isTrimBurn(v: unknown): v is TrimBurn {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof TrimBurn, unknown>>;
  return isBasis(r.planetId, r.slot, r.base)
    && isDirection(r.dir)
    && isBurnTime(r.at)
    && typeof r.fuel === 'number' && r.fuel > 0 && r.fuel <= MAX_BURN_FUEL
    && (r.cap === undefined || (typeof r.cap === 'number' && r.cap >= 0 && r.cap <= FUEL_METER_MAX))
    && (r.from === undefined || (isOrbitTrim(r.from) && r.from.planetId === r.planetId && r.from.slot === r.slot))
    && (r.order === undefined
      || (typeof r.order === 'number' && r.order > (r.at as number) && r.order <= MAX_ORDER));
}

/** A settlement names at most this many log keys: every burn since the last
 *  one, and any it covered that no burn has cleared since. */
const MAX_SETTLED_BURNS = 2 * MAX_LOG;
/** A log key is `burn:`, a client id and a time: well under this. */
const MAX_BURN_KEY_LEN = 64;

/** A settlement keeps one fired burn and one trim per orbit, so at most
 *  PLANETS × MAX_ORBIT_SLOTS of each. One off the wire may carry this many:
 *  room for a build that knows more planets, and still a bound on a
 *  peer-written list. */
const MAX_SETTLED_FIRED = 256;

/** Shape guard for a fired burn off the wire. */
function isFiredBurn(v: unknown): v is FiredBurn {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof FiredBurn, unknown>>;
  return isBasis(r.planetId, r.slot, r.base) && isDirection(r.dir) && isBurnTime(r.at);
}

/** Shape guard for a settlement off the fuel record. */
export function isKeepingSettlement(v: unknown): v is KeepingSettlement {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<Record<keyof KeepingSettlement, unknown>>;
  return (r.trim === null || isOrbitTrim(r.trim))
    && (r.trims === undefined
      || (Array.isArray(r.trims) && r.trims.length <= MAX_SETTLED_FIRED && r.trims.every(isOrbitTrim)))
    && typeof r.fuelDrawn === 'number' && r.fuelDrawn >= 0 && r.fuelDrawn <= FUEL_METER_MAX
    && Array.isArray(r.burns) && r.burns.length <= MAX_SETTLED_BURNS
    && r.burns.every((k) => typeof k === 'string' && k.startsWith(BURN_KEY_PREFIX) && k.length <= MAX_BURN_KEY_LEN)
    && (r.fired === undefined
      || (Array.isArray(r.fired) && r.fired.length <= MAX_SETTLED_FIRED && r.fired.every(isFiredBurn)));
}

/** A trim's orbit fields, its count of burns, its place, its writers and
 *  their floor only (a record from before the log also carries its fuel,
 *  which the meter reads apart). */
function cleanTrim(t: OrbitTrim): OrbitTrim {
  const out: OrbitTrim = { ...basisFields(t), dRadiusKm: t.dRadiusKm, dPhase: t.dPhase, at: t.at, last: t.last };
  if (t.seq !== undefined) out.seq = t.seq;
  if (t.place !== undefined) out.place = t.place;
  if (t.seen !== undefined || t.seenFloor !== undefined) {
    const line = lineWriters(t.seen ?? [], t.seenFloor);
    if (t.seen !== undefined) out.seen = line.seen;
    if (line.floor !== undefined) out.seenFloor = line.floor;
  }
  return out;
}

/** A line's writers (OrbitTrim.seen) as a trim keeps them: one entry per
 *  writer at its latest place, the MAX_SEEN latest, in writer order; and
 *  their floor (OrbitTrim.seenFloor), raised to the latest place of any it
 *  leaves out. */
function lineWriters(
  entries: Iterable<readonly [number, number]>,
  floor?: number,
): { seen: [number, number][]; floor?: number } {
  const latest = new Map<number, number>();
  for (const [writer, place] of entries) latest.set(writer, Math.max(place, latest.get(writer) ?? place));
  const byPlace = [...latest].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [, place] of byPlace.slice(MAX_SEEN)) floor = Math.max(place, floor ?? place);
  return { seen: byPlace.slice(0, MAX_SEEN).sort((a, b) => a[0] - b[0]), ...(floor === undefined ? {} : { floor }) };
}

/** How far a trim's line holds a writer's burns: its place among the
 *  writers (OrbitTrim.seen), or the floor of those the line no longer names
 *  (OrbitTrim.seenFloor) when that is later, or -Infinity. */
function seenAt(trim: OrbitTrim, writer: number): number {
  const named = trim.seen?.find(([client]) => client === writer)?.[1] ?? Number.NEGATIVE_INFINITY;
  return Math.max(named, trim.seenFloor ?? Number.NEGATIVE_INFINITY);
}

/** Only the fields a fired burn has — what a settlement keeps. */
function cleanFired(b: FiredBurn): FiredBurn {
  return { ...basisFields(b), dir: b.dir, at: b.at };
}

/** The last burn to fire on each orbit a station can take here, in firing
 *  order: what a settlement keeps for the lockout. A burn on a planet this
 *  build does not know holds no station's stick here and is left out, so the
 *  list never outgrows the orbits there are (PLANETS × MAX_ORBIT_SLOTS). */
function lastFiredPerOrbit(fired: readonly FiredBurn[]): FiredBurn[] {
  const last = new Map<string, FiredBurn>();
  for (const b of fired) {
    if (planetById(b.planetId).id !== b.planetId) continue;
    const orbit = `${b.planetId}:${b.slot}${b.base ? `:${b.base.radiusKm}:${b.base.phase0}` : ''}`;
    const kept = last.get(orbit);
    // Of two at the same time, the first: the one readBurnFiring picks.
    if (!kept || b.at > kept.at) last.set(orbit, b);
  }
  // 🎚️ Each altitude orbit is an orbit of its own, so their count has no
  // fixed bound: the latest ones, which hold any lockout, stay within the
  // bound a settlement off the wire is held to.
  return [...last.values()].sort((a, b) => a.at - b.at).slice(-MAX_SETTLED_FIRED).map(cleanFired);
}

/** Only the fields a burn has — what a write publishes. */
function cleanBurn(b: TrimBurn): TrimBurn {
  const out: TrimBurn = { ...basisFields(b), dir: b.dir, at: b.at, fuel: b.fuel };
  if (b.cap !== undefined) out.cap = b.cap;
  if (b.from !== undefined) out.from = cleanTrim(b.from);
  if (b.order !== undefined) out.order = b.order;
  return out;
}

/** The trim (or the burn) that applies to `station`: the record, while it
 *  names the planet and slot the station flies (the planet as orbits.ts
 *  resolves it, so an unknown id matches the default planet it orbits);
 *  otherwise none. */
export function trimFor<T extends Pick<OrbitTrim, 'planetId' | 'slot' | 'base'>>(
  station: (Pick<StationRecord, 'planetId' | 'orbitSlot' | 'orbit'> & { move?: StationRecord['move'] }) | null,
  trim: T | null,
): T | null {
  if (!station || !trim) return null;
  return trim.planetId === planetById(station.planetId).id && trim.slot === station.orbitSlot
    && sameBase(trim.base, basisOf(station)) ? trim : null;
}

// ── The trimmed orbit (on orbits.ts) ─────────────────────────────────────────

/** The station's UNTRIMMED base orbit (its slot's, or its altitude's) — the
 *  basis every trim is measured from. Not orbits.stationOrbit: that one
 *  follows a station's trim once a trim resolver is installed, and measuring
 *  from it would apply the trim twice. */
export function slotOrbit(station: Pick<StationRecord, 'planetId' | 'orbitSlot' | 'orbit'>): CircularOrbit {
  return baseOrbit(station);
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
export function isFiring(burn: Pick<FiredBurn, 'at'> | null, realMs: number): boolean {
  return !!burn && realMs >= burn.at && realMs - burn.at < BURN_MS;
}

/** Is the trim's last burn firing at `realMs` (isFiring)? Only right when
 *  that burn is the latest to have fired here: the room's burn firing now is
 *  readBurnFiring. */
export function isBurning(trim: OrbitTrim | null, realMs: number): boolean {
  return isFiring(trim, realMs);
}

// ── Burns ────────────────────────────────────────────────────────────────────

/** Why the stick will not fire, in the order the helm checks. */
export type TrimRefusal =
  | 'not-bolted' // the module no longer steers a station (a gangway came down)
  | 'no-station' // the atlas does not place this module in a station yet
  | 'not-commander' // only the module's owner flies the station
  | 'no-thrusters' // no engine block on this module
  | 'no-fuel' // the module's tanks are dry (or it has none)
  | 'log-full' // MAX_LOG burns since the last level write: REFUEL settles them
  | 'burning' // the last burn is still firing
  | 'at-limit'; // RAISE / LOWER would leave the trim band

export interface TrimContext {
  /** Does the module STILL steer a station (steersStation: bolted into one,
   *  or its own welcome room), read live — the face was picked when the helm
   *  opened, and a peer can take a gangway down while it is open? */
  bolted: boolean;
  station: Pick<StationRecord, 'planetId' | 'orbitSlot' | 'orbit'> | null;
  /** The room's trim, as read — trimFor is applied here, not by the caller. */
  trim: OrbitTrim | null;
  commander: boolean;
  /** Engine blocks mounted on this module (its thrusters). */
  engines: number;
  /** Fuel aboard, already clamped to the tanks' capacity. */
  fuel: number;
  /** What the tanks hold (TANK_CAPACITY each), stamped on the burn so the
   *  replay holds it to the fuel it could draw on. Left out, none. */
  capacity?: number;
  now: number;
  /** The burn firing now on the station's orbit (readBurnFiring(now,
   *  station)), which holds the next push (trimFor is applied here too).
   *  Left out, the trim's last burn stands in for it: right only while no
   *  burn stamped ahead of our clock sorts after the latest one. */
  firing?: FiredBurn | null;
  /** Does the log hold MAX_LOG burns since the last level write
   *  (isBurnLogFull)? Left out, no. */
  logFull?: boolean;
  /** The station's shared trim (readSharedTrim(station)). When it is newer
   *  than the room's own, the stick goes on from it, the burn carries it
   *  (TrimBurn.from), and its last burn, while firing, holds the stick too.
   *  Left out, none. */
  shared?: OrbitTrim | null;
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
 * step along the orbit and keep the radius. It counts one burn more along
 * its line than the trim it found (OrbitTrim.seq).
 */
export function applyBurn(before: OrbitTrim | null, burn: Pick<TrimBurn, 'planetId' | 'slot' | 'base' | 'dir' | 'at'>): OrbitTrim | null {
  const current = onOrbit(before, burn) ? before : null;
  const base = basisOrbit(burn);
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
  return { ...basisFields(burn), dRadiusKm, dPhase: signedAngle(dPhase), at: burn.at, last: burn.dir, seq: nextSeq(current) };
}

/** Burn order: by place (placeOf), then by time, then by every other field,
 *  so all clients replay the same burns in the same order (plain code-unit
 *  order: never the locale's). */
function burnOrder(a: TrimBurn, b: TrimBurn): number {
  const placeA = placeOf(a);
  const placeB = placeOf(b);
  if (placeA !== placeB) return placeA - placeB;
  if (a.at !== b.at) return a.at - b.at;
  if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
  if (a.planetId !== b.planetId) return a.planetId < b.planetId ? -1 : 1;
  if (a.slot !== b.slot) return a.slot - b.slot;
  const baseA = a.base ? JSON.stringify([a.base.radiusKm, a.base.phase0]) : '';
  const baseB = b.base ? JSON.stringify([b.base.radiusKm, b.base.phase0]) : '';
  if (baseA !== baseB) return baseA < baseB ? -1 : 1;
  if (a.fuel !== b.fuel) return a.fuel - b.fuel;
  const capA = a.cap ?? Number.POSITIVE_INFINITY;
  const capB = b.cap ?? Number.POSITIVE_INFINITY;
  if (capA !== capB) return capA < capB ? -1 : 1;
  const fromA = a.from ? JSON.stringify(cleanTrim(a.from)) : '';
  const fromB = b.from ? JSON.stringify(cleanTrim(b.from)) : '';
  return fromA === fromB ? 0 : fromA < fromB ? -1 : 1;
}

/** Where the replay takes a burn: its place (TrimBurn.order), else its time. */
function placeOf(b: Pick<TrimBurn, 'at' | 'order'>): number {
  return b.order ?? b.at;
}

/** The latest place along a trim's line (OrbitTrim.place), else its time;
 *  -Infinity for none. */
function trimPlace(t: OrbitTrim | null): number {
  return t ? t.place ?? t.at : Number.NEGATIVE_INFINITY;
}

/** Where a run of burns leaves the trim, the fuel they drew, and the burns
 *  that fired (in order), each at the time it applied: one stamped before
 *  the start's last burn at that burn's time. */
export interface BurnRun {
  /** The trim the last burn left, on whichever orbit it trimmed (or the
   *  start's latest). */
  trim: OrbitTrim | null;
  /** Every orbit's trim, one each, the latest last: a burn starts from its
   *  own orbit's trim and never undoes another's. */
  trims: OrbitTrim[];
  fuelDrawn: number;
  fired: TrimBurn[];
}

/** The fuel a run of burns may draw up to, by the capacity a burn was made
 *  against (TrimBurn.cap; Infinity for one that carries none). */
export type BurnCeiling = (capacity: number) => number;

/** The orbit a trim or a burn names, as a key: its planet and slot. */
function orbitKey(b: Pick<OrbitTrim, 'planetId' | 'slot'>): string {
  return `${b.planetId}:${b.slot}`;
}

/** The trims a settlement keeps: one per orbit a station can take here, the
 *  latest last. A trim on a planet this build does not know trims no
 *  station's orbit here and is left out, as in lastFiredPerOrbit. */
function trimsPerOrbit(trims: readonly OrbitTrim[]): OrbitTrim[] {
  return trims
    .filter((t) => planetById(t.planetId).id === t.planetId)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_SETTLED_FIRED);
}

/** replayBurns over burns already in burn order, from each orbit's trim;
 *  `writers[i]` is who wrote `sorted[i]` (the client its log key names),
 *  when known. */
function runBurns(
  sorted: readonly TrimBurn[],
  start: readonly OrbitTrim[],
  startFuel: number,
  ceiling: BurnCeiling,
  writers: readonly (number | undefined)[] = [],
): BurnRun {
  // Each orbit's trim, set again whenever it moves, so the latest is last.
  const trims = new Map<string, OrbitTrim>();
  let trim: OrbitTrim | null = null;
  for (const t of [...start].sort((a, b) => a.at - b.at)) {
    trims.delete(orbitKey(t));
    trims.set(orbitKey(t), t);
    trim = t;
  }
  let fuelDrawn = startFuel;
  const fired: TrimBurn[] = [];
  // The burns folded into `start` cannot be replayed around a burn stamped
  // before them, so it applies at the time of their last one.
  const frontier = trim ? trim.at : Number.NEGATIVE_INFINITY;
  for (const [i, burn] of sorted.entries()) {
    // Never past what a meter reading can hold: a reading past it counts as
    // none, which would refund every burn before it.
    const limit = Math.min(FUEL_METER_MAX, ceiling(burn.cap ?? Number.POSITIVE_INFINITY));
    if (fuelDrawn + burn.fuel > limit) continue;
    fuelDrawn += burn.fuel;
    const at = burn.at < frontier ? frontier : burn.at;
    const applied = at === burn.at ? burn : { ...burn, at };
    // A burn starts from its own orbit's trim. One that would leave the band
    // changes nothing but still pays, and the trim still dates from it: a
    // settlement keeps the trim's time as its frontier and its last burn as
    // the one that fired last.
    const key = orbitKey(burn);
    const own = trims.get(key) ?? null;
    const writer = writers[i];
    const place = placeOf(burn);
    // One the orbit's line already holds (a trim carried back into the room,
    // or a REFUEL's, got it before this log did) has paid and fired, but
    // moves the orbit no further (OrbitTrim.seen, seenFloor). The trim kept
    // for the slot at another altitude holds none of its burns. Places at
    // their bound tell no burns apart, so one placed there always moves it.
    if (onOrbit(own, burn) && writer !== undefined && place < MAX_ORDER && seenAt(own, writer) >= place) {
      fired.push(applied);
      continue;
    }
    // One that went on from the station's shared trim starts there, unless
    // this room's own trim on the orbit is newer by then (isNewerTrim).
    const before = burn.from && (!own || isNewerTrim(burn.from, own)) ? burn.from : own;
    const after = applyBurn(before, applied) ?? heldBurn(before, burn.dir, at);
    if (after) {
      // Its line has been through every place the one it went on from had,
      // and this burn's: a burn that goes on from it replays after them all.
      const linePlace = Math.max(trimPlace(before), place);
      if (linePlace > after.at) after.place = linePlace;
      // And it holds every burn that one held, and this one: past the last
      // MAX_SEEN writers, under their floor. A line applyBurn started afresh
      // (that one was another orbit's) holds this burn alone.
      const prior = onOrbit(before, burn) ? before : null;
      const line = lineWriters(
        [...(prior?.seen ?? []), ...(writer === undefined ? [] : [[writer, place] as const])],
        prior?.seenFloor,
      );
      if (line.seen.length > 0) after.seen = line.seen;
      if (line.floor !== undefined) after.seenFloor = line.floor;
      trims.delete(key);
      trims.set(key, after);
      trim = after;
    }
    // It fires when it applies, so the lockout and the stick keep the same
    // time as the orbit.
    fired.push(applied);
  }
  return { trim, trims: [...trims.values()], fuelDrawn, fired };
}

/** The orbit a trim flies, dated from a later burn that changed nothing (it
 *  would have left the band): the same radius and course, with the offset
 *  from the slot measured at that burn. */
function heldTrim(trim: OrbitTrim | null, dir: TrimDirection, at: number): OrbitTrim | null {
  if (!trim) return null;
  const base = basisOrbit(trim);
  return { ...basisFields(trim), dRadiusKm: trim.dRadiusKm, dPhase: slotOffsetAt(base, trim, at), at, last: dir };
}

/** The count of burns along a line, one burn on from `trim`'s
 *  (OrbitTrim.seq). */
function nextSeq(trim: OrbitTrim | null): number {
  return Math.min(MAX_TRIM_SEQ, (trim?.seq ?? 0) + 1);
}

/** heldTrim for a burn at the band's edge: it counts along the line all the
 *  same (OrbitTrim.seq). */
function heldBurn(trim: OrbitTrim | null, dir: TrimDirection, at: number): OrbitTrim | null {
  const held = heldTrim(trim, dir, at);
  return held && { ...held, seq: nextSeq(trim) };
}

/**
 * Where a run of burns leaves the trim, and the fuel they drew: each burn in
 * burn order (by its place, TrimBurn.order, else its time), from the trim and
 * fuel before them. A burn stamped before
 * `start`'s last burn (one that reached us after a level write settled the
 * burns `start` sums up) applies at that burn's time. A burn the fuel cannot
 * cover, one that would take the fuel drawn past `ceiling`
 * (shipDoc.fuelCeiling, by the capacity the burn was made against) or past
 * what a meter reading can hold (FUEL_METER_MAX), is dropped: it neither
 * moves the orbit nor takes fuel, and the burns after it still get their
 * turn. A burn that would leave the band changes nothing but still pays — its
 * fuel burned wherever it fired, and a burn that arrives late (from a tab
 * that was offline) must never make an earlier one free — and the trim is
 * dated from it all the same (heldTrim). Each orbit keeps its own trim
 * (BurnRun.trims): a burn starts from its own orbit's and never undoes
 * another's, or from the shared trim it carries while that is the newer
 * (TrimBurn.from, isNewerTrim).
 */
export function replayBurns(
  burns: readonly TrimBurn[],
  start: OrbitTrim | null = null,
  startFuel = 0,
  ceiling: number | BurnCeiling = Number.POSITIVE_INFINITY,
): BurnRun {
  return runBurns([...burns].sort(burnOrder), start ? [start] : [], startFuel, typeof ceiling === 'number' ? () => ceiling : ceiling);
}

/** Is `a` the newer of two trims on one orbit? The one further along its
 *  line (OrbitTrim.seq: a burn that went on from a trim stamped ahead of its
 *  own clock is still the newer), then the later, then the greater by
 *  content. The same on every client, so the station's helm rooms, and
 *  whoever shares their trims (setSharedTrimSource), settle on one. */
export function isNewerTrim(a: OrbitTrim, b: OrbitTrim): boolean {
  const seqA = a.seq ?? 0;
  const seqB = b.seq ?? 0;
  if (seqA !== seqB) return seqA > seqB;
  if (a.at !== b.at) return a.at > b.at;
  return JSON.stringify(cleanTrim(a)) > JSON.stringify(cleanTrim(b));
}

/** The trim a station's helm flies from: the room's own on the station's
 *  orbit, or the station's shared one (readSharedTrim) when that is newer
 *  (isNewerTrim), left by another of the station's helm rooms. */
export function helmTrim(
  station: Pick<StationRecord, 'planetId' | 'orbitSlot'> | null,
  own: OrbitTrim | null,
  shared: OrbitTrim | null = null,
): OrbitTrim | null {
  const mine = trimFor(station, own);
  const theirs = trimFor(station, shared);
  return theirs && (!mine || isNewerTrim(theirs, mine)) ? theirs : mine;
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
  if (ctx.logFull) return { ok: false, refusal: 'log-full' };
  const own = trimFor(station, ctx.trim);
  const current = helmTrim(station, ctx.trim, ctx.shared ?? null);
  // A burn from another of the station's helm rooms holds this stick too.
  if (current !== own && isFiring(current, now)) return { ok: false, refusal: 'burning' };
  const firing = ctx.firing === undefined ? current : trimFor(station, ctx.firing);
  if (isFiring(firing, now)) return { ok: false, refusal: 'burning' };
  const base = basisOf(station, now);
  const burn: TrimBurn = { planetId: planetById(station.planetId).id, slot: station.orbitSlot, ...(base ? { base } : {}), dir, at: now, fuel: TRIM_FUEL };
  if (ctx.capacity !== undefined) burn.cap = ctx.capacity;
  // Going on from the shared trim, the burn carries it, so every replay of
  // this room's log starts the orbit from it here.
  if (current && current !== own) burn.from = cleanTrim(current);
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
    case 'log-full':
      return `${MAX_LOG} burns since the tanks were last filled. REFUEL on the FUEL & DOCKING tab to settle them.`;
    case 'burning':
      return 'A burn is firing. The stick is ready again when it ends.';
    case 'at-limit':
      return `The orbit is already ${MAX_TRIM_KM} km ${dRadiusKm > 0 ? 'above' : 'below'} its slot, as far as trim goes.`;
  }
}

/** The burn a trim's last one was. */
function lastBurnOf(trim: OrbitTrim): FiredBurn {
  return { ...basisFields(trim), dir: trim.last, at: trim.at };
}

/** The dashboard's status line when nothing refuses: the burn firing, on
 *  station, or what to do to get back there. `firing` is the burn firing now
 *  on the station's orbit (readBurnFiring); left out, the trim's last burn
 *  stands in. */
export function describeTrimStatus(
  base: CircularOrbit,
  trim: OrbitTrim | null,
  realMs: number,
  firing: FiredBurn | null = trim && lastBurnOf(trim),
): string {
  if (firing && isFiring(firing, realMs)) return `BURNING: ${DIRECTION_WORDS[firing.dir]}.`;
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

/** The record a room trimmed before the burn log kept: where replay starts
 *  until the first settlement. */
const TRIM_KEY = 'trim';
/** Every burn's key starts so; the rest names the client and the time. */
const BURN_KEY_PREFIX = 'burn:';
/** Station keeping's draw meter on the tank. */
const METER = 'stationKeeping';

let boundDoc: Y.Doc | null = null;
let keepMap: Y.Map<unknown> | null = null;
let unobserveLog: (() => void) | null = null;
let unhearShip: (() => void) | null = null;
const listeners = new Set<() => void>();
/** Moves whenever the bound map changes. */
let logVersion = 0;
/** The trim and fuel drawn that subscribers last heard about. */
let heard: string | null = null;

/** The bound room's log, replayed. */
interface RoomReplay {
  trim: OrbitTrim | null;
  /** Every orbit's trim (BurnRun.trims). */
  trims: OrbitTrim[];
  fuelDrawn: number;
  /** Every burn that fired: the ones the settlement kept (or the settled
   *  trim's last burn), then the burns since, each at the time it applied
   *  (BurnRun). */
  fired: FiredBurn[];
  /** The log keys the settlement covers. */
  covered: ReadonlySet<string>;
  /** Those of them still in the map: the next burn clears them. */
  settledKeys: string[];
  /** Burns in the log the settlement does not cover yet. */
  pending: number;
  /** The latest place among them (placeOf) and along the trims the replay
   *  leaves (OrbitTrim.place), or -Infinity: a burn written now replays
   *  after it (TrimBurn.order). */
  place: number;
  /** What a level write at `now`, by its writer's clock, keeps (settleLog),
   *  or undefined. */
  settle: (now: number) => KeepingSettlement | undefined;
}

const NO_REPLAY: RoomReplay = {
  trim: null, trims: [], fuelDrawn: 0, fired: [], covered: new Set(), settledKeys: [], pending: 0,
  place: Number.NEGATIVE_INFINITY, settle: () => undefined,
};

let replayed: { log: number; ship: number; replay: RoomReplay } | null = null;
let replaying = false;

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

/** Tell subscribers the replay may have moved: always when the log changes;
 *  when the fuel record or a draw meter changes, only if that moved a trim
 *  or the fuel drawn (a burn dropped, or covered again). */
function announce(always: boolean): void {
  let now: string | null = null;
  if (docAlive()) {
    const { trim, trims, fuelDrawn } = replayRoom();
    now = JSON.stringify([trim, trims, fuelDrawn]);
  }
  if (!always && now === heard) return;
  heard = now;
  notify();
}

/** Bind the room doc — at the T0 seam, right after bindShipDoc binds the
 *  same doc: the replay reads the fuel record shipDoc is bound to. The
 *  burns' fuel, added up, becomes one of the tank's draw meters, and each
 *  level write settles the log through it. */
export function bindStationKeepingDoc(doc: Y.Doc): void {
  unobserveLog?.();
  unhearShip?.();
  boundDoc = doc;
  const map = doc.getMap('stationKeeping');
  keepMap = map;
  logVersion += 1;
  replayed = null;
  const onLog = () => {
    logVersion += 1;
    announce(true);
  };
  map.observe(onLog);
  unobserveLog = () => map.unobserve(onLog);
  // The fuel record settles the log, and the level and the other draws
  // decide which of the burns since it the level covers.
  unhearShip = subscribeShip(() => announce(false));
  setFuelDrawMeter(METER, { read: readFuelDrawn, subscribe: subscribeStationKeeping, settle: settleLog });
  heard = null;
  announce(true);
}

export function subscribeStationKeeping(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && keepMap !== null;
}

/** Code-unit order of two keys. */
function keyOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Who wrote a log entry: the client its key names (burn:<client>:<at>),
 *  or undefined. */
function keyClient(key: string): number | undefined {
  const match = /^burn:(\d{1,10}):/.exec(key);
  const client = match ? Number(match[1]) : Number.NaN;
  return client <= MAX_CLIENT ? client : undefined;
}

/** The `limit` least of the items pushed into it by `order`, never holding
 *  more than that (a max-heap on `order`), so a scan of a map a peer can
 *  flood keeps and sorts only what it takes. With a total order, the same
 *  items whatever order they are pushed in. */
function leastOf<T>(limit: number, order: (a: T, b: T) => number): { push(item: T): void; sorted(): T[] } {
  const heap: T[] = [];
  const swap = (i: number, j: number): void => {
    const t = heap[i];
    heap[i] = heap[j];
    heap[j] = t;
  };
  return {
    push(item: T): void {
      if (heap.length < limit) {
        heap.push(item);
        for (let i = heap.length - 1; i > 0;) {
          const parent = (i - 1) >> 1;
          if (order(heap[i], heap[parent]) <= 0) break;
          swap(i, parent);
          i = parent;
        }
        return;
      }
      if (limit <= 0 || order(item, heap[0]) >= 0) return;
      heap[0] = item;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let top = i;
        if (l < heap.length && order(heap[l], heap[top]) > 0) top = l;
        if (r < heap.length && order(heap[r], heap[top]) > 0) top = r;
        if (top === i) break;
        swap(i, top);
        i = top;
      }
    },
    sorted: () => [...heap].sort(order),
  };
}

/** The log replayed under `ceiling` (shipDoc.fuelCeiling): from the fuel
 *  record's settlement (or, before the first, the record from before the
 *  log), then the burns the settlement does not cover, in burn order — at
 *  most MAX_LOG of them, the rest waiting for the next level write —
 *  dropping those the fuel cannot cover. Malformed entries are skipped,
 *  the same on every client, and a key no settlement could name is left
 *  out altogether. The scan keeps no more entries than it takes, however
 *  many a peer writes. */
function replayLog(ceiling: BurnCeiling): RoomReplay {
  const map = keepMap!;
  const raw = readFuelSettlement(METER);
  const settled = isKeepingSettlement(raw) ? raw : null;
  const legacy = map.get(TRIM_KEY);
  const before = isOrbitTrim(legacy) ? legacy : null;
  // Each orbit's trim where the settlement left it, the latest among them
  // (one from before per-orbit trims keeps that alone), or the record from
  // before the log.
  const start = settled
    ? [...(settled.trims ?? []), ...(settled.trim ? [settled.trim] : [])]
    : before ? [before] : [];
  const startFuel = settled ? settled.fuelDrawn : before?.fuelDrawn ?? 0;
  const covered = new Set(settled?.burns ?? []);
  // The covered keys still in the log are at most the settlement's; of the
  // rest, only the first MAX_LOG burns and MAX_SETTLED_BURNS malformed keys
  // are kept.
  const settledKeys: string[] = [];
  const pending = leastOf<{ key: string; burn: TrimBurn }>(
    MAX_LOG,
    (a, b) => burnOrder(a.burn, b.burn) || keyOrder(a.key, b.key),
  );
  const junk = leastOf<string>(MAX_SETTLED_BURNS, keyOrder);
  let waiting = 0;
  map.forEach((v, key) => {
    // Settling a key longer than a settlement may name would void the
    // settlement (isKeepingSettlement), so such an entry never counts.
    if (!key.startsWith(BURN_KEY_PREFIX) || key.length > MAX_BURN_KEY_LEN) return;
    if (covered.has(key)) settledKeys.push(key);
    else if (isTrimBurn(v)) {
      waiting += 1;
      pending.push({ key, burn: v });
    } else junk.push(key);
  });
  settledKeys.sort(keyOrder);
  // A level write must cover every burn it counts, and every one the last
  // write covered that is still in the log, or the next replay would count
  // them again: so the replay takes no more burns than the settlement has
  // room for, and the rest wait for the next level write.
  const inOrder = pending.sorted();
  const taken = inOrder.slice(0, MAX_SETTLED_BURNS - settledKeys.length);
  const run = runBurns(
    taken.map((p) => cleanBurn(p.burn)),
    start.map(cleanTrim),
    startFuel,
    ceiling,
    taken.map((p) => keyClient(p.key)),
  );
  // Anything malformed under a burn's key is covered too while there is
  // room, so the next burn clears it.
  const keys = [...settledKeys, ...taken.map((p) => p.key)];
  keys.push(...junk.sorted().slice(0, MAX_SETTLED_BURNS - keys.length));
  const fired = [...(settled?.fired ?? start.map(lastBurnOf)), ...run.fired];
  return {
    trim: run.trim,
    trims: run.trims,
    fuelDrawn: run.fuelDrawn,
    fired,
    covered,
    settledKeys,
    pending: waiting,
    place: Math.max(
      inOrder.length ? placeOf(inOrder[inOrder.length - 1].burn) : Number.NEGATIVE_INFINITY,
      ...run.trims.map(trimPlace),
    ),
    settle: (now) => {
      if (!settled && keys.length === 0) return undefined;
      // Nothing a settlement keeps is dated past its write, by the writer's
      // clock. A trim dated ahead of it (a peer's burn stamped ahead) is
      // re-dated to the write on the same orbit: left ahead, every burn
      // stamped before then would apply, and fire, only then, so the stick
      // would never wait between them.
      const by = isBurnTime(now) ? now : Number.POSITIVE_INFINITY;
      const held = (t: OrbitTrim): OrbitTrim => cleanTrim(t.at > by ? { ...heldTrim(t, t.last, by)!, seq: t.seq, place: trimPlace(t), seen: t.seen, seenFloor: t.seenFloor } : t);
      return {
        trim: run.trim && held(run.trim),
        // Every orbit's trim too, so the next replay starts each from its own.
        trims: trimsPerOrbit(run.trims.map(held)),
        fuelDrawn: run.fuelDrawn,
        burns: [...keys],
        // The burns a settlement covers are replayed no more, so it keeps the
        // last to fire on each orbit by the write, for that orbit's lockout:
        // one stamped ahead would hide the burn firing now.
        fired: lastFiredPerOrbit(fired.filter((b) => b.at <= by)),
      };
    },
  };
}

/** The bound room's log replayed (replayLog), kept until the log, the ship
 *  doc or a draw meter changes. */
function replayRoom(): RoomReplay {
  // A draw meter that read the gauge would bring us back here: answer with
  // what we had rather than loop.
  if (replaying) return replayed?.replay ?? NO_REPLAY;
  const ship = shipVersion();
  if (replayed && replayed.log === logVersion && replayed.ship === ship) {
    return replayed.replay;
  }
  replaying = true;
  try {
    // One ceiling per capacity the burns were made against: most rooms
    // have one or two.
    const ceilings = new Map<number, number>();
    const replay = replayLog((capacity) => {
      let ceiling = ceilings.get(capacity);
      if (ceiling === undefined) {
        ceiling = fuelCeiling(METER, capacity);
        ceilings.set(capacity, ceiling);
      }
      return ceiling;
    });
    replayed = { log: logVersion, ship, replay };
    return replay;
  } finally {
    replaying = false;
  }
}

/** What a level write keeps of the log now, by this writer's clock: the
 *  meter's settle (KeepingSettlement). Nothing while the log has never held
 *  a burn. */
function settleLog(): KeepingSettlement | undefined {
  if (!docAlive()) return undefined;
  return replayRoom().settle(Date.now());
}

/** The room's trim (its burns replayed), or null: none, unbound, or nothing
 *  well-formed. Given a station, the trim on the orbit it flies (trimFor):
 *  each orbit keeps its own, so a burn on another one (from a tab that
 *  places the room elsewhere) never hides it. No station, no trim; left
 *  out, the trim the last burn left, on whichever orbit. */
export function readOrbitTrim(station?: Pick<StationRecord, 'planetId' | 'orbitSlot'> | null): OrbitTrim | null {
  if (!docAlive()) return null;
  const { trim, trims } = replayRoom();
  const own = station === undefined ? trim : trims.find((t) => trimFor(station, t)) ?? null;
  return own && { ...own };
}

/** Where the station's trim comes from beyond this room: its other helm
 *  rooms and other installs, as whoever shares trims between them (the
 *  per-planet summary) knows it, each station's newest by isNewerTrim, with
 *  its count of burns (OrbitTrim.seq). */
export type SharedTrimSource = (station: Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot'>) => OrbitTrim | null;

let sharedTrimSource: SharedTrimSource | null = null;

/** Install the shared trim source, or remove it with null. Until one is
 *  installed, each helm room goes on from its own trim alone. */
export function setSharedTrimSource(source: SharedTrimSource | null): void {
  sharedTrimSource = source;
}

/** The station's trim as its helm rooms share it, on the orbit the station
 *  flies (trimFor), or null: no source, no station, or nothing well-formed.
 *  It may be this room's own: the helm goes on from the newer (helmTrim). A
 *  source that throws gives none. */
export function readSharedTrim(station: Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot'> | null): OrbitTrim | null {
  if (!station || !sharedTrimSource) return null;
  let found: unknown;
  try {
    found = sharedTrimSource(station);
  } catch {
    return null;
  }
  return isOrbitTrim(found) ? trimFor(station, cleanTrim(found)) : null;
}

/** Fuel trim burns have drawn in this room — every burn's that fired, added
 *  up: station keeping's draw meter. */
export function readFuelDrawn(): number {
  return docAlive() ? replayRoom().fuelDrawn : 0;
}

/** The burn firing at `realMs` on `station`'s orbit, or null: the latest
 *  burn there to have fired by then, while it is less than BURN_MS old.
 *  Whatever order the replay puts the burns in: a burn stamped ahead of our
 *  clock (a peer running fast) has not fired here yet, and never hides one
 *  that has, so it cannot let the next push skip the lockout. Only burns on
 *  the planet and slot `station` flies count (trimFor), and they are picked
 *  before the latest, so a newer burn on an orbit another install puts the
 *  room in never hides one on ours either. No station, no burn; left out,
 *  any orbit's. A dropped burn never fired. */
export function readBurnFiring(
  realMs: number,
  station?: Pick<StationRecord, 'planetId' | 'orbitSlot' | 'orbit'> | null,
): FiredBurn | null {
  if (!docAlive() || station === null) return null;
  let latest: FiredBurn | null = null;
  for (const b of replayRoom().fired) {
    if (b.at > realMs || (latest && b.at <= latest.at)) continue;
    if (station && !trimFor(station, b)) continue;
    latest = b;
  }
  return latest && isFiring(latest, realMs)
    ? { ...basisFields(latest), dir: latest.dir, at: latest.at }
    : null;
}

/** The burn firing at `realMs` as the station's helm shows it (its status
 *  line, knob and box, and the console's trim stick): the shared trim's last
 *  one while the helm flies from that trim (helmTrim), or this room's own on
 *  the station's orbit (readBurnFiring), whichever fired later (the shared
 *  trim's in the same millisecond: it is the one the helm flies). The stick
 *  waits for either (planTrim). */
export function readHelmFiring(
  realMs: number,
  station: Pick<StationRecord, 'id' | 'planetId' | 'orbitSlot'> | null,
): FiredBurn | null {
  const own = readBurnFiring(realMs, station);
  const shared = readSharedTrim(station);
  const theirs = shared && helmTrim(station, readOrbitTrim(station), shared) === shared && isFiring(shared, realMs)
    ? lastBurnOf(shared)
    : null;
  return theirs && (!own || theirs.at >= own.at) ? theirs : own;
}

/** Does the log hold MAX_LOG burns since the last level write settled it?
 *  The stick then waits for a REFUEL. */
export function isBurnLogFull(): boolean {
  return docAlive() && replayRoom().pending >= MAX_LOG;
}

/**
 * Publish a burn: its own entry, under a key that names this client and the
 * burn's time, so no other write replaces it — two burns fired at once from
 * two tabs (or an offline one) both land, and every client replays the same
 * burns to the same trim. The burn's fuel rides the same entry, so peers
 * never see one without the other, and the meter it adds to only grows. The
 * burn never writes the fuel level itself, so a REFUEL or DEPART fired at
 * the same moment keeps its cost too (see shipDoc.setFuelDrawMeter). The
 * same write clears the entries the last level write settled. The burn
 * replays after every burn the log holds as it is written, and every burn
 * along the trim it carries (TrimBurn.order, OrbitTrim.place), so the trim
 * it went on from is the trim it applies to. Owner-gated
 * at the caller. Returns whether it wrote: a malformed burn, a second one
 * from this client in the same millisecond, or one past a full log
 * (isBurnLogFull), is refused.
 */
export function writeTrimBurn(burn: TrimBurn): boolean {
  if (!docAlive()) return false;
  const clean = cleanBurn(burn);
  if (!isTrimBurn(clean)) {
    console.warn('[station keeping] refused to write a malformed burn', burn);
    return false;
  }
  const key = `${BURN_KEY_PREFIX}${boundDoc!.clientID}:${clean.at}`;
  const { covered, settledKeys, pending, place } = replayRoom();
  if (keepMap!.has(key) || covered.has(key) || pending >= MAX_LOG) return false;
  // It replays after every burn the log holds, as we saw them, even one
  // stamped ahead of our clock, and every burn along the trim it carries,
  // wherever that burn was written (TrimBurn.order, OrbitTrim.place).
  const seen = Math.max(place, trimPlace(clean.from ?? null));
  if (seen >= placeOf(clean)) clean.order = Math.min(MAX_ORDER, seen + 1);
  boundDoc!.transact(() => {
    for (const settledKey of settledKeys) keepMap!.delete(settledKey);
    keepMap!.set(key, clean);
  });
  return true;
}
