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
 *      is seen by everyone before the starfield swap.
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
 *          ┌──────────┐   depart(dest)     ┌───────────┐
 *          │  docked  │ ──────────────────▶│ undocking │
 *          └────▲─────┘                    └─────┬─────┘
 *               │                                │  (transient berths detached,
 *               │                                │   fuel debited)
 *               │                                ▼
 *          ┌────┴──────┐   arrive(location) ┌─────────────┐
 *          │ redocking │◀───────────────────┤  in-flight  │
 *          └────▲──────┘   (etaAt passed)   └──────┬──────┘
 *               │                                  │
 *               │           (redock accepted)      │
 *               └──────────────────────────────────┘
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

// ── Constants (plan §5) ──────────────────────────────────────────────────────

/** Fuel units per mounted `fuel-tank`. Chosen so `fuelCostMultiplier` (zoom.ts)
 *  values map to 1–2 units per hop at typical loadouts; a room with one tank
 *  carries multiple hops of fuel out of the box. */
export const TANK_CAPACITY = 100;

/** Rounded travel time floor — arrivals cluster around this so clock skew never
 *  visibly stretches into minutes at typical WAN drift. Plan §5.1 target
 *  60–120 s; we bracket the middle. */
const TRAVEL_MS_MIN = 60_000;

/** Static destination table (plan §5.2). Fuel cost is flat per hop (continuous
 *  burn needs a clock authority nobody has yet). `travelMs` is writer-clock
 *  duration; every viewer interpolates against `departedAt`/`etaAt` clamped
 *  to [0, 1] and treats `etaAt passed ⇒ arrived` regardless of status — the
 *  clock-skew posture (plan §2 read-side resolution). */
export interface Destination {
  id: string;
  name: string;
  fuelCost: number;
  travelMs: number;
}

export const DESTINATIONS: readonly Destination[] = [
  { id: 'furlong-station', name: 'Furlong Station', fuelCost: 0, travelMs: 0 },
  { id: 'high-orbit',      name: 'High Orbit',      fuelCost: 25, travelMs: TRAVEL_MS_MIN },
  { id: 'l4-anchorage',    name: 'L4 Anchorage',    fuelCost: 50, travelMs: TRAVEL_MS_MIN + 30_000 },
];

/** Look up a destination by id; unknown ids resolve to home (plan §2, item 4). */
export function findDestination(id: string): Destination {
  const hit = DESTINATIONS.find((d) => d.id === id);
  return hit ?? DESTINATIONS[0]; // furlong-station is always DESTINATIONS[0]
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
}

/** Serializable fuel record. Capacity is DERIVED (tanks × TANK_CAPACITY) — never
 *  stored — so removing a tank silently caps the effective level on read. */
export interface FuelRecord {
  level: number;
}

// ── Wire-up (mirror bindFurnitureDoc / bindDoorsDoc / bindGamesDoc) ──────────

let boundDoc: Y.Doc | null = null;
let shipMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
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
const MAX_LOC_ID_LEN = 64;

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
  if (r.departedAt !== undefined && !(typeof r.departedAt === 'number' && Number.isFinite(r.departedAt))) return false;
  if (r.etaAt !== undefined && !(typeof r.etaAt === 'number' && Number.isFinite(r.etaAt))) return false;
  // The etaAt > departedAt invariant is enforced HERE — otherwise a peer could
  // write etaAt <= departedAt and every viewer would render "arrived instantly"
  // with no way to know the record is malformed.
  if (r.status === 'in-flight' || r.status === 'undocking') {
    if (r.destinationId === undefined) return false;
    if (r.status === 'in-flight') {
      if (r.departedAt === undefined || r.etaAt === undefined) return false;
      if (!(r.etaAt > r.departedAt)) return false;
    }
  }
  return true;
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
  return { status: 'docked', locationId: DESTINATIONS[0].id };
}

/** Strip stale fields when the status doesn't need them. Called on write and
 *  in the read-side resolver — a docked record shouldn't carry a departedAt
 *  timestamp, and rendering code shouldn't have to defensively ignore it. */
function sanitizeFlightRecord(r: FlightRecord): FlightRecord {
  const out: FlightRecord = { status: r.status, locationId: r.locationId };
  if (r.status === 'undocking' || r.status === 'in-flight') {
    if (r.destinationId !== undefined) out.destinationId = r.destinationId;
    if (r.status === 'in-flight') {
      if (r.departedAt !== undefined) out.departedAt = r.departedAt;
      if (r.etaAt !== undefined) out.etaAt = r.etaAt;
    }
  }
  return out;
}

// ── Reads (untrusted; every path degrades to defaults, never throws) ─────────

/** Raw fuel level from the doc — clamp to [0, capacity] happens in the
 *  resolveShipState() step or in the caller (owner-only REFUEL write already
 *  clamps to the CURRENT capacity — see writeFuelLevel). */
export function readFuelLevel(): number {
  if (!docAlive()) return 0;
  const raw = shipMap!.get('fuel');
  if (!isFuelRecord(raw)) return 0;
  // Negative-fuel guard belongs here too — a peer could write -Infinity and
  // every reader would fail-open otherwise. Clamp to [0, +∞) at the boundary;
  // capacity clamp is a caller responsibility (see clampFuelToCapacity).
  return Math.max(0, raw.level);
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
 *  Owner-gated at the caller (helm UI). The write is idempotent — the same
 *  level twice makes one Yjs op (Y.Map dedups equal values). */
export function writeFuelLevel(level: number, capacity: number): void {
  if (!docAlive()) return;
  const safe = clampFuelToCapacity(level, capacity);
  boundDoc!.transact(() => {
    shipMap!.set('fuel', { level: safe } as FuelRecord);
  });
}

/** Publish the flight record. Owner-gated at the caller. Validates the state
 *  machine invariants BEFORE writing — an invalid record here would still be
 *  filtered out by readFlightRecord's guard, but a rejected write is louder
 *  than a silently-reverted one. */
export function writeFlightRecord(rec: FlightRecord): void {
  if (!docAlive()) return;
  const clean = sanitizeFlightRecord(rec);
  if (!isFlightRecord(clean)) {
    console.warn('[ship] refused to write malformed flight record', rec);
    return;
  }
  boundDoc!.transact(() => {
    shipMap!.set('flight', clean);
  });
}

// ── State-machine legal transitions (pure — testable without a doc) ──────────

/** True iff `to` is a legal successor of `from` per the SH3 machine above.
 *  The predicate is CALLER-gated (owner-only, canDepart check, etc.); this
 *  answers only the state-transition question. */
export function isLegalFlightTransition(from: FlightStatus, to: FlightStatus): boolean {
  if (from === to) return true; // idempotent republish
  switch (from) {
    case 'docked':    return to === 'undocking';
    case 'undocking': return to === 'in-flight' || to === 'docked'; // depart or abort
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
}

/** Predicate the DEPART button funnels through. Returns the refusal reason so
 *  the button can render "REFUEL FIRST" / "UNPAIR THE ADAPTER TO x" etc. */
export function canDepart(ctx: DepartContext): DepartRefusal {
  if (!ctx.ownerAuthorized) return { ok: false, reason: 'no-owner' };
  if (!ctx.flightCapable) return { ok: false, reason: 'not-flight-capable' };
  if (ctx.currentStatus !== 'docked') return { ok: false, reason: 'not-docked' };
  const dest = DESTINATIONS.find((d) => d.id === ctx.destinationId);
  if (!dest) return { ok: false, reason: 'unknown-destination' };
  if (ctx.chainedDoors.length > 0) {
    return { ok: false, reason: 'chained-berth', chainedDoors: ctx.chainedDoors };
  }
  if (ctx.currentFuel < dest.fuelCost) {
    return { ok: false, reason: 'insufficient-fuel', needed: dest.fuelCost, have: ctx.currentFuel };
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
