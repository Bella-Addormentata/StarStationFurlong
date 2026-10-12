// shipDoc.ts tests: verify-on-read against hostile map contents, fuel
// accounting invariants (clamps + capacity derivation + conservation), and
// the SH3 state machine's legal-transition table. Uses real Yjs docs (same
// stack as treasuryDoc.test.ts) — no DOM, no world coupling.
//
// The tests are grouped by claim:
//   1. Binding + subscription rebinds per join, mirror bindFurnitureDoc.
//   2. Fuel accounting: write/read round trip, negative/Infinity/hostile
//      values, clamp-to-capacity, tank-removal strands overflow.
//   3. Flight state machine: legal transitions, illegal transitions
//      refused (as records — the state guard is on the CALLER's write path,
//      isLegalFlightTransition documents the table), sanitizer strips stale
//      fields on the resting states, in-flight guard `etaAt > departedAt`.
//   4. canDepart predicate: the full refusal ladder (owner, capability,
//      status, chained berths, destination, fuel).
//   5. Progress + arrival: interpolation clamps to [0, 1], eta-passed reads
//      arrived regardless of the STATUS field (clock-skew posture).

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_STATIONS, adriftAt, setStationDirectory } from './stationDirectory';
import {
  CAST_OFF_HOLD_MS,
  CAST_OFF_RENEW_MS,
  DESTINATIONS,
  TANK_CAPACITY,
  UNDOCK_HOLD_MS,
  UNDOCK_RENEW_MS,
  bindShipDoc,
  canDepart,
  castOffHeldBy,
  clampFuelToCapacity,
  defaultFlight,
  endUndockHold,
  findDestination,
  flightArrived,
  flightProgress,
  flightWritePath,
  holdCastOff,
  holdUndock,
  isFlightRecord,
  isLegalFlightTransition,
  pairingAllowedByFlight,
  readCastOffHold,
  readFlightRecord,
  readFuelLevel,
  readRestPlace,
  releaseCastOff,
  renewCastOff,
  renewUndockHold,
  shipDocBound,
  subscribeShip,
  undockHeld,
  writeFlightRecord,
  writeFuelLevel,
  writeRestPlace,
} from './shipDoc';

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** Sugar for the common resting values so tests read like the plan doc. */
const HOME = DESTINATIONS[0]; // furlong-station, cost 0
const HIGH_ORBIT = DESTINATIONS[1]; // cost 25
const L4 = DESTINATIONS[2]; // cost 50

function freshDoc(): Y.Doc {
  const doc = new Y.Doc();
  bindShipDoc(doc);
  return doc;
}

/** Hostile-write helper: bypass the write functions and shove any value in.
 *  A live peer could do exactly this; the read guards must survive it. */
function hostileSetFuel(doc: Y.Doc, value: unknown): void {
  doc.getMap('ship').set('fuel', value as any);
}
function hostileSetFlight(doc: Y.Doc, value: unknown): void {
  doc.getMap('ship').set('flight', value as any);
}

// ── 1. Binding + subscription ────────────────────────────────────────────────

describe('shipDoc binding', () => {
  beforeEach(() => {
    // Ensure each test starts from a bind-time notify (mirrors main.ts T0).
    freshDoc();
  });

  it('binds cleanly and reports docAlive', () => {
    freshDoc();
    expect(shipDocBound()).toBe(true);
  });

  it('re-notifies subscribers when a fresh doc is bound (per-join rebind)', () => {
    const first = freshDoc();
    let fires = 0;
    const off = subscribeShip(() => fires++);
    // Bind a second doc — simulate leaveRoom + joinRoom.
    bindShipDoc(new Y.Doc());
    // The bind's own notify (from the observer install) fires immediately.
    expect(fires).toBeGreaterThanOrEqual(1);
    off();
    first.destroy();
  });

  it('unsubscribe stops delivery', () => {
    const doc = freshDoc();
    let fires = 0;
    const off = subscribeShip(() => fires++);
    off();
    writeFuelLevel(50, TANK_CAPACITY);
    expect(fires).toBe(0);
    doc.destroy();
  });

  it('a throwing listener does not kill the sibling', () => {
    const doc = freshDoc();
    // Silence the expected console.error the notify() guard logs.
    const err = console.error;
    console.error = () => {};
    const offA = subscribeShip(() => { throw new Error('boom'); });
    let sib = 0;
    const offB = subscribeShip(() => sib++);
    writeFuelLevel(10, TANK_CAPACITY);
    expect(sib).toBeGreaterThan(0);
    // Clean up both listeners so subsequent tests don't inherit the throw.
    offA();
    offB();
    console.error = err;
    doc.destroy();
  });
});

// ── 2. Fuel accounting ───────────────────────────────────────────────────────

describe('shipDoc fuel', () => {
  it('empty doc reads 0', () => {
    freshDoc();
    expect(readFuelLevel()).toBe(0);
  });

  it('round-trips a written level against a single-tank capacity', () => {
    const doc = freshDoc();
    writeFuelLevel(42, TANK_CAPACITY);
    expect(readFuelLevel()).toBe(42);
    doc.destroy();
  });

  it('write clamps ABOVE capacity — the tank never overflows on the wire', () => {
    const doc = freshDoc();
    writeFuelLevel(999, TANK_CAPACITY);
    expect(readFuelLevel()).toBe(TANK_CAPACITY);
    doc.destroy();
  });

  it('write clamps BELOW zero — a negative refuel is 0, never a leak', () => {
    const doc = freshDoc();
    writeFuelLevel(-5, TANK_CAPACITY);
    expect(readFuelLevel()).toBe(0);
    doc.destroy();
  });

  it('non-finite writes collapse to 0 (never NaN/Infinity on the wire)', () => {
    const doc = freshDoc();
    writeFuelLevel(Number.POSITIVE_INFINITY, TANK_CAPACITY);
    expect(readFuelLevel()).toBe(0);
    writeFuelLevel(Number.NaN, TANK_CAPACITY);
    expect(readFuelLevel()).toBe(0);
    doc.destroy();
  });

  it('hostile fuel record — wrong shape reads as 0', () => {
    const doc = freshDoc();
    hostileSetFuel(doc, 'not an object');
    expect(readFuelLevel()).toBe(0);
    hostileSetFuel(doc, { level: 'twelve' });
    expect(readFuelLevel()).toBe(0);
    hostileSetFuel(doc, { level: Number.POSITIVE_INFINITY });
    expect(readFuelLevel()).toBe(0);
    doc.destroy();
  });

  it('hostile fuel record — negative level reads as 0 (clamp at boundary)', () => {
    const doc = freshDoc();
    hostileSetFuel(doc, { level: -1000 });
    expect(readFuelLevel()).toBe(0);
    doc.destroy();
  });

  it('clampFuelToCapacity implements the removal-strands-overflow rule', () => {
    // Filled to 200 (two tanks worth), then owner removes one tank ⇒
    // clamp caps the on-read level at 100 (plan §2, item 2).
    expect(clampFuelToCapacity(200, 100)).toBe(100);
    expect(clampFuelToCapacity(50, 100)).toBe(50);
    expect(clampFuelToCapacity(-5, 100)).toBe(0);
    expect(clampFuelToCapacity(Number.NaN, 100)).toBe(0);
    expect(clampFuelToCapacity(50, -1)).toBe(0);
  });

  it('conservation: refuel then debit equals initial + refuel - cost', () => {
    // The state-machine debit is caller-driven, so verify the accounting
    // path the DEPART flow will use: read → subtract cost → write.
    const doc = freshDoc();
    const cap = TANK_CAPACITY * 2;
    writeFuelLevel(140, cap); // start
    const start = readFuelLevel();
    const cost = HIGH_ORBIT.fuelCost;
    writeFuelLevel(start - cost, cap);
    expect(readFuelLevel()).toBe(start - cost);
    // A second hop chains the same accounting:
    const after1 = readFuelLevel();
    writeFuelLevel(after1 - HIGH_ORBIT.fuelCost, cap);
    expect(readFuelLevel()).toBe(start - 2 * cost);
    doc.destroy();
  });

  it('conservation: tank REMOVAL after a fill silently caps effective level', () => {
    // Two-tank ship filled to 180 (both tanks 90% full), player removes one tank.
    // resolveShipState-side capacity is now 100, and the doc-side raw level is
    // still 180 — clampFuelToCapacity is the enforcer.
    const doc = freshDoc();
    writeFuelLevel(180, TANK_CAPACITY * 2);
    // Even though writeFuelLevel already clamped to 200 above and then to
    // 180 here, the KEY invariant is what a reader with the new capacity sees:
    const raw = readFuelLevel();
    expect(clampFuelToCapacity(raw, TANK_CAPACITY)).toBe(TANK_CAPACITY);
    // And the raw level itself did not silently shrink (the doc still holds
    // the historical fill — only the render/capacity check clips it).
    expect(raw).toBe(180);
    doc.destroy();
  });
});

// ── 3. Flight state machine + shape guard ────────────────────────────────────

describe('shipDoc flight record', () => {
  it('empty doc resolves to defaultFlight (docked at home)', () => {
    freshDoc();
    expect(readFlightRecord()).toEqual(defaultFlight());
    expect(readFlightRecord().locationId).toBe(HOME.id);
  });

  it('round-trips a docked record', () => {
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: HOME.id });
    doc.destroy();
  });

  it('sanitizer strips stale destinationId/timestamps from a docked record', () => {
    const doc = freshDoc();
    writeFlightRecord({
      status: 'docked',
      locationId: HOME.id,
      destinationId: L4.id,     // stale — should vanish
      departedAt: 1_000,          // stale — should vanish
      etaAt: 2_000,               // stale — should vanish
    } as any);
    const back = readFlightRecord();
    expect(back).toEqual({ status: 'docked', locationId: HOME.id });
    expect(back.destinationId).toBeUndefined();
    expect(back.departedAt).toBeUndefined();
    expect(back.etaAt).toBeUndefined();
    doc.destroy();
  });

  it('sanitizer strips departedAt/etaAt from an undocking hand-off', () => {
    // undocking is destination-chosen but not-yet-in-transit; timestamps
    // are irrelevant until DEPART advances to in-flight.
    const doc = freshDoc();
    writeFlightRecord({
      status: 'undocking',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 2_000,
    } as any);
    const back = readFlightRecord();
    expect(back.status).toBe('undocking');
    expect(back.destinationId).toBe(HIGH_ORBIT.id);
    expect(back.departedAt).toBeUndefined();
    expect(back.etaAt).toBeUndefined();
    doc.destroy();
  });

  it('accepts a full in-flight record and preserves the timing fields', () => {
    const doc = freshDoc();
    const rec = {
      status: 'in-flight' as const,
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000_000,
      etaAt: 1_060_000,
    };
    writeFlightRecord(rec);
    expect(readFlightRecord()).toEqual(rec);
    doc.destroy();
  });

  it('rejects an in-flight record with etaAt <= departedAt (on read)', () => {
    const doc = freshDoc();
    hostileSetFlight(doc, {
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 2_000,
      etaAt: 2_000, // equal — instant arrival exploit
    });
    // Guard: reads as the default (docked at home).
    expect(readFlightRecord()).toEqual(defaultFlight());
    doc.destroy();
  });

  it('refuses to write a malformed record (defence in depth)', () => {
    const doc = freshDoc();
    // Missing required fields for in-flight: should NOT land on the wire.
    writeFlightRecord({ status: 'in-flight', locationId: HOME.id } as any);
    expect(readFlightRecord()).toEqual(defaultFlight());
    doc.destroy();
  });

  it('shape guard rejects each hostile shape', () => {
    expect(isFlightRecord(null)).toBe(false);
    expect(isFlightRecord('docked')).toBe(false);
    expect(isFlightRecord({ status: 'landed', locationId: HOME.id })).toBe(false);
    expect(isFlightRecord({ status: 'docked' })).toBe(false);
    expect(isFlightRecord({ status: 'in-flight', locationId: HOME.id })).toBe(false);
    expect(isFlightRecord({
      status: 'in-flight', locationId: HOME.id,
      destinationId: HIGH_ORBIT.id, departedAt: 1_000, etaAt: 500,
    })).toBe(false);
    // A bounded but non-empty destination id passes; empty fails.
    expect(isFlightRecord({ status: 'undocking', locationId: HOME.id, destinationId: '' })).toBe(false);
    // Well-formed cases:
    expect(isFlightRecord({ status: 'docked', locationId: HOME.id })).toBe(true);
    expect(isFlightRecord({ status: 'undocking', locationId: HOME.id, destinationId: L4.id })).toBe(true);
  });

  it('legal transition table matches the SH3 diagram (fast + slow DEPART paths)', () => {
    // docked → undocking (slow-path DEPART, reserved for a future preflight
    // slice) OR in-flight (SH3 FAST-path DEPART, shipped) — both legalized so
    // the writer may pick per-slice. See shipDoc.ts header + state-machine
    // switch comments for the rationale.
    expect(isLegalFlightTransition('docked', 'undocking')).toBe(true);
    expect(isLegalFlightTransition('docked', 'in-flight')).toBe(true);
    expect(isLegalFlightTransition('docked', 'redocking')).toBe(false);
    // undocking → in-flight or docked (abort)
    expect(isLegalFlightTransition('undocking', 'in-flight')).toBe(true);
    expect(isLegalFlightTransition('undocking', 'docked')).toBe(true);
    expect(isLegalFlightTransition('undocking', 'redocking')).toBe(false);
    // in-flight → redocking (only)
    expect(isLegalFlightTransition('in-flight', 'redocking')).toBe(true);
    expect(isLegalFlightTransition('in-flight', 'docked')).toBe(false);
    expect(isLegalFlightTransition('in-flight', 'undocking')).toBe(false);
    // redocking → docked (or bounced back)
    expect(isLegalFlightTransition('redocking', 'docked')).toBe(true);
    expect(isLegalFlightTransition('redocking', 'in-flight')).toBe(true);
    expect(isLegalFlightTransition('redocking', 'undocking')).toBe(false);
    // 🕹️ Flown by hand (issue 203): in from docked, out only through
    // redocking (AUTO-DOCK).
    expect(isLegalFlightTransition('docked', 'free-flight')).toBe(true);
    expect(isLegalFlightTransition('free-flight', 'redocking')).toBe(true);
    expect(isLegalFlightTransition('free-flight', 'docked')).toBe(false);
    expect(isLegalFlightTransition('free-flight', 'in-flight')).toBe(false);
    expect(isLegalFlightTransition('in-flight', 'free-flight')).toBe(false);
    expect(isLegalFlightTransition('redocking', 'free-flight')).toBe(false);
    // Idempotent self-transitions always legal (an owner republish).
    for (const s of ['docked', 'undocking', 'in-flight', 'redocking', 'free-flight'] as const) {
      expect(isLegalFlightTransition(s, s)).toBe(true);
    }
  });

  it('writeFlightRecord refuses ILLEGAL transitions against the current record', () => {
    // Regression for the audit MINOR: previously, writeFlightRecord did NOT
    // check transition legality. It now reads the current record and refuses
    // any advance the state machine rejects.
    const doc = freshDoc();
    // Seed the doc with an in-flight record (any seed is legal on a fresh doc).
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    // Silence the expected warn so the test output stays clean.
    const originalWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    // in-flight → docked is not a legal edge; the write must be rejected AND
    // the doc must still hold the in-flight record.
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    console.warn = originalWarn;
    expect(warned).toBeGreaterThan(0);
    expect(readFlightRecord()).toEqual({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    doc.destroy();
  });

  it('writeFlightRecord accepts the SH3 fast-path DEPART (docked → in-flight)', () => {
    // The SH3 DEPART flow (devices.ts createHelmUI) writes 'in-flight' directly
    // from a 'docked' record — the state machine legalizes this fast path.
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    expect(readFlightRecord().status).toBe('in-flight');
    doc.destroy();
  });

  it('writeFlightRecord accepts the reserved slow-path (docked → undocking → in-flight)', () => {
    // Belt-and-braces for the reserved slow path: 'undocking' has no live
    // producer in the shipped SH3 code, but the state machine legalizes both
    // its successor state and its abort back to 'docked'. A future preflight-
    // animation slice can walk this path without touching the state room.
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    writeFlightRecord({
      status: 'undocking',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
    });
    expect(readFlightRecord().status).toBe('undocking');
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    expect(readFlightRecord().status).toBe('in-flight');
    doc.destroy();
  });

  it('writeFlightRecord accepts REDOCK completion (redocking → docked)', () => {
    // Regression for the shipped REDOCK button: seed redocking, advance to
    // docked, confirm it lands. Also proves the redocking-side auto-advance
    // sequence (in-flight → redocking → docked) works end-to-end under the
    // new writer-side gate.
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    writeFlightRecord({ status: 'redocking', locationId: HIGH_ORBIT.id });
    writeFlightRecord({ status: 'docked', locationId: HIGH_ORBIT.id });
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: HIGH_ORBIT.id });
    doc.destroy();
  });

  it('writeFlightRecord treats a hostile current record as absent (heal, not stall)', () => {
    // If a peer wrote junk to the map, the transition check would have no
    // legal `from` state — the ship must be able to HEAL back to a well-formed
    // state, not be permanently stalled. Verify by seeding junk, then writing
    // a legal seed on top.
    const doc = freshDoc();
    hostileSetFlight(doc, { status: 'landed', locationId: HOME.id }); // shape-invalid
    // Silence the shape guard on read (readFlightRecord defaults to home);
    // the write path must accept a fresh seed even though the raw entry is
    // present-but-invalid.
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    expect(readFlightRecord().status).toBe('in-flight');
    doc.destroy();
  });

  it('writeFlightRecord accepts idempotent self-republish under contention', () => {
    // The autoAdvance tick in devices.ts (in-flight → redocking) can fire on
    // two commander helms simultaneously. The second writer sees the first's
    // 'redocking' already published and its own 'redocking → redocking' write
    // must land as a no-op republish, NOT be rejected.
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    writeFlightRecord({ status: 'redocking', locationId: HIGH_ORBIT.id });
    // Second commander races; second write is a self-republish.
    writeFlightRecord({ status: 'redocking', locationId: HIGH_ORBIT.id });
    expect(readFlightRecord()).toEqual({ status: 'redocking', locationId: HIGH_ORBIT.id });
    doc.destroy();
  });
});

// ── 4. canDepart predicate — the full refusal ladder ────────────────────────

describe('shipDoc canDepart', () => {
  const base = {
    flightCapable: true,
    currentStatus: 'docked' as const,
    currentFuel: 100,
    destinationId: HIGH_ORBIT.id,
    chainedDoors: [] as readonly string[],
    ownerAuthorized: true,
  };

  it('accepts a well-formed docked ship with fuel + no chains', () => {
    expect(canDepart(base)).toEqual({ ok: true });
  });

  it('refuses non-owners', () => {
    expect(canDepart({ ...base, ownerAuthorized: false })).toEqual({
      ok: false, reason: 'no-owner',
    });
  });

  it('refuses unless flight-capable (missing tank/engine/helm)', () => {
    expect(canDepart({ ...base, flightCapable: false })).toEqual({
      ok: false, reason: 'not-flight-capable',
    });
  });

  it('refuses unless currently docked (a ship in-flight cannot depart again)', () => {
    for (const s of ['undocking', 'in-flight', 'redocking'] as const) {
      expect(canDepart({ ...base, currentStatus: s })).toEqual({
        ok: false, reason: 'not-docked',
      });
    }
  });

  it('refuses an unknown destination id', () => {
    expect(canDepart({ ...base, destinationId: 'nowhere' })).toEqual({
      ok: false, reason: 'unknown-destination',
    });
  });

  it('refuses when a permanent connector chain is attached (chained-berth)', () => {
    const refused = canDepart({ ...base, chainedDoors: ['north', 'd:port42'] });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('should refuse');
    expect(refused.reason).toBe('chained-berth');
    if (refused.reason === 'chained-berth') {
      expect(refused.chainedDoors).toEqual(['north', 'd:port42']);
    }
  });

  it('refuses when fuel is short — reports needed + have', () => {
    const refused = canDepart({ ...base, currentFuel: 10, destinationId: HIGH_ORBIT.id });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('should refuse');
    expect(refused.reason).toBe('insufficient-fuel');
    if (refused.reason === 'insufficient-fuel') {
      expect(refused.needed).toBe(HIGH_ORBIT.fuelCost);
      expect(refused.have).toBe(10);
    }
  });

  it('honors HOME as a zero-cost destination (rare but legal)', () => {
    // A round-trip DEPART TO HOME lets a stuck ship "arrive" without fuel —
    // useful for the abort UX. Empty tank is fine because cost is 0.
    expect(canDepart({ ...base, currentFuel: 0, destinationId: HOME.id })).toEqual({ ok: true });
  });
});

// ── 4b. pairingAllowedByFlight — the shared pairing-completion gate ─────────
//
// PR #134 audit MAJOR regression: the outbound INITIATE handler in docking.ts
// gated on flight state, but the ACCEPT handler (and the auto-accept branch of
// INITIATE, and any future pairing-completion caller) called
// completePairing(accept=true) WITHOUT checking, so a request that went
// PENDING while the module was docked could still complete after a DEPART.
//
// The remediation moved the gate onto a pure predicate and into the shared
// completePairing seam. These tests pin the predicate down so any regression
// to the seam surfaces as a red test, and any future flight-status addition
// forces a decision here rather than sneaking through as "docked or else".

describe('shipDoc pairingAllowedByFlight', () => {
  it('allows pairing completion while docked (the only accept status)', () => {
    expect(pairingAllowedByFlight({ status: 'docked', locationId: HOME.id })).toEqual({ ok: true });
  });

  it('refuses pairing completion in every non-docked status (undocking/in-flight/redocking)', () => {
    // Undocking (slow-path DEPART hand-off, reserved for a later slice) still
    // refuses: it means a DEPART is imminent and latching a new berth on now
    // would be visible on the wire for zero benefit.
    expect(pairingAllowedByFlight({
      status: 'undocking', locationId: HOME.id, destinationId: HIGH_ORBIT.id,
    })).toEqual({ ok: false, reason: 'flight', status: 'undocking' });
    // In-flight is the load-bearing case the MAJOR flagged: an already-pending
    // ACCEPT click after DEPART would latch a station door onto a target that
    // has moved out from under it.
    expect(pairingAllowedByFlight({
      status: 'in-flight', locationId: HOME.id, destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    })).toEqual({ ok: false, reason: 'flight', status: 'in-flight' });
    // Redocking is a brief arrival hand-off; the transient-berth contract
    // (#67 D2, shipped) covers the physical re-attach, so a fresh accept
    // through completePairing is refused here too.
    expect(pairingAllowedByFlight({
      status: 'redocking', locationId: HIGH_ORBIT.id,
    })).toEqual({ ok: false, reason: 'flight', status: 'redocking' });
  });

  it('carries the exact refusing status back to the caller (drives the alert copy)', () => {
    // The docking.ts alert reads `${refusal.status.toUpperCase()}` — a peer
    // debugging the modal expects to see "IN-FLIGHT" verbatim, not a generic
    // "not docked". Pin the exact wire.
    const refused = pairingAllowedByFlight({
      status: 'in-flight', locationId: HOME.id, destinationId: L4.id,
      departedAt: 1_000, etaAt: 90_000,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('should refuse');
    expect(refused.status).toBe('in-flight');
    expect(refused.reason).toBe('flight');
  });

  it('reads the live doc through readFlightRecord (end-to-end wire test)', () => {
    // The completePairing gate calls `pairingAllowedByFlight(readFlightRecord())`.
    // Exercise that composition on real Yjs state so a future refactor that
    // breaks either half breaks this test.
    const doc = freshDoc();
    // A fresh (empty) doc reads as docked → accepts.
    expect(pairingAllowedByFlight(readFlightRecord())).toEqual({ ok: true });
    // Seed docked (explicit) → still accepts.
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    expect(pairingAllowedByFlight(readFlightRecord())).toEqual({ ok: true });
    // DEPART → refuses.
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 61_000,
    });
    const inflight = pairingAllowedByFlight(readFlightRecord());
    expect(inflight.ok).toBe(false);
    if (inflight.ok) throw new Error('should refuse');
    expect(inflight.status).toBe('in-flight');
    // A hostile / shape-invalid record falls back to the docked default on
    // read → the gate accepts. This matches the "unopened room doc IS today's
    // module" ruling: a corrupt map entry must not permanently lock every
    // future accept out.
    hostileSetFlight(doc, { status: 'orbiting', locationId: 'nowhere' });
    expect(pairingAllowedByFlight(readFlightRecord())).toEqual({ ok: true });
    doc.destroy();
  });
});

// ── 5. Progress + arrival (clock-skew posture) ──────────────────────────────

describe('shipDoc flight progress', () => {
  it('flightProgress is 0 outside in-flight', () => {
    expect(flightProgress({ status: 'docked', locationId: HOME.id }, 1_000)).toBe(0);
    expect(flightProgress({
      status: 'undocking', locationId: HOME.id, destinationId: HIGH_ORBIT.id,
    }, 1_000)).toBe(0);
    // redocking is a fully-arrived hand-off; caller reads it as 1.
    expect(flightProgress({ status: 'redocking', locationId: HIGH_ORBIT.id }, 1_000)).toBe(1);
  });

  it('interpolates linearly between departedAt and etaAt', () => {
    const rec = {
      status: 'in-flight' as const,
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 2_000,
    };
    expect(flightProgress(rec, 1_000)).toBe(0);
    expect(flightProgress(rec, 1_500)).toBeCloseTo(0.5);
    expect(flightProgress(rec, 2_000)).toBe(1);
  });

  it('clamps to [0, 1] on clock skew', () => {
    const rec = {
      status: 'in-flight' as const,
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 2_000,
    };
    expect(flightProgress(rec, 500)).toBe(0);
    expect(flightProgress(rec, 5_000)).toBe(1);
  });

  it('arrived after etaAt regardless of status field (clock-skew posture)', () => {
    const rec = {
      status: 'in-flight' as const,
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 1_000, etaAt: 2_000,
    };
    expect(flightArrived(rec, 1_500)).toBe(false);
    expect(flightArrived(rec, 2_500)).toBe(true);
    expect(flightArrived({ status: 'redocking', locationId: HIGH_ORBIT.id }, 0)).toBe(true);
    expect(flightArrived({ status: 'docked', locationId: HOME.id }, 5_000)).toBe(false);
  });

  it('unknown destination id falls back to home (never throws)', () => {
    expect(findDestination('nowhere')).toEqual(HOME);
  });
});

// ── 6. Cross-doc convergence (Yjs sync of the ship map) ──────────────────────

describe('shipDoc convergence', () => {
  it('two peers converge on the same fuel + flight after a sync', () => {
    // Peer A binds and writes a full in-flight record; peer B binds a second
    // doc, receives A's update via a straight state-vector exchange, and reads
    // the same record back. This exercises the same wire path the T0 seam
    // uses at room join (bindShipDoc rebinds per join).
    const docA = new Y.Doc();
    bindShipDoc(docA);
    writeFuelLevel(80, TANK_CAPACITY);
    writeFlightRecord({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 100, etaAt: 60_100,
    });
    const stateA = Y.encodeStateAsUpdate(docA);

    const docB = new Y.Doc();
    Y.applyUpdate(docB, stateA);
    bindShipDoc(docB);
    expect(readFuelLevel()).toBe(80);
    expect(readFlightRecord()).toEqual({
      status: 'in-flight',
      locationId: HOME.id,
      destinationId: HIGH_ORBIT.id,
      departedAt: 100, etaAt: 60_100,
    });

    docA.destroy();
    docB.destroy();
  });
});

// ── #30 SH3: destinations are other stations around the same planet ─────────

describe('canDepart — where the ship is', () => {
  const base = {
    flightCapable: true,
    currentStatus: 'docked' as const,
    currentFuel: 100,
    chainedDoors: [] as string[],
    ownerAuthorized: true,
  };

  it('refuses a hop to the station the ship is already at', () => {
    expect(canDepart({ ...base, destinationId: HOME.id, locationId: HOME.id }))
      .toEqual({ ok: false, reason: 'already-here' });
  });

  it('allows a hop to another station around the same planet', () => {
    expect(canDepart({ ...base, destinationId: HIGH_ORBIT.id, locationId: HOME.id })).toEqual({ ok: true });
  });

  it('says the ship\'s own station is unlisted rather than blaming the orbit', () => {
    expect(canDepart({ ...base, destinationId: HIGH_ORBIT.id, locationId: 'station:unmapped', hop: null }))
      .toEqual({ ok: false, reason: 'unlisted-location' });
  });

  it('refuses a station the directory does not list', () => {
    expect(canDepart({ ...base, destinationId: 'nowhere', locationId: HOME.id }))
      .toEqual({ ok: false, reason: 'unknown-destination' });
  });
});

describe('writeFlightRecord — station ids and the result DEPART checks', () => {
  beforeEach(() => { freshDoc(); });

  it('accepts a station id as long as stations.ts allows (128)', () => {
    const id = 's'.repeat(128);
    const now = 1000;
    expect(writeFlightRecord({ status: 'in-flight', locationId: HOME.id, destinationId: id, departedAt: now, etaAt: now + 1 })).toBe(true);
    expect(readFlightRecord().destinationId).toBe(id);
  });

  it('reports a refused write so DEPART can stop before casting off', () => {
    expect(writeFlightRecord({ status: 'in-flight', locationId: HOME.id, destinationId: 's'.repeat(129), departedAt: 1, etaAt: 2 })).toBe(false);
    expect(readFlightRecord().status).toBe('docked');
  });
});

describe('canDepart — a planned hop', () => {
  const base = {
    flightCapable: true,
    currentStatus: 'docked' as const,
    currentFuel: 30,
    chainedDoors: [] as string[],
    ownerAuthorized: true,
    locationId: HOME.id,
    destinationId: HIGH_ORBIT.id,
  };

  it("prices on the hop's fuel, not the destination's flat cost", () => {
    expect(canDepart({ ...base, hop: { fuelCost: 31 } }))
      .toEqual({ ok: false, reason: 'insufficient-fuel', needed: 31, have: 30 });
    expect(canDepart({ ...base, currentFuel: 5, hop: { fuelCost: 5 } })).toEqual({ ok: true });
  });

  it('refuses when no transfer exists', () => {
    expect(canDepart({ ...base, hop: null })).toEqual({ ok: false, reason: 'no-transfer' });
  });
});

describe('flight records written on another install', () => {
  it('read their station ids as this install\'s', () => {
    const aliases: Record<string, string> = { 'station:room-high': 'high-orbit', 'their-l4': 'l4-anchorage' };
    setStationDirectory({ stations: () => DEFAULT_STATIONS, resolve: (id) => aliases[id] ?? null });
    try {
      const doc = freshDoc();
      hostileSetFlight(doc, { status: 'in-flight', locationId: 'station:room-high', destinationId: 'their-l4', departedAt: 1, etaAt: 2 });
      expect(readFlightRecord()).toMatchObject({ locationId: 'high-orbit', destinationId: 'l4-anchorage' });
    } finally {
      setStationDirectory(null);
    }
  });

  it('are written with each station\'s portable id, and read back as this install\'s', () => {
    const rooms: Record<string, string> = { 'high-orbit': 'room-high', 'l4-anchorage': 'room-l4' };
    const back: Record<string, string> = { 'shared:room-high': 'high-orbit', 'shared:room-l4': 'l4-anchorage' };
    setStationDirectory({
      stations: () => DEFAULT_STATIONS,
      resolve: (id) => back[id] ?? null,
      portable: (id) => (rooms[id] ? `shared:${rooms[id]}` : null),
    });
    try {
      const doc = freshDoc();
      expect(writeFlightRecord({ status: 'in-flight', locationId: 'high-orbit', destinationId: 'l4-anchorage', departedAt: 1, etaAt: 2 })).toBe(true);
      expect(doc.getMap('ship').get('flight')).toMatchObject({ locationId: 'shared:room-high', destinationId: 'shared:room-l4' });
      expect(readFlightRecord()).toMatchObject({ locationId: 'high-orbit', destinationId: 'l4-anchorage' });
    } finally {
      setStationDirectory(null);
    }
  });
});

describe('rest records written on another install', () => {
  it('name the station the ship rests beside by its portable id, read back as this install\'s', () => {
    const rooms: Record<string, string> = { 'high-orbit': 'room-high', 'furlong-station': 'r'.repeat(130) };
    const back: Record<string, string> = { 'shared:room-high': 'high-orbit' };
    setStationDirectory({
      stations: () => DEFAULT_STATIONS,
      resolve: (id) => back[id] ?? null,
      portable: (id) => (rooms[id] ? `shared:${rooms[id]}` : null),
    });
    try {
      const doc = freshDoc();
      const at = adriftAt('planet-aris', 2);
      expect(writeRestPlace({ at, since: 5, from: 'high-orbit' })).toBe(true);
      expect(doc.getMap('ship').get('rest')).toEqual({ at, since: 5, from: 'shared:room-high' });
      expect(readRestPlace()).toEqual({ at, since: 5, from: 'high-orbit' });
      // No portable id, or one too long for the wire: the id as it is.
      expect(writeRestPlace({ at, since: 6, from: 'l4-anchorage' })).toBe(true);
      expect(doc.getMap('ship').get('rest')).toEqual({ at, since: 6, from: 'l4-anchorage' });
      expect(writeRestPlace({ at, since: 7, from: 'furlong-station' })).toBe(true);
      expect(doc.getMap('ship').get('rest')).toEqual({ at, since: 7, from: 'furlong-station' });
      expect(readRestPlace()).toEqual({ at, since: 7, from: 'furlong-station' });
    } finally {
      setStationDirectory(null);
    }
  });
});

describe('flight times a peer wrote', () => {
  it('refuses unsafe, far-future or endless flights', () => {
    const now = Date.now();
    const rec = { status: 'in-flight', locationId: 'furlong-station', destinationId: 'high-orbit' };
    expect(isFlightRecord({ ...rec, departedAt: now, etaAt: now + 60_000 })).toBe(true);
    expect(isFlightRecord({ ...rec, departedAt: 1, etaAt: Number.MAX_VALUE })).toBe(false);
    expect(isFlightRecord({ ...rec, departedAt: now, etaAt: now + 3 * 24 * 3600 * 1000 })).toBe(false);
    expect(isFlightRecord({ ...rec, departedAt: 0.5, etaAt: 2 })).toBe(false);
  });
});

// ── 🚏 Ferry routes (build notes A4) ─────────────────────────────────────────

describe('canDepart — a running ferry route', () => {
  const base = {
    flightCapable: true,
    currentStatus: 'docked' as const,
    currentFuel: 100,
    destinationId: HIGH_ORBIT.id,
    chainedDoors: [] as readonly string[],
    ownerAuthorized: true,
  };

  it('refuses a hand DEPART while the timetable flies the ship, after the owner and fittings checks', () => {
    expect(canDepart({ ...base, routeRunning: true })).toEqual({ ok: false, reason: 'route-running' });
    expect(canDepart({ ...base, routeRunning: true, currentStatus: 'in-flight' })).toEqual({ ok: false, reason: 'route-running' });
    expect(canDepart({ ...base, routeRunning: true, ownerAuthorized: false })).toEqual({ ok: false, reason: 'no-owner' });
    expect(canDepart({ ...base, routeRunning: false })).toEqual({ ok: true });
  });
});

describe('flightWritePath — copying a derived flight back along legal edges', () => {
  const docked = { status: 'docked' as const, locationId: HIGH_ORBIT.id };
  const inFlight = { status: 'in-flight' as const, locationId: HOME.id, destinationId: HIGH_ORBIT.id, departedAt: 1_000, etaAt: 56_000 };

  it('one record when the edge is legal, or nothing is stored', () => {
    expect(flightWritePath(null, docked)).toEqual([docked]);
    expect(flightWritePath({ status: 'docked', locationId: HOME.id }, docked)).toEqual([docked]);
    expect(flightWritePath({ status: 'redocking', locationId: HIGH_ORBIT.id }, docked)).toEqual([docked]);
    expect(flightWritePath({ status: 'undocking', locationId: HOME.id, destinationId: L4.id }, docked)).toEqual([docked]);
    expect(flightWritePath({ status: 'docked', locationId: HOME.id }, inFlight)).toEqual([inFlight]);
  });

  it('🕹️ free flight reaches docked through redocking', () => {
    const free = { status: 'free-flight' as const, locationId: HOME.id };
    expect(flightWritePath(free, docked)).toEqual([{ status: 'redocking', locationId: HIGH_ORBIT.id }, docked]);
    expect(isFlightRecord(free)).toBe(true);
    // Free flight names no destination and keeps no flight times.
    const doc = freshDoc();
    writeFlightRecord({ status: 'docked', locationId: HOME.id });
    expect(writeFlightRecord({ ...free, destinationId: L4.id, departedAt: 1_000, etaAt: 2_000 })).toBe(true);
    expect(readFlightRecord()).toEqual(free);
    expect(pairingAllowedByFlight(readFlightRecord()).ok).toBe(false);
    doc.destroy();
  });

  it('in-flight reaches docked only through redocking, arrived where the target is', () => {
    expect(flightWritePath(inFlight, docked)).toEqual([
      { status: 'redocking', locationId: HIGH_ORBIT.id, etaAt: 56_000 },
      docked,
    ]);
    const undocking = { status: 'undocking' as const, locationId: HIGH_ORBIT.id, destinationId: L4.id };
    expect(flightWritePath(inFlight, undocking).map((r) => r.status)).toEqual(['redocking', 'docked', 'undocking']);
  });

  it('no path that would need an in-flight record the target does not carry', () => {
    expect(flightWritePath({ status: 'docked', locationId: HOME.id }, { status: 'redocking', locationId: HIGH_ORBIT.id })).toEqual([]);
  });

  it('every path writes through writeFlightRecord\'s transition gate, from every stored status', () => {
    const stored = [
      { status: 'docked' as const, locationId: HOME.id },
      { status: 'undocking' as const, locationId: HOME.id, destinationId: L4.id },
      inFlight,
      { status: 'redocking' as const, locationId: HIGH_ORBIT.id, etaAt: 56_000 },
    ];
    for (const from of stored) {
      const doc = freshDoc();
      hostileSetFlight(doc, from);
      const path = flightWritePath(readFlightRecord(), docked);
      expect(path.length).toBeGreaterThan(0);
      doc.transact(() => {
        for (const rec of path) expect(writeFlightRecord(rec)).toBe(true);
      });
      expect(readFlightRecord()).toEqual(docked);
    }
  });
});

describe('a DEPART under way — the shared cast-off hold', () => {
  const NOW = 1_000_000;

  it('holds DEPART for every helm but the one that took it, until that one ends it', () => {
    freshDoc();
    expect(readCastOffHold(NOW)).toBeNull();
    expect(holdCastOff('a', NOW)).toBe(true);
    expect(readCastOffHold(NOW + 1)).toEqual({ by: 'a', at: NOW });
    // Another helm cannot take it, and its end leaves this one alone.
    expect(holdCastOff('b', NOW + 1)).toBe(false);
    releaseCastOff('b');
    expect(castOffHeldBy('a', NOW + 1)).toBe(true);
    expect(castOffHeldBy('b', NOW + 1)).toBe(false);
    releaseCastOff('a');
    expect(readCastOffHold(NOW + 2)).toBeNull();
    expect(holdCastOff('b', NOW + 2)).toBe(true);
  });

  it('runs out CAST_OFF_HOLD_MS after it was taken, and no peer stamps one that lasts longer', () => {
    const doc = freshDoc();
    expect(holdCastOff('a', NOW)).toBe(true);
    expect(castOffHeldBy('a', NOW + CAST_OFF_HOLD_MS - 1)).toBe(true);
    expect(readCastOffHold(NOW + CAST_OFF_HOLD_MS)).toBeNull();
    expect(holdCastOff('b', NOW + CAST_OFF_HOLD_MS)).toBe(true);
    // Its own end leaves the hold taken since alone.
    releaseCastOff('a');
    expect(castOffHeldBy('b', NOW + CAST_OFF_HOLD_MS)).toBe(true);
    // Stamped further ahead than a hold lasts (a skewed clock, a hostile
    // peer): none.
    doc.getMap('ship').set('castOff', { by: 'x', at: NOW + 2 * CAST_OFF_HOLD_MS });
    expect(readCastOffHold(NOW)).toBeNull();
    for (const junk of [null, 'a', { by: '', at: NOW }, { by: 'x'.repeat(200), at: NOW }, { by: 'x', at: Number.NaN }]) {
      doc.getMap('ship').set('castOff', junk as any);
      expect(readCastOffHold(NOW)).toBeNull();
    }
  });

  it('of two helms taking it at once, keeps one on both: only that DEPART still holds it', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    bindShipDoc(docA);
    expect(holdCastOff('a', NOW)).toBe(true);
    bindShipDoc(docB);
    expect(holdCastOff('b', NOW)).toBe(true);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const kept = readCastOffHold(NOW + 1)?.by;
    expect(['a', 'b']).toContain(kept);
    bindShipDoc(docA);
    expect(readCastOffHold(NOW + 1)?.by).toBe(kept);
    expect(castOffHeldBy(kept === 'a' ? 'b' : 'a', NOW + 1)).toBe(false);
    docA.destroy();
    docB.destroy();
  });

  it('stays in force while its DEPART renews it, and only the hold that DEPART still has', () => {
    freshDoc();
    expect(CAST_OFF_RENEW_MS).toBeLessThan(CAST_OFF_HOLD_MS);
    expect(holdCastOff('a', NOW)).toBe(true);
    // Renewed on its beat, it outlasts CAST_OFF_HOLD_MS from when it was taken.
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      t += CAST_OFF_RENEW_MS;
      expect(renewCastOff('a', t)).toBe(true);
    }
    expect(t).toBeGreaterThan(NOW + CAST_OFF_HOLD_MS);
    expect(castOffHeldBy('a', t + CAST_OFF_HOLD_MS - 1)).toBe(true);
    // Another helm's renewal takes nothing.
    expect(renewCastOff('b', t)).toBe(false);
    expect(castOffHeldBy('a', t)).toBe(true);
    // One that ran out is not taken back, nor one ended.
    expect(renewCastOff('a', t + CAST_OFF_HOLD_MS)).toBe(false);
    expect(readCastOffHold(t + CAST_OFF_HOLD_MS)).toBeNull();
    expect(holdCastOff('a', t + CAST_OFF_HOLD_MS)).toBe(true);
    releaseCastOff('a');
    expect(renewCastOff('a', t + CAST_OFF_HOLD_MS + 1)).toBe(false);
    expect(readCastOffHold(t + CAST_OFF_HOLD_MS + 1)).toBeNull();
  });
});

describe('an UNDOCK under way — the shared hold on its release', () => {
  const NOW = 1_000_000;

  it('holds the release it names until that UNDOCK has its answer, or runs out', () => {
    const doc = freshDoc();
    expect(undockHeld('east', NOW, NOW)).toBe(false);
    expect(holdUndock('east', NOW, NOW)).toBe(true);
    expect(undockHeld('east', NOW, NOW + 1)).toBe(true);
    // Only that release, on that door.
    expect(undockHeld('east', NOW - 1, NOW + 1)).toBe(false);
    expect(undockHeld('west', NOW, NOW + 1)).toBe(false);
    // Another release's end leaves it alone; its own ends it.
    endUndockHold('east', NOW - 1);
    expect(undockHeld('east', NOW, NOW + 1)).toBe(true);
    endUndockHold('east', NOW);
    expect(undockHeld('east', NOW, NOW + 1)).toBe(false);
    // Not renewed, it runs out UNDOCK_HOLD_MS after it was taken.
    expect(holdUndock('east', NOW, NOW)).toBe(true);
    expect(undockHeld('east', NOW, NOW + UNDOCK_HOLD_MS - 1)).toBe(true);
    expect(undockHeld('east', NOW, NOW + UNDOCK_HOLD_MS)).toBe(false);
    // Stamped further ahead than a hold lasts, or junk: none.
    doc.getMap('ship').set('undock:east', { undockedAt: NOW, at: NOW + 2 * UNDOCK_HOLD_MS });
    expect(undockHeld('east', NOW, NOW)).toBe(false);
    for (const junk of [null, 'a', { undockedAt: NOW }, { undockedAt: 'x', at: NOW }, { undockedAt: NOW, at: Number.NaN }]) {
      doc.getMap('ship').set('undock:east', junk as any);
      expect(undockHeld('east', NOW, NOW)).toBe(false);
    }
  });

  it('stays in force while its UNDOCK renews it, and only a hold still in force', () => {
    freshDoc();
    expect(UNDOCK_RENEW_MS).toBeLessThan(UNDOCK_HOLD_MS);
    expect(holdUndock('east', NOW, NOW)).toBe(true);
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      t += UNDOCK_RENEW_MS;
      expect(renewUndockHold('east', NOW, t)).toBe(true);
    }
    expect(t).toBeGreaterThan(NOW + UNDOCK_HOLD_MS);
    expect(undockHeld('east', NOW, t + UNDOCK_HOLD_MS - 1)).toBe(true);
    // Another release's renewal takes nothing; one that ran out stays out.
    expect(renewUndockHold('east', NOW + 1, t)).toBe(false);
    expect(renewUndockHold('east', NOW, t + UNDOCK_HOLD_MS)).toBe(false);
    expect(undockHeld('east', NOW, t + UNDOCK_HOLD_MS)).toBe(false);
    // Nor does another room's doc take one up.
    freshDoc();
    expect(renewUndockHold('east', NOW, t)).toBe(false);
    expect(undockHeld('east', NOW, t)).toBe(false);
  });
});
