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
import {
  DESTINATIONS,
  TANK_CAPACITY,
  bindShipDoc,
  canDepart,
  clampFuelToCapacity,
  defaultFlight,
  findDestination,
  flightArrived,
  flightProgress,
  isFlightRecord,
  isLegalFlightTransition,
  pairingAllowedByFlight,
  readFlightRecord,
  readFuelLevel,
  shipDocBound,
  subscribeShip,
  writeFlightRecord,
  writeFuelLevel,
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
    // Idempotent self-transitions always legal (an owner republish).
    for (const s of ['docked', 'undocking', 'in-flight', 'redocking'] as const) {
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
