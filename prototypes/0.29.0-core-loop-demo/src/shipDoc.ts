/**
 * 🚀 Ship doc — fuel truth + flight state (#30 SH2 + SH3)
 *
 * A module becomes a spaceship when its `functions`-tagged furniture covers
 * `fuelTank` + `engine` + `helm`. Ship-ness is DERIVED from furniture, but two
 * pieces of state are their own truth and must be SHARED across every client
 * in the module:
 *
 *   - `fuel.level` — how much fuel is aboard right now (units). Capacity is
 *      derived (tanks × TANK_CAPACITY, never stored); level is doc truth so a
 *      REFUEL on one client moves the gauge on every other, and a DEPART debit
 *      is seen by everyone before the starfield swap. Station keeping's trim
 *      burns draw from the same tanks through a meter over their own records
 *      (setFuelDrawMeter), so a burn never races a REFUEL or DEPART for it,
 *      and each level write settles the burns it has seen (FuelDrawMeter.settle).
 *   - `flight`     — the state machine (docked / undocking / in-flight /
 *      redocking) that spaceship-conversion-plan.md §1.4 rules is "a record,
 *      not a simulation": passengers travel with the module for free because
 *      the module IS the room doc — no cross-doc sync, no shared frame, no
 *      touch of the leaveRoom/joinRoom seam.
 *
 * Doc key: `ship` map on the room doc, plain-JSON values only (same discipline
 * as furniture / doors / games). Rebinds per join at the T0 seam alongside the
 * other bind*Doc calls in main.ts — the previous room's doc.destroy() takes
 * the observers with it.
 *
 * Trust: owner-writes, honest-client reads (doorPolicy.ts:22-24 posture). Every
 * value read from the map is untrusted (a hostile peer could set fuel to
 * Infinity or flight.etaAt to Number.MAX_VALUE) and is shape-checked + clamped
 * against the derived capacity BEFORE it drives anything. Signed enforcement
 * is a named later slice (plan §7 SH5).
 *
 * ─── SH3 state machine (plan §5.1, §7 SH3) ───────────────────────────────────
 *
 * Legal transitions (isLegalFlightTransition — the writer-side gate):
 *
 *     from        →   to          notes
 *   ─────────────────────────────────────────────────────────────────────────
 *     docked      ═▶  in-flight   FAST-path DEPART (SH3-shipped)
 *     docked       ▶  undocking   SLOW-path DEPART (reserved for later slice)
 *     undocking    ▶  in-flight   slow-path continue (reserved)
 *     undocking    ▶  docked      slow-path abort    (reserved)
 *     in-flight    ▶  redocking   commander tick, once now ≥ etaAt
 *     redocking    ▶  docked      COMPLETE REDOCK (helm button)
 *     redocking    ▶  in-flight   reserved bounce-back
 *     <any>        ▶  <same>      idempotent self-republish (commander race)
 *
 * Two legal DEPART paths — the state machine (isLegalFlightTransition) accepts
 * BOTH so a caller may pick per-slice:
 *   - FAST path (SH3, shipped): `docked ═══▶ in-flight` in a single write.
 *     The transient-berth detach, fuel debit, and record publish happen in one
 *     commander step (see devices.ts createHelmUI's DEPART handler). No visible
 *     `undocking` beat — the SH3 first flight keeps the choreography terse.
 *   - SLOW path (reserved): `docked → undocking → in-flight`, with `undocking`
 *     as a brief hand-off beat. Kept in the machine (and its abort edge back
 *     to `docked`) so a future preflight-animation / cast-off cinematic slice
 *     can restore it without changing the state room. No writer produces
 *     `undocking` in the shipped code today; the shape guard, sanitizer, and
 *     legal-transition table all handle it for that future slice.
 *
 * `undocking` and `redocking` are BRIEF hand-off states — the transient-berth
 * lane (#67 D2, shipped) does the physical detach/attach. They exist so:
 *   - the exterior view can hide the outbound projections BEFORE the starfield
 *   - the arrival curtain has a distinct value to render ("APPROACHING FURLONG")
 *   - the DEPART/redock choreography can be resumed after a client reload:
 *     the record ALONE says what state we are in.
 *
 * A `chained` module (permanent connector-chain neighbour) CANNOT depart — the
 * plan's "chained modules cannot fly, by construction" invariant. That check
 * lives in the caller (docking + doors doc), the state machine only enforces
 * legal FLIGHT transitions.
 */

import * as Y from 'yjs';
import type { DoorWall } from './doorLayoutDoc';
import { isAcceptableDoorKey } from './doorsDoc';
import {
  DEFAULT_STATIONS,
  findStation,
  isKnownStation,
  localStationId,
  locationPlanet,
  listStations,
  portableStationId,
  type StationDestination,
} from './stationDirectory';

// ── Constants (plan §5) ──────────────────────────────────────────────────────

/** Fuel units per mounted `fuel-tank`. Chosen so `fuelCostMultiplier` (zoom.ts)
 *  values map to 1–2 units per hop at typical loadouts; a room with one tank
 *  carries multiple hops of fuel out of the box. */
export const TANK_CAPACITY = 100;

/** Destinations come from the station directory (stationDirectory.ts) — one
 *  small seam the station record can later point at. Fuel cost is flat per hop
 *  (continuous burn needs a clock authority nobody has yet). `travelMs` is
 *  writer-clock duration; every viewer interpolates against
 *  `departedAt`/`etaAt` clamped to [0, 1] and treats `etaAt passed ⇒ arrived`
 *  regardless of status — the clock-skew posture (plan §2 read-side
 *  resolution). */
export type Destination = StationDestination;

/** The static table the directory serves until the station record lands. */
export const DESTINATIONS: readonly Destination[] = DEFAULT_STATIONS;

/** Look up a destination by id; unknown ids resolve to home (plan §2, item 4). */
export function findDestination(id: string): Destination {
  return findStation(id);
}

// ── Records (plan §2) ────────────────────────────────────────────────────────

/** Flight state machine states. `docked` / `in-flight` are the resting states;
 *  `undocking` / `redocking` are transitional hand-offs (see the ASCII above). */
export type FlightStatus = 'docked' | 'undocking' | 'in-flight' | 'redocking';

/** Serializable flight record — one per module. Plain JSON (no nested Y types). */
export interface FlightRecord {
  status: FlightStatus;
  /** Where the ship IS (docked/arrived) — a DESTINATIONS id. */
  locationId: string;
  /** Where the ship is going. Present iff `status === 'in-flight'` or
   *  `status === 'undocking'` (destination chosen but not yet in transit). */
  destinationId?: string;
  /** Writer-clock epoch ms of the DEPART. Undefined outside transit. */
  departedAt?: number;
  /** Writer-clock epoch ms the flight will arrive. Undefined outside transit.
   *  Guard: `etaAt > departedAt` (rejected on read otherwise). */
  etaAt?: number;
  /** Writer-clock epoch ms DEPART cast off (the booking), which can be well
   *  before `departedAt` (the launch window it waits for). Kept through
   *  `redocking`, so arrival can tell what changed while the ship was away. */
  castOffAt?: number;
}

/** Serializable fuel record. Capacity is DERIVED (tanks × TANK_CAPACITY) — never
 *  stored — so removing a tank silently caps the effective level on read.
 *  `meters` holds each draw meter's reading (setFuelDrawMeter) when the level
 *  was written, by the meter's name; a meter it leaves out read 0. `meter` is
 *  those readings added up: all a record from before per-meter readings
 *  has, and what a build from before them reads. `settled` holds what a
 *  meter handed the write to keep beside its reading (FuelDrawMeter.settle),
 *  by the same names. */
export interface FuelRecord {
  level: number;
  meters?: Record<string, number>;
  meter?: number;
  settled?: Record<string, unknown>;
}

// ── Wire-up (mirror bindFurnitureDoc / bindDoorsDoc / bindGamesDoc) ──────────

let boundDoc: Y.Doc | null = null;
let shipMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();
/** Counts changes to the ship doc and the draw meters (shipVersion). */
let version = 0;

/** A number that moves whenever the bound ship doc or a draw meter changes,
 *  before any subscriber hears of it: a reader that caches what it derives
 *  from the fuel record compares it instead of listening. */
export function shipVersion(): number {
  return version;
}

function notify(): void {
  version += 1;
  // Copy: a listener may unsubscribe mid-notify. Isolate: one throwing reconcile
  // must not kill the others or Yjs's transaction cleanup (same guard as
  // gamesDoc / furnitureDoc / doorsDoc).
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[ship] listener threw during doc notify:', err);
    }
  }
}

export function bindShipDoc(doc: Y.Doc): void {
  boundDoc = doc;
  shipMap = doc.getMap('ship');
  shipMap.observe(() => notify());
  notify(); // reconcile from the FRESH doc (mirror of bindFurnitureDoc)
}

export function subscribeShip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    shipMap !== null
  );
}

/** True iff the doc has been bound and its map is live. Exposed for tests
 *  and diagnostics (mirror of treasuryDocBound / gamesDocBound). */
export function shipDocBound(): boolean {
  return docAlive();
}

// ── Shape guards (values cross a trust boundary — see module header) ─────────

const FLIGHT_STATUSES: readonly FlightStatus[] = ['docked', 'undocking', 'in-flight', 'redocking'];

/** `locationId` and `destinationId` are compared against DESTINATIONS on read
 *  (unknown ⇒ home), so we only sanity-check bounded string shape here — a
 *  hostile 4 MB string would still eat memory before the resolver saved us. */
const MAX_LOC_ID_LEN = 128; // = stations.ts's station-id bound

function isFlightStatus(v: unknown): v is FlightStatus {
  return typeof v === 'string' && (FLIGHT_STATUSES as readonly string[]).includes(v);
}

function isBoundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_LOC_ID_LEN;
}

/** Shape guard for a FlightRecord — a hostile peer could write any shape here,
 *  and downstream (state-machine legal-transitions, exterior branch, checklist
 *  copy) MUST see a well-formed value or the honest-client posture leaks. */
export function isFlightRecord(v: unknown): v is FlightRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<FlightRecord>;
  if (!isFlightStatus(r.status)) return false;
  if (!isBoundedString(r.locationId)) return false;
  // In-flight / undocking hold a destination; the resting states MAY carry a
  // stale destinationId (a docked record just after arrival, for example) — we
  // strip in `sanitizeFlightRecord`, but the SHAPE is legal either way.
  if (r.destinationId !== undefined && !isBoundedString(r.destinationId)) return false;
  if (r.departedAt !== undefined && !isFlightTime(r.departedAt)) return false;
  if (r.etaAt !== undefined && !isFlightTime(r.etaAt)) return false;
  if (r.castOffAt !== undefined && !isFlightTime(r.castOffAt)) return false;
  // The etaAt > departedAt invariant is enforced HERE — otherwise a peer could
  // write etaAt <= departedAt and every viewer would render "arrived instantly"
  // with no way to know the record is malformed.
  if (r.status === 'in-flight' || r.status === 'undocking') {
    if (r.destinationId === undefined) return false;
    if (r.status === 'in-flight') {
      if (r.departedAt === undefined || r.etaAt === undefined) return false;
      if (!(r.etaAt > r.departedAt)) return false;
      // A flight longer than any launch-window wait plus transfer would hold
      // the ship in flight (and so out of DEPART) for good.
      if (r.etaAt - r.departedAt > MAX_FLIGHT_AHEAD_MS) return false;
    }
  }
  return true;
}

/** Longest a flight may run, and how far ahead of now any of its times may
 *  lie: the longest launch-window wait plus the longest transfer between two
 *  slots (orbits.ts, 60x clock) come to well under a day of real time. */
export const MAX_FLIGHT_AHEAD_MS = 2 * 24 * 3600 * 1000;

/** A peer-written flight time: a whole ms epoch, no later than
 *  MAX_FLIGHT_AHEAD_MS from now (a far-future one would never arrive). */
function isFlightTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= Date.now() + MAX_FLIGHT_AHEAD_MS;
}

function isFuelRecord(v: unknown): v is FuelRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<FuelRecord>;
  return typeof r.level === 'number' && Number.isFinite(r.level);
}

/** DEFAULT flight record — every empty/unbound/hostile-record path resolves
 *  here. `docked at home` matches "an unopened room doc IS today's module"
 *  (plan §2, item 3). */
export function defaultFlight(): FlightRecord {
  return { status: 'docked', locationId: listStations()[0].id };
}

/** Strip stale fields when the status doesn't need them. Called on write and
 *  in the read-side resolver — a docked record shouldn't carry a departedAt
 *  timestamp, and rendering code shouldn't have to defensively ignore it. */
function sanitizeFlightRecord(r: FlightRecord): FlightRecord {
  // Station ids are per install: read another install's ids as ours.
  const out: FlightRecord = { status: r.status, locationId: localStationId(r.locationId) };
  if (r.status === 'undocking' || r.status === 'in-flight') {
    if (r.destinationId !== undefined) out.destinationId = localStationId(r.destinationId);
    if (r.status === 'in-flight') {
      if (r.departedAt !== undefined) out.departedAt = r.departedAt;
      if (r.etaAt !== undefined) out.etaAt = r.etaAt;
      if (r.castOffAt !== undefined && (r.departedAt === undefined || r.castOffAt <= r.departedAt)) out.castOffAt = r.castOffAt;
    }
  }
  // An arrived ship keeps WHEN it arrived: the arrival waits a short grace
  // for a commander who can dock before any client settles it berthless.
  if (r.status === 'redocking' && r.etaAt !== undefined) out.etaAt = r.etaAt;
  // … and when it left, so arrival can tell a destination that moved away
  // mid-flight (stationMove.ts) from one that was always there.
  if (r.status === 'redocking' && r.departedAt !== undefined && r.etaAt !== undefined && r.etaAt > r.departedAt) {
    out.departedAt = r.departedAt;
    if (r.castOffAt !== undefined && r.castOffAt <= r.departedAt) out.castOffAt = r.castOffAt;
  }
  return out;
}

// ── Draws that ride another record (station keeping) ────────────────────────
//
// `fuel.level` is written whole, and Yjs keeps one of two concurrent writes to
// a key. REFUEL and DEPART each write the level from the gauge they read. A
// station-keeping burn fired at the same moment from another tab (or an
// offline one) writes its own record too, and if it ALSO wrote the level, one
// of the two debits would vanish when the tabs sync. So a consumer that keeps
// its own records draws through a METER there instead: a running total of the
// fuel IT has drawn, raised in the same write as the thing it paid for. Each
// meter has its own name, and every level write records each meter's reading
// beside the level, so the draws the writer had seen are folded into the
// level; the tank reads the level less what each meter has drawn past its own
// recorded reading, so draws the writer had not seen still come off, and two
// consumers drawing at once both count.
//
// A total kept under one key that each draw rewrites whole can go BACK: an
// offline tab's older total wins the merge. The draws it lost were folded
// into the level already, so a meter below its recorded reading takes nothing
// off (no refund), and that consumer's next draw adds what its own meter owes
// (fuelDrawDeficit) so it does not go free either. Only the consumer whose
// meter went back owes it: a shared catch-up would be paid again by every
// consumer that drew. Station keeping's meter never goes below its recorded
// reading — each burn is its own entry (stationKeeping.writeTrimBurn), and
// the replay starts from what the last level write settled.
//
// Two draws that each fit the gauge can still overdraw it together: two tabs
// spending the last unit at once, or a draw beside a DEPART that takes the
// rest. A consumer that can drop a draw after the fact (a trim burn only
// nudges an orbit) keeps its meter within fuelCeiling, what the level covers
// beyond every other meter's draws, and drops the draws past it the same way
// on every client, so it yields to every other draw. A level write settles
// those calls: the meter hands it a settlement (FuelDrawMeter.settle), kept
// beside the meter's reading, naming what the level has paid for and what was
// dropped. A later REFUEL that raises the ceiling brings nothing dropped back,
// and the consumer can clear what was settled from its own records.

/** A meter reads at most this: a running fuel total stays well inside exact
 *  integers, and a hostile reading past it counts as none. */
export const FUEL_METER_MAX = 1e12;

/** A meter's name, which the fuel record keys its reading by. */
const METER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A fuel record keeps at most this many meters' readings: this build's
 *  meters first, then any another build draws through. */
const MAX_METERS = 16;

/** One consumer's running total of the fuel it has drawn, kept in its own
 *  record. `settle`, when the meter has one, hands each level write what to
 *  keep beside the meter's reading (readFuelSettlement): plain JSON, or
 *  undefined to keep what the record held. */
export interface FuelDrawMeter {
  read(): number;
  subscribe(listener: () => void): () => void;
  settle?(): unknown;
}

const drawMeters = new Map<string, { meter: FuelDrawMeter; unsubscribe: () => void }>();

/** Install one consumer's draw meter under its name (null removes it): a
 *  letter, then up to 63 letters, digits, `-` or `_`. A meter change moves
 *  the gauge, so ship subscribers hear about it too. */
export function setFuelDrawMeter(name: string, meter: FuelDrawMeter | null): void {
  if (!METER_NAME.test(name)) throw new Error(`[ship] not a fuel draw meter name: ${JSON.stringify(name)}`);
  drawMeters.get(name)?.unsubscribe();
  drawMeters.delete(name);
  if (meter) drawMeters.set(name, { meter, unsubscribe: meter.subscribe(() => notify()) });
  version += 1;
}

/** A meter value off the wire: anything but a number in (0, FUEL_METER_MAX] is 0. */
function meterValue(v: unknown): number {
  return typeof v === 'number' && v > 0 && v <= FUEL_METER_MAX ? v : 0;
}

/** Every meter's reading, added up: what a record from before per-meter
 *  readings was written against. */
function meterReading(): number {
  let total = 0;
  for (const { meter } of drawMeters.values()) total += meterValue(meter.read());
  return total;
}

/** The readings a fuel record was written against, by meter name, or null
 *  for a record from before per-meter readings. Names and values are checked
 *  as they come off the wire, and at most MAX_METERS count. */
function recordedMeters(rec: FuelRecord): Map<string, number> | null {
  const raw: unknown = rec.meters;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out = new Map<string, number>();
  for (const [name, v] of Object.entries(raw)) {
    if (out.size >= MAX_METERS) break;
    const value = meterValue(v);
    if (value > 0 && METER_NAME.test(name)) out.set(name, value);
  }
  return out;
}

/** What the meters have drawn since the level was written: each meter past
 *  its own recorded reading. A record from before per-meter readings is read
 *  against their sum. */
function drawnSince(rec: FuelRecord): number {
  const recorded = recordedMeters(rec);
  if (!recorded) return Math.max(0, meterReading() - meterValue(rec.meter));
  let drawn = 0;
  for (const [name, { meter }] of drawMeters) {
    drawn += Math.max(0, meterValue(meter.read()) - (recorded.get(name) ?? 0));
  }
  return drawn;
}

/** How far meter `name` has fallen below its reading when the level was
 *  written: 0 unless an older record of that consumer won a merge. The
 *  consumer drawing `amount` writes its own total + fuelDrawDeficit(name) +
 *  amount, so its meter going back neither refunds fuel nor lets its next
 *  draw go free. A record from before per-meter readings cannot say whose
 *  meter went back, so it owes nothing. */
export function fuelDrawDeficit(name: string): number {
  const raw = docAlive() ? shipMap!.get('fuel') : undefined;
  if (!isFuelRecord(raw)) return 0;
  const recorded = recordedMeters(raw);
  if (!recorded) return 0;
  const entry = drawMeters.get(name);
  return Math.max(0, (recorded.get(name) ?? 0) - (entry ? meterValue(entry.meter.read()) : 0));
}

/** The highest reading meter `name` may reach while the fuel covers every
 *  draw: its reading when the level was written, plus what tanks of
 *  `capacity` hold of the level beyond every other meter's draws since (the
 *  gauge readFuelLevel(capacity) shows, turned into a bound). A consumer
 *  that drops the draws the fuel cannot cover (station keeping) drops those
 *  that would take its meter past this, so it yields to every other draw;
 *  it passes the capacity each draw was made against, so a later change of
 *  tanks never takes back a draw it paid for. A record from before
 *  per-meter readings is read against their sum. No record, no fuel: 0. */
export function fuelCeiling(name: string, capacity = Number.POSITIVE_INFINITY): number {
  const raw = docAlive() ? shipMap!.get('fuel') : undefined;
  if (!isFuelRecord(raw)) return 0;
  const held = capacity >= 0 ? Math.min(raw.level, capacity) : 0;
  const recorded = recordedMeters(raw);
  let others = 0;
  for (const [other, { meter }] of drawMeters) {
    if (other === name) continue;
    const reading = meterValue(meter.read());
    others += recorded ? Math.max(0, reading - (recorded.get(other) ?? 0)) : reading;
  }
  if (!recorded) return Math.max(0, meterValue(raw.meter) + held - others);
  return (recorded.get(name) ?? 0) + Math.max(0, held - others);
}

/** A fuel record's settlements by meter name, as they come off the wire:
 *  names checked, at most MAX_METERS. */
function settlementsOf(rec: FuelRecord): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const raw: unknown = rec.settled;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw)) {
    if (out.size >= MAX_METERS) break;
    if (METER_NAME.test(name) && v !== undefined) out.set(name, v);
  }
  return out;
}

/** What meter `name` handed the level write that made the current fuel
 *  record (FuelDrawMeter.settle), or undefined. Untrusted: the meter checks
 *  its shape. */
export function readFuelSettlement(name: string): unknown {
  const raw = docAlive() ? shipMap!.get('fuel') : undefined;
  return isFuelRecord(raw) ? settlementsOf(raw).get(name) : undefined;
}

// ── Reads (untrusted; every path degrades to defaults, never throws) ─────────

/** Fuel level from the doc, less any draws through the meter since it was
 *  written. Pass the tanks' CURRENT capacity: a draw comes out of what the
 *  fitted tanks hold, never out of fuel stranded by a removed tank (which
 *  comes back if the tank does). The capacity clamp itself happens in the
 *  caller (owner-only REFUEL write already clamps to the CURRENT capacity —
 *  see writeFuelLevel). */
export function readFuelLevel(capacity = Number.POSITIVE_INFINITY): number {
  if (!docAlive()) return 0;
  const raw = shipMap!.get('fuel');
  if (!isFuelRecord(raw)) return 0;
  const held = capacity >= 0 ? Math.min(raw.level, capacity) : 0;
  // Negative-fuel guard belongs here too — a peer could write -Infinity and
  // every reader would fail-open otherwise. Clamp to [0, +∞) at the boundary;
  // capacity clamp is a caller responsibility (see clampFuelToCapacity).
  return Math.max(0, held - drawnSince(raw));
}

/** Fuel level clamped against the CURRENT derived capacity (tanks removed
 *  after a fill silently strand overflow — plan §2, item 2). */
export function clampFuelToCapacity(level: number, capacity: number): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  if (!Number.isFinite(capacity) || capacity < 0) return 0;
  return Math.min(level, capacity);
}

/** Read the flight record with defaults + shape sanitization. An UNKNOWN
 *  `locationId` resolves via findDestination() at render time (plan §2). */
export function readFlightRecord(): FlightRecord {
  if (!docAlive()) return defaultFlight();
  const raw = shipMap!.get('flight');
  if (!isFlightRecord(raw)) return defaultFlight();
  return sanitizeFlightRecord(raw);
}

// ── Writes (owner-gated at the CALLER; single-writer per key/phase) ──────────

/** Publish the fuel level after clamping to the current derived capacity.
 *  `level` is what the gauge should read now; the record keeps each draw
 *  meter's reading beside it, never below the one it recorded before, so
 *  the draws this writer has seen stay counted once (see setFuelDrawMeter),
 *  and each meter's settlement (FuelDrawMeter.settle) with it. A meter only
 *  another build draws through keeps its recorded reading and settlement.
 *  Owner-gated at the caller (helm UI). The write is idempotent: the same
 *  level twice leaves the same record. */
export function writeFuelLevel(level: number, capacity: number): void {
  if (!docAlive()) return;
  const safe = clampFuelToCapacity(level, capacity);
  const raw = shipMap!.get('fuel');
  const before = isFuelRecord(raw) ? recordedMeters(raw) : null;
  const settledBefore = isFuelRecord(raw) ? settlementsOf(raw) : null;
  const meters: Record<string, number> = {};
  const settled: Record<string, unknown> = {};
  let count = 0;
  let sum = 0;
  let settledCount = 0;
  const record = (name: string, reading: number): void => {
    if (reading <= 0 || count >= MAX_METERS) return;
    meters[name] = reading;
    count += 1;
    sum += reading;
  };
  const keep = (name: string, settlement: unknown): void => {
    if (settlement === undefined || settledCount >= MAX_METERS) return;
    settled[name] = settlement;
    settledCount += 1;
  };
  for (const [name, { meter }] of drawMeters) {
    record(name, Math.max(meterValue(meter.read()), before?.get(name) ?? 0));
    keep(name, meter.settle?.() ?? settledBefore?.get(name));
  }
  for (const [name, reading] of before ?? []) if (!drawMeters.has(name)) record(name, reading);
  for (const [name, settlement] of settledBefore ?? []) if (!drawMeters.has(name)) keep(name, settlement);
  const next: FuelRecord = count > 0 ? { level: safe, meters, meter: sum } : { level: safe };
  if (settledCount > 0) next.settled = settled;
  boundDoc!.transact(() => {
    shipMap!.set('fuel', next);
  });
}

/** Publish the flight record. Owner-gated at the caller. Validates TWO
 *  invariants BEFORE writing (defense in depth; readFlightRecord's guard would
 *  filter a bad record too, but a rejected write is louder than a
 *  silently-reverted one):
 *
 *    1. SHAPE — sanitize + isFlightRecord: kills malformed / stale-field /
 *       etaAt<=departedAt records at the wire.
 *    2. LEGAL-TRANSITION — isLegalFlightTransition against the CURRENT record:
 *       an existing well-formed record only advances along an edge the state
 *       machine allows. On a fresh doc (no prior record) any status is a legal
 *       SEED — matching the "an unopened room doc IS today's module" ruling in
 *       the header. A prior record that itself fails the shape guard is treated
 *       as absent, so the writer can HEAL from a corrupt map entry rather than
 *       stranding the ship.
 *
 *  Rejections are non-throwing (console.warn + no-op) so a bad caller cannot
 *  wedge a doc.transact half-write on the map. Returns whether it wrote. */
export function writeFlightRecord(rec: FlightRecord): boolean {
  if (!docAlive()) return false;
  const clean = sanitizeFlightRecord(rec);
  if (!isFlightRecord(clean)) {
    console.warn('[ship] refused to write malformed flight record', rec);
    return false;
  }
  // Transition-legality gate — read the current record OUTSIDE the transact
  // (no lock; honest-client posture, SH5 signed enforcement is a later slice).
  // A hostile / bogus current record fails isFlightRecord and is treated as
  // "no prior record", so the writer can seed a fresh legal state on top of
  // corruption instead of being permanently blocked.
  const raw = shipMap!.get('flight');
  if (isFlightRecord(raw)) {
    const current = sanitizeFlightRecord(raw);
    if (!isLegalFlightTransition(current.status, clean.status)) {
      console.warn(
        `[ship] refused illegal flight transition ${current.status} -> ${clean.status}`,
        rec,
      );
      return false;
    }
  }
  // Station ids are per install: the shared record names each station by
  // its welcome room, so every install reads the same one back.
  const shared: FlightRecord = { ...clean, locationId: portableStationId(clean.locationId) };
  if (clean.destinationId !== undefined) shared.destinationId = portableStationId(clean.destinationId);
  boundDoc!.transact(() => {
    shipMap!.set('flight', isFlightRecord(shared) ? shared : clean);
  });
  return true;
}

// ── State-machine legal transitions (pure — testable without a doc) ──────────

/** True iff `to` is a legal successor of `from` per the SH3 machine above.
 *  The predicate is CALLER-gated (owner-only, canDepart check, etc.); this
 *  answers only the state-transition question. */
export function isLegalFlightTransition(from: FlightStatus, to: FlightStatus): boolean {
  if (from === to) return true; // idempotent republish
  switch (from) {
    case 'docked':
      // Two DEPART paths (see header): the SH3 FAST path lands directly at
      // 'in-flight' without a visible undocking hand-off, the reserved SLOW
      // path pauses at 'undocking' for a future preflight-animation slice.
      // Both are downstream of canDepart at the caller (owner, fuel, chain).
      return to === 'undocking' || to === 'in-flight';
    case 'undocking':
      // Reserved slow-path successors: continue to 'in-flight' or abort back
      // to 'docked'. No writer produces 'undocking' in the shipped SH3 code
      // (the DEPART flow fast-paths past it), but the transition legality
      // stays populated so a later slice can restore the hand-off beat
      // without changing the state room.
      return to === 'in-flight' || to === 'docked';
    case 'in-flight': return to === 'redocking';
    case 'redocking': return to === 'docked' || to === 'in-flight'; // arrive or bounced
  }
}

/** Reasons a DEPART is refused. Surface these in the helm UI verbatim — the
 *  player deserves to know WHY, not just that a button is greyed. */
export type DepartRefusal =
  | { ok: true }
  | { ok: false; reason: 'not-flight-capable' }
  | { ok: false; reason: 'not-docked' }
  | { ok: false; reason: 'insufficient-fuel'; needed: number; have: number }
  | { ok: false; reason: 'chained-berth'; chainedDoors: readonly string[] }
  | { ok: false; reason: 'unknown-destination' }
  | { ok: false; reason: 'already-here' }
  | { ok: false; reason: 'other-planet' }
  | { ok: false; reason: 'no-transfer' }
  /** The ship's station is not on this client's list: nothing to plan from. */
  | { ok: false; reason: 'unlisted-location' }
  | { ok: false; reason: 'no-owner' };

/** Inputs the caller assembles from the live docs — kept as a plain struct so
 *  the check is pure and testable (no world/DOM/doc access here). */
export interface DepartContext {
  /** derived from furniture: tanks + engines + helms all ≥ 1 */
  flightCapable: boolean;
  currentStatus: FlightStatus;
  currentFuel: number;
  destinationId: string;
  /** Door ids whose pairing is a PERMANENT connector chain (not a transient
   *  berth). Plan §5.1: chained modules cannot fly by construction. */
  chainedDoors: readonly string[];
  /** True when the local player is authorized (owner-equivalent). */
  ownerAuthorized: boolean;
  /** Where the ship is now. When given, the destination must be ANOTHER
   *  station orbiting the same planet (ships fly between one planet's
   *  stations; interplanetary travel is not a v1 hop). */
  locationId?: string;
  /** The planned hop (stationDirectory.planHop). When given, its fuel cost
   *  replaces the destination's flat one, and null means no transfer exists
   *  (a shared orbit, say). */
  hop?: { fuelCost: number } | null;
}

/** Predicate the DEPART button funnels through. Returns the refusal reason so
 *  the button can render "REFUEL FIRST" / "UNPAIR THE ADAPTER TO x" etc. */
export function canDepart(ctx: DepartContext): DepartRefusal {
  if (!ctx.ownerAuthorized) return { ok: false, reason: 'no-owner' };
  if (!ctx.flightCapable) return { ok: false, reason: 'not-flight-capable' };
  if (ctx.currentStatus !== 'docked') return { ok: false, reason: 'not-docked' };
  if (!isKnownStation(ctx.destinationId)) return { ok: false, reason: 'unknown-destination' };
  const dest = findStation(ctx.destinationId);
  if (ctx.locationId !== undefined) {
    if (ctx.locationId === dest.id) return { ok: false, reason: 'already-here' };
    // An unlisted station reads as home here (findStation's fallback), and
    // its hops can never be planned: say so, not "a shared orbit".
    const planet = locationPlanet(ctx.locationId);
    if (planet === null) return { ok: false, reason: 'unlisted-location' };
    if (planet !== dest.planetId) {
      return { ok: false, reason: 'other-planet' };
    }
  }
  if (ctx.chainedDoors.length > 0) {
    return { ok: false, reason: 'chained-berth', chainedDoors: ctx.chainedDoors };
  }
  if (ctx.hop === null) return { ok: false, reason: 'no-transfer' };
  const cost = ctx.hop ? ctx.hop.fuelCost : dest.fuelCost;
  if (ctx.currentFuel < cost) {
    return { ok: false, reason: 'insufficient-fuel', needed: cost, have: ctx.currentFuel };
  }
  return { ok: true };
}

/** Progress in [0, 1] for the in-flight interpolation. `now` is passed for
 *  determinism (tests). `etaAt` in the past ⇒ 1 (arrived); missing timestamps
 *  ⇒ 0 (no progress signal available). */
export function flightProgress(rec: FlightRecord, now: number): number {
  if (rec.status !== 'in-flight') return rec.status === 'redocking' ? 1 : 0;
  if (rec.departedAt === undefined || rec.etaAt === undefined) return 0;
  if (!(rec.etaAt > rec.departedAt)) return 0;
  const total = rec.etaAt - rec.departedAt;
  const done = now - rec.departedAt;
  if (done <= 0) return 0;
  if (done >= total) return 1;
  return done / total;
}

/** True iff the etaAt has passed (or a redocking record is in play). Plan §2,
 *  item 3: "etaAt passed ⇒ arrived regardless of status" — clock skew posture. */
export function flightArrived(rec: FlightRecord, now: number): boolean {
  if (rec.status === 'redocking') return true;
  if (rec.status !== 'in-flight') return false;
  return rec.etaAt !== undefined && now >= rec.etaAt;
}

// ── Pairing / berth gate against flight state (pure — testable without a doc) ─
//
// PR #134 audit MAJOR: the DEPART-time flight gate on the outbound INITIATE
// path (docking.ts's REQUEST BERTHING handler) is not enough. A remote peer
// could send a pairing REQUEST while the module was still docked, and a helm
// commander could DEPART before the local user hit ACCEPT — the ACCEPT click
// would then complete the pairing on an already-in-flight module, latching a
// station door onto a target that has literally moved out from under it.
//
// The fix is a SHARED PREDICATE (this function) applied at the pairing-
// completion seam (`completePairing`'s accept branch), NOT just at the INITIATE
// UX gate. Every accept — outbound INITIATE, inbound ACCEPT, and any future
// pairing-completion caller — funnels through the same check.
//
// The predicate answers only the flight-state question; the caller is still
// responsible for owner-gating, construction rights, and the transient-berth
// contract. It is DELIBERATELY narrow so it can be reused unchanged as the
// slow-path `undocking` beat and any bounce-back / cast-off cinematic land in
// later slices without a state-room change.

/** Reasons a berthing / pairing completion is refused by the flight state.
 *  `reason: 'flight'` carries the offending status so the caller's alert can
 *  say "IN-FLIGHT" rather than "not docked" — the SH3 REDOCKING and future
 *  slow-path UNDOCKING beats deserve their own copy at the boundary. */
export type PairingRefusal =
  | { ok: true }
  | { ok: false; reason: 'flight'; status: FlightStatus };

/** True iff a new pairing may complete against the local module given its
 *  current flight record. A `docked` module always accepts; every other
 *  status refuses, so `undocking` / `in-flight` / `redocking` are all
 *  covered — a redocking ship's transient re-berthing is a shipped #67 D2
 *  flow, NOT a fresh accept/publish through completePairing. */
export function pairingAllowedByFlight(rec: FlightRecord): PairingRefusal {
  if (rec.status === 'docked') return { ok: true };
  return { ok: false, reason: 'flight', status: rec.status };
}

// ── Berth memory — where this ship docks at each station (#30 SH3) ───────────
//
// A ship flies away from a dock and should come back to it. At DEPART the helm
// records, per station, which of the ship's ports was docked and to which berth
// (room seed + far door geometry — exactly a DOCK tombstone's memory). On
// arrival the berth comes from the station directory when the station names a
// public one, else from this memory; the helm re-points the port at it and
// runs the ordinary DOCK (docking.ts redockPort), so the arrival dock obeys
// every shipped dock rule — far CAS, overlap guard, construction rights.
//
// Plain JSON under `ship.berths`, `{ [stationId]: BerthMemoryRecord }`,
// shape-guarded on read like every other ship value.

/** One remembered berth: which ship port docked where. The ship doc is
 *  shared with every passenger, so it names the berth ROOM, never its pass
 *  (stationAtlas's credential rule): arrival finds a pass this client holds
 *  for that room, or the berth is out of reach from here. */
export interface BerthMemoryRecord {
  /** The SHIP's door that wore the dock. */
  doorId: string;
  /** The berth room's id (not its pass). */
  roomId: string;
  farDoor?: string;
  farWall?: DoorWall;
  farLateral?: number;
}

const MAX_BERTH_STATIONS = 32;
const DOOR_WALLS: readonly string[] = ['x+', 'x-', 'y+', 'y-'];
/** Same bound the door and atlas records put on a lateral offset. */
const MAX_FAR_LATERAL = 32;
/** How many raw keys a read inspects before giving up: junk keys a peer
 *  wrote must not make every helm render walk an unbounded map. */
const MAX_BERTH_KEYS_SCANNED = MAX_BERTH_STATIONS * 4;

export function isBerthMemoryRecord(v: unknown): v is BerthMemoryRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Partial<BerthMemoryRecord>;
  if (!isBoundedString(r.doorId)) return false;
  if (!isBoundedString(r.roomId)) return false;
  // A pass never rides here (see BerthMemoryRecord).
  if ((r as { address?: unknown }).address !== undefined) return false;
  // The door-key rule doorsDoc reads with: a farDoor it would strip would
  // turn DOCK into a one-sided pairing that skips the far-berth check.
  if (r.farDoor !== undefined && !(typeof r.farDoor === 'string' && isAcceptableDoorKey(r.farDoor))) return false;
  if (r.farWall !== undefined && !DOOR_WALLS.includes(r.farWall as string)) return false;
  if (r.farLateral !== undefined && !(typeof r.farLateral === 'number' && Number.isFinite(r.farLateral)
    && Math.abs(r.farLateral) <= MAX_FAR_LATERAL)) return false;
  return true;
}

function cleanBerth(r: BerthMemoryRecord): BerthMemoryRecord {
  const out: BerthMemoryRecord = { doorId: r.doorId, roomId: r.roomId };
  if (r.farDoor !== undefined) out.farDoor = r.farDoor;
  if (r.farWall !== undefined) out.farWall = r.farWall;
  if (r.farLateral !== undefined) out.farLateral = r.farLateral;
  return out;
}

/** Every remembered berth, junk entries dropped. */
export function readBerthMemory(): Record<string, BerthMemoryRecord> {
  // Null prototype: station ids are peer-written strings, and an id such as
  // 'constructor' must never read back an inherited value.
  const out: Record<string, BerthMemoryRecord> = Object.create(null);
  if (!docAlive()) return out;
  const raw = shipMap!.get('berths');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const map = raw as Record<string, unknown>;
  let n = 0;
  let scanned = 0;
  for (const stationId in map) {
    if (n >= MAX_BERTH_STATIONS || scanned >= MAX_BERTH_KEYS_SCANNED) break;
    scanned++;
    if (!Object.prototype.hasOwnProperty.call(map, stationId)) continue;
    const rec = map[stationId];
    if (!isBoundedString(stationId) || !isBerthMemoryRecord(rec)) continue;
    out[stationId] = cleanBerth(rec);
    n++;
  }
  return out;
}

/** The berth this ship remembers at `stationId`, if any. */
export function readStationBerth(stationId: string): BerthMemoryRecord | null {
  return readBerthMemory()[stationId] ?? null;
}

/** Remember (or, with null, forget) the berth at `stationId`. Owner-gated at
 *  the caller, like every ship write. A NEW station past MAX_BERTH_STATIONS is
 *  refused (a write the reader would truncate is a berth silently lost);
 *  updating or forgetting a remembered one always works. Returns whether the
 *  memory now holds what was asked. */
export function writeStationBerth(stationId: string, rec: BerthMemoryRecord | null): boolean {
  if (!docAlive() || !isBoundedString(stationId)) return false;
  if (rec !== null && !isBerthMemoryRecord(rec)) {
    console.warn('[ship] refused to write malformed berth memory', rec);
    return false;
  }
  const next = readBerthMemory();
  if (rec === null) {
    delete next[stationId];
  } else {
    if (!(stationId in next) && Object.keys(next).length >= MAX_BERTH_STATIONS) {
      console.warn(`[ship] berth memory is full (${MAX_BERTH_STATIONS} stations) — not remembering ${stationId}`);
      return false;
    }
    next[stationId] = cleanBerth(rec);
  }
  boundDoc!.transact(() => {
    shipMap!.set('berths', { ...next });
  });
  return true;
}
