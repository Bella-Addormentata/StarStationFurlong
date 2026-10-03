/**
 * 🚏🤖⚓ Gate keeper — a station docks a scheduled ferry with nobody aboard
 * (robot pilot routes, open choice 8): which of the room's records names the
 * ferry, which auto-dock gates it may dock at, when the station looks closer,
 * the ferry's own view and what each of its keeper's steps means at a gate,
 * how the gate follows the ferry, the two-ended dock and cast-off over real
 * docs (claims, joins, refusals, take-backs) — and the loop over a stand-in
 * session: a whole call (dock on arrival, cast off at the departure), a stay
 * found docked late, a far write that never landed, a claim never taken (the
 * route running, paused or finished), a checkpoint, a cast-off or a dock never
 * acknowledged (a checkpoint told to every stop), a gate another game wrote
 * over while a dock was asked, a gate's port taken off while a cast-off
 * waits, a gate where the ferry would overlap another module, a finish this
 * board missed, a dock locked while its claim settled, and a ferry that stops
 * calling here by its port.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { dockChain } from './adapter';
import type { BoardDock } from './departuresBoard';
import { departureRouteNewer, type DepartureFerry, type DeparturesPublish } from './departuresDoc';
import type { NearEnd } from './dockRules';
import {
  buildDoorPairing,
  buildDoorTombstone,
  readAllDoorsFrom,
  readDoorFrom,
  writeDoorRecordTo,
  type DoorRecord,
} from './doorsDoc';
import {
  GATE_CAST_OFF_DEFER_MS,
  GATE_DOCK_DEFER_MS,
  GATE_PRE_DIAL_MS,
  GATE_REDIAL_MS,
  GATE_SESSION_MAX_MS,
  GATE_STALE_MS,
  createGateKeeper,
  departureClose,
  dockableGates,
  ferryBerthingIn,
  ferryLook,
  gateFixes,
  gateMove,
  gateSessionWanted,
  stationCastOff,
  stationDock,
  stationLook,
  type FerrySession,
  type GateEnd,
  type GateKeeperDeps,
  type GateView,
} from './gateKeeper';
import { ROOM_SESSION_OPEN_MS } from './roomSession';
import { GUARD_BAND_MS, legWindowAfter, pauseCheckpoint, startCheckpoint } from './pilotRoute';
import { CAST_OFF_LATE_MS, KEEPER_RETRY_MS, keeperStep } from './routeKeeper';
import {
  checkpointKey,
  checkpointToWire,
  routeIn,
  routeToWire,
  type RouteCheckpoint,
  type RouteStop,
  type ShipRoute,
} from './shipRoute';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const BIG = 1e6;

const seed = (room: string) => `ssf://room#room=${room}`;
/** A whole-millisecond moment at or after `t` (door stamps are integers). */
const ms = (t: number) => Math.ceil(t);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** The ferry, its route port, and the station room the keeper stands in
 *  (stop 1's berth room, its gate on `x+`). */
const FERRY = 'ferry-1';
const PORT = 'x-';
const HERE = 'room-1';

function stop(i: number, slot: number, over: Partial<RouteStop> = {}): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', anyGate: true },
    waitSecs: 60,
    ...over,
  };
}

/** The 0 ↔ 1 ferry, running from T0 at stop 0 with its robot captain. */
function running(over: Partial<ShipRoute> = {}): ShipRoute & { startedAt: number } {
  return {
    stops: [stop(0, 0), stop(1, 1)],
    shape: 'backAndForth',
    shipPort: PORT,
    robotDockId: 'dock-1',
    startedAt: T0,
    startStop: 0,
    ...over,
  } as ShipRoute & { startedAt: number };
}

const R = running();
const S = startCheckpoint(R, { at: T0, pilot: 'robot', fuel: BIG })!;
/** It reaches HERE at ARRIVE, and leaves at DEPART after its 60 s stay. */
const ARRIVE = ms(S.arriveAt);
const DEPART = ms(legWindowAfter(R, 1, S.arriveAt + 60 * SEC)!.departAt);
/** When a dock at HERE is made in these tests. */
const D0 = ARRIVE + GATE_DOCK_DEFER_MS + SEC;

/** HERE's end of a dock at `doorId`. */
const near = (doorId: string): NearEnd => ({
  roomId: HERE, address: seed(HERE), doorId, wall: doorId === 'x+' ? 'x+' : 'y-', lateral: 0,
});

/** A gate's dock to the ferry's route port (or, with `room`, another ship). */
const dockOf = (dockedAt: number, o: { room?: string; farDoor?: string; lateral?: number } = {}) =>
  buildDoorPairing(seed(o.room ?? FERRY), {
    segments: dockChain(), farDoor: o.farDoor ?? PORT, farWall: 'x-', farLateral: o.lateral ?? 0, transient: true, dockedAt,
  });
/** A gate's memory of the ferry, undocked at `at`. */
const memoryOf = (at: number, lateral = 0) =>
  buildDoorTombstone(seed(FERRY), { farDoor: PORT, farWall: 'x-', farLateral: lateral, undockedAt: at });
/** The ferry's port docked to HERE's `doorId`. */
const portDockedAt = (dockedAt: number, doorId = 'x+') =>
  buildDoorPairing(seed(HERE), {
    segments: dockChain(), farDoor: doorId, farWall: doorId === 'x+' ? 'x+' : 'y-', farLateral: 0, transient: true, dockedAt,
  });
/** The ferry's port as it left stop 0 on time. */
const leftStop0 = () => buildDoorTombstone(seed('room-0'), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: ms(S.departAt) });

const BERTHING = { address: seed(FERRY), farWall: 'x-' as const, farLateral: 0 };

const gate = (doorId: string, n: number, record?: DoorRecord, over: Partial<GateView> = {}): GateView =>
  ({ doorId, gate: n, record, ...over });

/** The ferry's room: its running route, its route port (fitted, and as
 *  given: by default undocked from stop 0 on time). */
function ferryDoc(port: DoorRecord = leftStop0(), ckpts: readonly RouteCheckpoint[] = [S]): Y.Doc {
  const doc = new Y.Doc();
  const ship = doc.getMap('ship');
  ship.set('route', routeToWire(R));
  for (const e of ckpts) ship.set(checkpointKey(R.startedAt, e.legSeq, e.kind), checkpointToWire(e));
  doc.getMap('doorLayout').set(PORT, { id: PORT, wall: 'x-', lateral: 0, placed: true });
  doc.getMap('doorPolicy').set(PORT, { passage: 'public', construction: 'owner', adapter: true });
  doc.getMap('doors').set(PORT, port);
  return doc;
}

/** The ferry as HERE's departures map holds it. */
const entry = (over: Partial<DepartureFerry> = {}): DepartureFerry => ({
  shipRoomId: FERRY, name: 'FERRY ONE', capacity: BIG, route: R, at: T0, checkpoints: [S], ...over,
});

const sameStation = (s: RouteStop, roomId: string) => roomId === s.berth.roomId;

// ── Which record names the ferry ─────────────────────────────────────────────

describe('which of the room\'s records names the ferry', () => {
  it('is the newest dock or dock memory naming its route port', () => {
    const doors = new Map<string, DoorRecord>([
      ['x+', memoryOf(T0 - HOUR, 1)],
      ['y-', dockOf(T0 - 2 * HOUR, { lateral: 2 })],
    ]);
    expect(ferryBerthingIn(doors, FERRY, PORT)).toEqual({ address: seed(FERRY), farWall: 'x-', farLateral: 1 });
    doors.set('y-', dockOf(T0, { lateral: 2 }));
    expect(ferryBerthingIn(doors, FERRY, PORT)).toEqual({ address: seed(FERRY), farWall: 'x-', farLateral: 2 });
  });

  it('is none when only another ship, another door of the ferry, or a plain tombstone is there', () => {
    const doors = new Map<string, DoorRecord>([
      ['x+', dockOf(T0, { room: 'ship-2' })],
      ['y-', dockOf(T0, { farDoor: 'y+' })],
      ['y+', buildDoorTombstone(seed(FERRY))],
      ['d:gangway', buildDoorPairing(seed(FERRY), { farDoor: PORT })],
    ]);
    expect(ferryBerthingIn(doors, FERRY, PORT)).toBeNull();
    expect(ferryBerthingIn(new Map(), FERRY, PORT)).toBeNull();
  });

  // Copilot (PR 204): holdsFerry reads an unnamed far door as the route port,
  // as the boards do, and so does the berthing.
  it("reads an older writer's record that names no far door as the route port", () => {
    const doors = new Map<string, DoorRecord>([
      ['x+', buildDoorPairing(seed(FERRY), { segments: dockChain(), transient: true, dockedAt: T0 })],
    ]);
    expect(ferryBerthingIn(doors, FERRY, PORT)).toEqual({ address: seed(FERRY) });
    doors.set('y-', buildDoorTombstone(seed(FERRY), { farWall: 'x-', farLateral: 3, undockedAt: T0 + SEC }));
    expect(ferryBerthingIn(doors, FERRY, PORT)).toEqual({ address: seed(FERRY), farWall: 'x-', farLateral: 3 });
  });
});

// ── Which gates it may dock at ───────────────────────────────────────────────

describe('the gates a ferry may dock at', () => {
  const stop1 = R.stops[1];

  it("is the stop's own gate first, then (a gate change allowed) the others by number", () => {
    const gates = [gate('y-', 3), gate('x+', 1), gate('y+', 2)];
    expect(dockableGates(gates, stop1, FERRY).map((g) => g.doorId)).toEqual(['x+', 'y+', 'y-']);
    // Its own gate taken: the others.
    gates[1].record = dockOf(T0, { room: 'ship-2' });
    expect(dockableGates(gates, stop1, FERRY).map((g) => g.doorId)).toEqual(['y+', 'y-']);
    // A stop pinned to its gate: that gate alone.
    const pinned = stop(1, 1, { berth: { roomId: HERE, farDoor: 'x+', gate: 1, anyGate: false } });
    expect(dockableGates(gates, pinned, FERRY)).toEqual([]);
    gates[1].record = memoryOf(T0);
    expect(dockableGates(gates, pinned, FERRY).map((g) => g.doorId)).toEqual(['x+']);
  });

  it('is never a gate for granted captains, a closed one, or one reserved for another ship', () => {
    const gates = [
      gate('x+', 1, undefined, { access: 'pass' }),
      gate('y-', 2, undefined, { access: 'closed' }),
      gate('y+', 3, undefined, { access: 'reserved', reservedFor: 'ship-2' }),
      gate('d:4', 4, undefined, { access: 'reserved', reservedFor: FERRY }),
      gate('d:5', 5, undefined, { access: 'open' }),
    ];
    expect(dockableGates(gates, stop1, FERRY).map((g) => g.doorId)).toEqual(['d:4', 'd:5']);
  });
});

// ── When the station looks closer ────────────────────────────────────────────

describe('when the station opens a session to the ferry', () => {
  const look = (now: number, docks: BoardDock[] = [], e = entry()) => stationLook(e, HERE, docks, now);
  const wanted = (now: number, docks: BoardDock[] = [], e = entry()) => gateSessionWanted(look(now, docks, e), now);

  it('from its arrival here until the guard band before its departure', () => {
    expect(wanted(ms(S.departAt) - 10 * SEC)).toBe(false); // still at stop 0
    expect(wanted(ARRIVE - 10 * SEC)).toBe(false); // in flight
    expect(look(ARRIVE + SEC)).toMatchObject({ dockedAt: null, atHere: true });
    expect(wanted(ARRIVE + SEC)).toBe(true);
    expect(wanted(DEPART - GUARD_BAND_MS - 1)).toBe(true);
    expect(wanted(DEPART - GUARD_BAND_MS)).toBe(false);
  });

  it('docked here: from GATE_PRE_DIAL_MS before its departure, and on while it is overdue', () => {
    const docks: BoardDock[] = [{ dockedAt: D0, farDoor: PORT }];
    const before = DEPART - GATE_PRE_DIAL_MS - 1;
    expect(look(before, docks).dockedAt).toBe(D0);
    expect(wanted(before, docks)).toBe(false);
    expect(wanted(before + 1, docks)).toBe(true);
    expect(wanted(DEPART + HOUR, docks)).toBe(true);
  });

  it('never for a stop in another room, nor a paused route', () => {
    expect(gateSessionWanted(stationLook(entry(), 'room-9', [], ARRIVE + SEC), ARRIVE + SEC)).toBe(false);
    const paused = pauseCheckpoint(R, 1, { at: ARRIVE + SEC })!;
    expect(wanted(ARRIVE + 2 * SEC, [], entry({ checkpoints: [S, paused] }))).toBe(false);
  });

  // Copilot (PR 204): a session may take its whole open deadline, and the
  // cast-off must still come before the keeper restarts the stay.
  it('dials a whole session open, and more, before the departure', () => {
    expect(GATE_PRE_DIAL_MS).toBeGreaterThanOrEqual(ROOM_SESSION_OPEN_MS + 10 * SEC);
    expect(GATE_CAST_OFF_DEFER_MS).toBeLessThan(CAST_OFF_LATE_MS);
  });

  it('keeps a session through the moments around a departure', () => {
    expect(departureClose(look(DEPART - GATE_PRE_DIAL_MS - 1), DEPART - GATE_PRE_DIAL_MS - 1)).toBe(false);
    expect(departureClose(look(DEPART - GATE_PRE_DIAL_MS), DEPART - GATE_PRE_DIAL_MS)).toBe(true);
    const docks: BoardDock[] = [{ dockedAt: D0, farDoor: PORT }];
    expect(departureClose(look(DEPART + GATE_PRE_DIAL_MS, docks), DEPART + GATE_PRE_DIAL_MS)).toBe(true);
    expect(departureClose(look(DEPART + GATE_PRE_DIAL_MS + 1, docks), DEPART + GATE_PRE_DIAL_MS + 1)).toBe(false);
  });
});

// ── The ferry's own view, and what a gate does with each step ───────────────

describe("the ferry's own view, and what the gate does with its keeper's step", () => {
  const gates = (x?: DoorRecord, y?: DoorRecord) => [gate('x+', 1, x), gate('y-', 2, y)];
  const at = (doc: Y.Doc, now: number, g: GateView[] = gates(memoryOf(T0 - HOUR)), roomId = HERE) => {
    const look = ferryLook({ doc, capacity: BIG, now, sameStation, memory: null })!;
    const step = keeperStep(look.view);
    return { look, step, move: gateMove({ step, look, gates: g, roomId, shipRoomId: FERRY, near, now }) };
  };

  it("docks at the stop's own gate once its arrival is GATE_DOCK_DEFER_MS old", () => {
    const doc = ferryDoc();
    const r = at(doc, ARRIVE + SEC);
    expect(r.look.view.flight).toMatchObject({ status: 'docked', legSeq: 1, stopIndex: 1 });
    expect(r.look.view.port).toMatchObject({ state: 'undocked', atStop: false });
    expect(r.step).toEqual({ kind: 'dock' });
    expect(r.move).toEqual({ kind: 'none', why: 'defer' });
    expect(at(doc, ARRIVE + GATE_DOCK_DEFER_MS).move).toMatchObject({ kind: 'dock', gate: { doorId: 'x+' } });
    // Its own gate taken: the next free one, the stop allowing a gate change.
    const t = ARRIVE + GATE_DOCK_DEFER_MS;
    expect(at(doc, t, gates(dockOf(T0, { room: 'ship-2' }))).move).toMatchObject({ kind: 'dock', gate: { doorId: 'y-' } });
    expect(at(doc, t, gates(dockOf(T0, { room: 'ship-2' }), dockOf(T0, { room: 'ship-3' }))).move)
      .toEqual({ kind: 'none', why: 'no-gate' });
    // A stop whose berth is another room is that room's.
    expect(at(doc, t, gates(), 'room-9').move).toEqual({ kind: 'none', why: 'not-here' });
  });

  // Copilot (PR 204): a DOCK refuses a berth where the module would land on
  // another one of the station, and so does the station's keeper.
  it('passes over a gate where the ferry would overlap another module, as a DOCK refuses it', () => {
    const t = ARRIVE + GATE_DOCK_DEFER_MS;
    const moveAt = (doc: Y.Doc, clashes: Record<string, string>) => {
      const look = ferryLook({ doc, capacity: BIG, now: t, sameStation, memory: null })!;
      return gateMove({
        step: keeperStep(look.view), look, gates: gates(memoryOf(T0 - HOUR)), roomId: HERE, shipRoomId: FERRY, near, now: t,
        overlap: (g) => clashes[g.doorId] ?? null,
      });
    };
    const doc = ferryDoc();
    expect(moveAt(doc, {})).toMatchObject({ kind: 'dock', gate: { doorId: 'x+' } });
    expect(moveAt(doc, { 'x+': 'Cargo Bay' })).toMatchObject({ kind: 'dock', gate: { doorId: 'y-' } });
    expect(moveAt(doc, { 'x+': 'Cargo Bay', 'y-': 'Hab Ring' }))
      .toMatchObject({ kind: 'none', why: 'overlap', gate: { doorId: 'x+' }, module: 'Cargo Bay' });
    // A stop with no gate change: its own gate or none.
    const own = ferryDoc();
    own.getMap('ship').set('route', routeToWire({ ...R, stops: [stop(0, 0), stop(1, 1, { berth: { roomId: HERE, farDoor: 'x+', anyGate: false } })] }));
    expect(moveAt(own, { 'x+': 'Cargo Bay' }))
      .toMatchObject({ kind: 'none', why: 'overlap', gate: { doorId: 'x+' }, module: 'Cargo Bay' });
  });

  it('docks nowhere while one of its gates holds a claim on the ferry (a DOCK under way)', () => {
    const r = at(ferryDoc(), ARRIVE + GATE_DOCK_DEFER_MS, gates(dockOf(ARRIVE + 2 * SEC)));
    expect(r.step).toEqual({ kind: 'dock' });
    expect(r.move).toEqual({ kind: 'none', why: 'claimed' });
  });

  it('casts off its own gate GATE_CAST_OFF_DEFER_MS after the departure, and no other dock', () => {
    const doc = ferryDoc(portDockedAt(D0));
    const g = gates(dockOf(D0));
    expect(at(doc, DEPART - SEC, g).step).toEqual({ kind: 'idle', why: 'docked' });
    expect(at(doc, DEPART + SEC, g)).toMatchObject({
      step: { kind: 'cast-off', why: 'departure' }, move: { kind: 'none', why: 'defer' },
    });
    expect(at(doc, DEPART + GATE_CAST_OFF_DEFER_MS, g).move).toMatchObject({ kind: 'cast-off', gate: { doorId: 'x+' } });
    // Docked at a gate of this room not set to auto-dock: not this keeper's.
    const other = ferryDoc(portDockedAt(D0, 'd:bay'));
    expect(at(other, DEPART + GATE_CAST_OFF_DEFER_MS, gates()).move).toEqual({ kind: 'none', why: 'not-ours' });
  });

  it('restarts a stay it finds docked at its own gate past the departure, and writes for no other dock', () => {
    const late = DEPART + CAST_OFF_LATE_MS + SEC;
    const r = at(ferryDoc(portDockedAt(D0)), late, gates(dockOf(D0)));
    expect(r.move).toMatchObject({ kind: 'write', why: 'restart', entry: { kind: 'dock', legSeq: 1, stayStart: late } });
    expect(at(ferryDoc(portDockedAt(D0, 'd:bay')), late, gates()).move).toEqual({ kind: 'none', why: 'not-ours' });
  });

  it('counts a dock on any other door of the ferry as one it may not release', () => {
    const doc = ferryDoc(portDockedAt(D0));
    doc.getMap('doors').set('y+', buildDoorPairing(seed('guest'), { segments: dockChain(), transient: true, dockedAt: D0 }));
    const r = at(doc, DEPART + GATE_CAST_OFF_DEFER_MS, gates(dockOf(D0)));
    expect(r.look.view.docks).toMatchObject({ atStop: D0, stuck: 1 });
    expect(r.step).toEqual({ kind: 'idle', why: 'held' });
  });

  it('reads nothing from a ferry whose route does not run', () => {
    const doc = ferryDoc();
    doc.getMap('ship').set('route', routeToWire({ ...R, startedAt: undefined, startStop: undefined }));
    expect(ferryLook({ doc, capacity: BIG, now: ARRIVE + SEC, sameStation, memory: null })).toBeNull();
  });
});

// ── The gate follows the ferry ───────────────────────────────────────────────

describe('the gate follows the ferry', () => {
  const NOW = T0 + HOUR;
  const fixes = (g: GateView[], port: DoorRecord | undefined, heldFor = 0) => gateFixes({
    gates: g, port, shipRoomId: FERRY, shipPort: PORT, berthing: BERTHING, near, heldFor: () => heldFor, now: NOW,
  });

  it("takes a dock the ferry's port holds to it, under the port's stamp", () => {
    // A far write that never landed here: from the gate's own memory, or the room's.
    expect(fixes([gate('x+', 1, memoryOf(T0 - HOUR))], portDockedAt(T0))).toEqual([{ kind: 'join', gate: 'x+', record: dockOf(T0) }]);
    expect(fixes([gate('x+', 1)], portDockedAt(T0))).toEqual([{ kind: 'join', gate: 'x+', record: dockOf(T0) }]);
    // The same dock under another stamp.
    expect(fixes([gate('x+', 1, dockOf(T0 - SEC))], portDockedAt(T0))).toEqual([{ kind: 'join', gate: 'x+', record: dockOf(T0) }]);
    // Agreeing ends, and a dock to another gate of the room: nothing.
    expect(fixes([gate('x+', 1, dockOf(T0))], portDockedAt(T0))).toEqual([]);
    expect(fixes([gate('y-', 2)], portDockedAt(T0))).toEqual([]);
  });

  it('tells the ferry a gate let go after its dock', () => {
    expect(fixes([gate('x+', 1, memoryOf(T0 + SEC))], portDockedAt(T0)))
      .toEqual([{ kind: 'release-ferry', gate: 'x+', undockedAt: T0 + SEC }]);
  });

  // Copilot (PR 204): a plain tombstone at the gate (its port taken off
  // since) holds no dock, and none is made over it: the ferry's port lets go.
  it('lets the ferry go from a plain tombstone at the gate, and takes no dock at a gate that does not admit it', () => {
    const release = [{ kind: 'release-ferry', gate: 'x+', undockedAt: NOW }];
    expect(fixes([gate('x+', 1, buildDoorTombstone(seed(FERRY)))], portDockedAt(T0))).toEqual(release);
    expect(fixes([gate('x+', 1, buildDoorTombstone(seed('ship-2')), { retired: true })], portDockedAt(T0))).toEqual(release);
    expect(fixes([gate('x+', 1, memoryOf(T0 - HOUR), { access: 'closed' })], portDockedAt(T0))).toEqual([]);
  });

  // Copilot (PR 204): a gate holding another pairing is never taken from it,
  // so the ferry's side is what must let go, or the two never converge.
  it("lets the ferry go from a gate holding another ship's dock, another of its doors, or a gangway, which the gate keeps", () => {
    const release = (undockedAt: number) => [{ kind: 'release-ferry', gate: 'x+', undockedAt }];
    expect(fixes([gate('x+', 1, dockOf(T0 + SEC, { room: 'ship-2' }))], portDockedAt(T0))).toEqual(release(NOW));
    expect(fixes([gate('x+', 1, dockOf(T0, { farDoor: 'y-' }))], portDockedAt(T0))).toEqual(release(NOW));
    expect(fixes([gate('x+', 1, buildDoorPairing(seed(FERRY), { farDoor: PORT }))], portDockedAt(T0))).toEqual(release(NOW));
    // After the port's own stamp, whatever this clock says.
    expect(fixes([gate('x+', 1, dockOf(T0, { room: 'ship-2' }))], portDockedAt(NOW + MIN))).toEqual(release(NOW + MIN + 1));
  });

  // Copilot (PR 204): a gate switched off is settled, never docked at again.
  it('takes no new dock at a retired gate, but still settles one there', () => {
    const retired = { retired: true as const };
    expect(fixes([gate('x+', 1, memoryOf(T0 - HOUR), retired)], portDockedAt(T0))).toEqual([]);
    expect(fixes([gate('x+', 1, undefined, retired)], portDockedAt(T0))).toEqual([]);
    expect(fixes([gate('x+', 1, memoryOf(T0 + SEC), retired)], portDockedAt(T0)))
      .toEqual([{ kind: 'release-ferry', gate: 'x+', undockedAt: T0 + SEC }]);
    expect(fixes([gate('x+', 1, dockOf(T0 - SEC), retired)], portDockedAt(T0))).toEqual([{ kind: 'join', gate: 'x+', record: dockOf(T0) }]);
    expect(fixes([gate('x+', 1, dockOf(T0), retired)], buildDoorTombstone(seed(HERE), { farDoor: 'x+', undockedAt: T0 + SEC })))
      .toEqual([{ kind: 'release-gate', gate: 'x+', record: memoryOf(NOW) }]);
  });

  it('lets go of a dock the ferry let go: undocked after it, docked elsewhere since, or unheld for GATE_STALE_MS', () => {
    const g = [gate('x+', 1, dockOf(T0))];
    const released = [{ kind: 'release-gate', gate: 'x+', record: memoryOf(NOW) }];
    expect(fixes(g, buildDoorTombstone(seed(HERE), { farDoor: 'x+', undockedAt: T0 + SEC }))).toEqual(released);
    const elsewhere = buildDoorPairing(seed('room-0'), { segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 + SEC });
    expect(fixes(g, elsewhere)).toEqual(released);
    // The port's last word is older than the gate's dock: a DOCK under way,
    // until the gate has held it GATE_STALE_MS.
    const older = buildDoorTombstone(seed(HERE), { farDoor: 'x+', undockedAt: T0 - SEC });
    expect(fixes(g, older, GATE_STALE_MS - 1)).toEqual([]);
    expect(fixes(g, older, GATE_STALE_MS)).toEqual(released);
    // A later undock stamp than the clock is kept.
    expect(fixes(g, buildDoorTombstone(seed(HERE), { farDoor: 'x+', undockedAt: NOW + MIN })))
      .toEqual([{ kind: 'release-gate', gate: 'x+', record: memoryOf(NOW + MIN) }]);
  });
});

// ── The two-ended writes ─────────────────────────────────────────────────────

/** HERE's gate `doorId` over a station doc; `stay` false once the player has
 *  walked on, `live` false once it is no gate the keeper docks at. */
function gateEndOn(station: Y.Doc, doorId = 'x+', stay = () => true, live = stay): GateEnd {
  return {
    near: near(doorId),
    read: () => readDoorFrom(station, doorId),
    write: (rec) => {
      if (!stay()) return false;
      writeDoorRecordTo(station, doorId, rec);
      return true;
    },
    live,
  };
}

const sessionOn = (doc: Y.Doc, acked = true) => ({ doc, confirm: async () => acked });
const instant = () => Promise.resolve();

describe('docking from the station side', () => {
  const dock = (
    station: Y.Doc,
    ferry: Y.Doc,
    o: { acked?: boolean; wait?: (ms: number) => Promise<void>; stay?: () => boolean; live?: () => boolean } = {},
  ) =>
    stationDock({
      session: sessionOn(ferry, o.acked ?? true),
      gate: gateEndOn(station, 'x+', o.stay, o.live ?? o.stay),
      shipRoomId: FERRY,
      shipPort: PORT,
      berthing: BERTHING,
      now: () => D0,
      wait: o.wait ?? instant,
    });
  const stationWith = (rec?: DoorRecord) => {
    const doc = new Y.Doc();
    if (rec) doc.getMap('doors').set('x+', rec);
    return doc;
  };

  it("docks both ends under one stamp, posed from the room's memory of the ferry", async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    expect(await dock(station, ferry)).toEqual({ ok: true, dockedAt: D0 });
    expect(readDoorFrom(station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(ferry, PORT)).toEqual(portDockedAt(D0));
  });

  it("joins a dock the ferry's port already holds to this gate", async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    expect(await dock(station, ferryDoc(portDockedAt(D0 - SEC)))).toEqual({ ok: true, dockedAt: D0 - SEC, joined: true });
    expect(readDoorFrom(station, 'x+')).toEqual(dockOf(D0 - SEC));
  });

  it('refuses a gate holding another ship or a claim under way, a port docked elsewhere, and a door with no port', async () => {
    const other = dockOf(T0, { room: 'ship-2' });
    expect(await dock(stationWith(other), ferryDoc())).toEqual({ ok: false, reason: 'taken' });
    expect(await dock(stationWith(other), ferryDoc(portDockedAt(D0 - SEC)))).toEqual({ ok: false, reason: 'taken' });
    expect(await dock(stationWith(dockOf(D0 - SEC)), ferryDoc())).toEqual({ ok: false, reason: 'claimed' });
    const elsewhere = buildDoorPairing(seed('room-0'), { segments: dockChain(), farDoor: 'x+', transient: true, dockedAt: T0 });
    const station = stationWith(memoryOf(T0 - HOUR));
    expect(await dock(station, ferryDoc(elsewhere))).toEqual({ ok: false, reason: 'occupied' });
    const portless = ferryDoc();
    portless.getMap('doorPolicy').set(PORT, { passage: 'public', construction: 'owner', adapter: false });
    expect(await dock(station, portless)).toEqual({ ok: false, reason: 'no-port' });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(T0 - HOUR));
  });

  it("takes its claim back when the ferry's port refuses it", async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    ferry.getMap('doorPolicy').set(PORT, { passage: 'public', construction: 'owner', adapter: true, gateAccess: 'closed' });
    expect(await dock(station, ferry)).toEqual({ ok: false, reason: 'refused' });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(D0 + 1));
    expect(readDoorFrom(ferry, PORT)).toEqual(leftStop0());
  });

  // Copilot (PR 204): nobody aboard docks it, so the request names no
  // requester, and the key of whoever stands in the station opens nothing.
  it('is refused by a ferry port open only to granted captains, whoever is granted there', async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    ferry.getMap('doorPolicy').set(PORT, { passage: 'public', construction: 'owner', adapter: true, gateAccess: 'pass' });
    ferry.getMap('doorGrants').set(`${PORT}|pub-here`, { doorId: PORT, pub: 'pub-here', name: 'Captain', grantedAt: T0 });
    expect(await dock(station, ferry)).toEqual({ ok: false, reason: 'refused' });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(D0 + 1));
    expect(readDoorFrom(ferry, PORT)).toEqual(leftStop0());
  });

  it('leaves the gate to a claim that won it during the settle', async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    const r = await dock(station, ferry, {
      wait: async () => { station.getMap('doors').set('x+', dockOf(T0, { room: 'ship-2' })); },
    });
    expect(r).toEqual({ ok: false, reason: 'lost' });
    expect(readDoorFrom(station, 'x+')).toEqual(dockOf(T0, { room: 'ship-2' }));
    expect(readDoorFrom(ferry, PORT)).toEqual(leftStop0());
  });

  // Copilot (PR 204): no keeper settles a claim at a gate whose AUTO-DOCK
  // is off, so it is taken back before the ferry's side is asked.
  it('takes its claim back when the gate stops being one it docks at while the claim settles', async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    let live = true;
    const r = await dock(station, ferry, { live: () => live, wait: async () => { live = false; } });
    expect(r).toEqual({ ok: false, reason: 'disabled' });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(D0 + 1));
    expect(readDoorFrom(ferry, PORT)).toEqual(leftStop0());
  });

  it("joins the stamp a rider's DOCK crossing it gave the ferry's port", async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    let first = true;
    const r = await dock(station, ferry, {
      wait: async () => {
        if (first) ferry.getMap('doors').set(PORT, portDockedAt(D0 - 5));
        first = false;
      },
    });
    expect(r).toEqual({ ok: true, dockedAt: D0 - 5, joined: true });
    expect(readDoorFrom(station, 'x+')).toEqual(dockOf(D0 - 5));
    expect(readDoorFrom(ferry, PORT)).toEqual(portDockedAt(D0 - 5));
  });

  // Copilot (PR 204): a dock counts only while both ends hold its stamp, and
  // nothing is written over what another game wrote at the gate meanwhile.
  it("counts no dock once another game has written over its claim while the ferry's side was asked", async () => {
    for (const over of [dockOf(T0, { room: 'ship-2' }), dockOf(D0 + 7), memoryOf(D0 + 9)]) {
      const station = stationWith(memoryOf(T0 - HOUR));
      const ferry = ferryDoc();
      let n = 0;
      const r = await dock(station, ferry, {
        wait: async () => { if (++n === 2) station.getMap('doors').set('x+', over); },
      });
      expect(r).toEqual({ ok: false, reason: 'lost' });
      expect(readDoorFrom(station, 'x+')).toEqual(over);
      // The ferry's side stands: the keeper's next look settles it.
      expect(readDoorFrom(ferry, PORT)).toEqual(portDockedAt(D0));
    }
  });

  it("takes a crossing DOCK's stamp over its own claim alone", async () => {
    const crossing = async (gateNow: DoorRecord) => {
      const station = stationWith(memoryOf(T0 - HOUR));
      const ferry = ferryDoc();
      let n = 0;
      const r = await dock(station, ferry, {
        wait: async () => {
          if (++n !== 2) return;
          ferry.getMap('doors').set(PORT, portDockedAt(D0 - 5));
          station.getMap('doors').set('x+', gateNow);
        },
      });
      return { r, gate: readDoorFrom(station, 'x+'), port: readDoorFrom(ferry, PORT) };
    };
    // Another ship took the gate: it keeps it, and the dock is lost.
    const other = dockOf(T0, { room: 'ship-2' });
    expect(await crossing(other)).toEqual({ r: { ok: false, reason: 'lost' }, gate: other, port: portDockedAt(D0 - 5) });
    // The gate took that stamp already (another game's keeper): both agree.
    expect(await crossing(dockOf(D0 - 5))).toEqual({
      r: { ok: true, dockedAt: D0 - 5, joined: true }, gate: dockOf(D0 - 5), port: portDockedAt(D0 - 5),
    });
  });

  it("keeps its claim when the ferry's side is never acknowledged", async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    expect(await dock(station, ferry, { acked: false })).toEqual({ ok: false, reason: 'unconfirmed' });
    expect(readDoorFrom(station, 'x+')).toEqual(dockOf(D0));
  });

  it('writes nothing once the player has walked on', async () => {
    const station = stationWith(memoryOf(T0 - HOUR));
    const ferry = ferryDoc();
    expect(await dock(station, ferry, { stay: () => false })).toEqual({ ok: false, reason: 'left' });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(T0 - HOUR));
    expect(readDoorFrom(ferry, PORT)).toEqual(leftStop0());
  });
});

describe('casting off from the station side', () => {
  it('undocks both ends in one tick, each remembering the other', () => {
    const station = new Y.Doc();
    station.getMap('doors').set('x+', dockOf(D0));
    const ferry = ferryDoc(portDockedAt(D0));
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    const r = stationCastOff({ doc: ferry, address: seed(FERRY), gate: gateEndOn(station), shipRoomId: FERRY, shipPort: PORT, now: t });
    expect(r).toMatchObject({ wrote: true, undockedAt: t });
    expect(readDoorFrom(station, 'x+')).toEqual(memoryOf(t));
    expect(readDoorFrom(ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t }));
  });

  it("leaves a port docked elsewhere alone, letting go of the gate's side only", () => {
    const station = new Y.Doc();
    station.getMap('doors').set('x+', dockOf(D0));
    const ferry = ferryDoc(portDockedAt(D0, 'y-'));
    const r = stationCastOff({ doc: ferry, address: seed(FERRY), gate: gateEndOn(station), shipRoomId: FERRY, shipPort: PORT, now: DEPART });
    expect(r.wrote).toBe(false);
    expect(readDoorFrom(ferry, PORT)).toEqual(portDockedAt(D0, 'y-'));
    expect(readDoorFrom(station, 'x+')?.paired).toBe(false);
  });
});

// ── The loop ─────────────────────────────────────────────────────────────────

/** A copy of a room's doc, as a fresh session holds it. */
function replicaOf(room: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  return doc;
}

/** A station room HERE with auto-dock gates `x+` (gate 1, remembering the
 *  ferry from an earlier call with someone aboard) and `y-` (gate 2), the
 *  ferry's room behind a stand-in session, and a clock. With `replica`, each
 *  session holds its own copy of the ferry's room, and the room takes a write
 *  only once it is acknowledged; without, a write unacknowledged has landed
 *  after all. */
function harness(o: { port?: DoorRecord; gateRec?: DoorRecord | null; ckpts?: RouteCheckpoint[]; replica?: boolean } = {}) {
  const station = new Y.Doc();
  if (o.gateRec !== null) station.getMap('doors').set('x+', o.gateRec ?? memoryOf(T0 - HOUR));
  const ferry = ferryDoc(o.port, o.ckpts);
  const h = {
    now: T0,
    station,
    ferry,
    entry: entry(o.ckpts ? { checkpoints: o.ckpts } : {}),
    /** Does the node acknowledge writes? */
    ack: true,
    /** The gates whose AUTO-DOCK is on. */
    auto: new Set(['x+', 'y-']),
    /** The keeper's waits (a claim settling). */
    wait: instant as (ms: number) => Promise<void>,
    opened: [] as string[],
    closes: 0,
    notes: [] as Array<[string, string, string]>,
    published: [] as Array<[string, DeparturesPublish]>,
  };
  const gateViews = (): GateView[] => [
    gate('x+', 1, readDoorFrom(station, 'x+')),
    gate('y-', 2, readDoorFrom(station, 'y-')),
  ].filter((g) => h.auto.has(g.doorId));
  const deps: GateKeeperDeps = {
    roomId: () => HERE,
    ready: () => true,
    gates: gateViews,
    doors: () => readAllDoorsFrom(station),
    ferries: () => [h.entry],
    open: async (address) => {
      h.opened.push(address);
      let closed = false;
      const doc = o.replica ? replicaOf(ferry) : ferry;
      const s: FerrySession = {
        doc,
        confirm: async (since) => {
          if (closed || !h.ack) return false;
          if (doc !== ferry) Y.applyUpdate(ferry, Y.encodeStateAsUpdate(doc, since));
          return true;
        },
        close: () => {
          if (closed) return;
          closed = true;
          h.closes++;
        },
        get closed() {
          return closed;
        },
      };
      return s;
    },
    ownAddress: async (roomId) => seed(roomId),
    doorPose: (doorId) => ({ wall: doorId === 'x+' ? 'x+' : 'y-', lateral: 0 }),
    writeDoor: (doorId, rec) => writeDoorRecordTo(station, doorId, rec),
    publishHere: (pub) => {
      h.published.push(['here', pub]);
      const { endedRun: _ended, ...was } = h.entry;
      h.entry = {
        ...was, route: pub.route, checkpoints: [...pub.checkpoints], at: pub.at,
        ...(pub.endedRun !== undefined ? { endedRun: pub.endedRun } : {}),
      };
    },
    publishTo: (roomId, pub) => {
      h.published.push([roomId, pub]);
    },
    note: (doorId, text, tone) => {
      h.notes.push([doorId, text, tone]);
    },
    clock: () => h.now,
    wait: (ms) => h.wait(ms),
  };
  return { h, deps };
}

describe('the gate keeper over a stand-in session', () => {
  /** One tick at `t`, and everything it started allowed to finish. */
  const tickAt = async (keeper: ReturnType<typeof createGateKeeper>, h: { now: number }, t: number) => {
    h.now = t;
    keeper.tick();
    await flush();
  };

  it('docks an empty ferry on its arrival and casts it off at its departure', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE - 10 * SEC);
    expect(h.opened).toEqual([]);
    // The arrival: a session opens, and the dock waits for a rider's keeper.
    await tickAt(keeper, h, ARRIVE + SEC);
    expect(h.opened).toEqual([seed(FERRY)]);
    expect(keeper.sessions()).toEqual([FERRY]);
    await tickAt(keeper, h, ARRIVE + 2 * SEC);
    expect(readDoorFrom(h.station, 'x+')?.paired).toBe(false);
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    expect(h.notes).toEqual([['x+', 'Docked FERRY ONE automatically.', 'ok']]);
    // Docked: the session hangs up until the departure comes near.
    await tickAt(keeper, h, D0 + SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(1);
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    expect(keeper.sessions()).toEqual([FERRY]);
    expect(h.opened).toHaveLength(2);
    // The departure: a moment for a rider's keeper, then both ends let go.
    await tickAt(keeper, h, DEPART + SEC);
    expect(readDoorFrom(h.station, 'x+')?.paired).toBe(true);
    await tickAt(keeper, h, DEPART + GATE_CAST_OFF_DEFER_MS);
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t }));
    expect(h.notes.at(-1)).toEqual(['x+', 'Cast off FERRY ONE on its timetable.', 'ok']);
    // It flies on: the session hangs up, and nothing was written to its route.
    await tickAt(keeper, h, t + SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
    expect(routeIn(h.ferry.getMap('ship'), t + SEC).checkpoints.map((e) => e.kind)).toEqual(['start']);
    expect(h.published).toEqual([]);
  });

  it('opens nothing for a ferry this room has never seen dock', async () => {
    const { h, deps } = harness({ gateRec: null });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    await tickAt(keeper, h, D0);
    expect(h.opened).toEqual([]);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  it('restarts a stay found docked at its gate past the departure, publishes it, and casts off at the new departure', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    const keeper = createGateKeeper(deps);
    const late = DEPART + HOUR;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    const dockEntry = routeIn(h.ferry.getMap('ship'), late + SEC).checkpoints.find((e) => e.kind === 'dock');
    expect(dockEntry).toMatchObject({ legSeq: 1, stayStart: late + SEC });
    // Published here first, then to the other stop.
    expect(h.published.map(([room]) => room)).toEqual(['here', 'room-0']);
    expect(h.published[0][1].checkpoints).toContainEqual(dockEntry);
    expect(h.notes).toEqual([['x+', 'FERRY ONE was still docked after its departure: its stay starts again.', 'warn']]);
    // The board's timetable now agrees: no session until the new departure.
    await tickAt(keeper, h, late + 2 * SEC);
    expect(keeper.sessions()).toEqual([]);
    const next = (dockEntry as { departAt: number }).departAt;
    await tickAt(keeper, h, ms(next) - GATE_PRE_DIAL_MS + SEC);
    await tickAt(keeper, h, ms(next) + GATE_CAST_OFF_DEFER_MS);
    expect(readDoorFrom(h.station, 'x+')?.paired).toBe(false);
    expect(readDoorFrom(h.ferry, PORT)?.paired).toBe(false);
  });

  it("takes a dock the ferry's port holds to its gate when the far write never landed", async () => {
    const { h, deps } = harness({ port: portDockedAt(ARRIVE + 2 * SEC) });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + 3 * SEC);
    await tickAt(keeper, h, ARRIVE + 4 * SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(ARRIVE + 2 * SEC));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(ARRIVE + 2 * SEC));
  });

  it('watches a claim the ferry never took at once, lets it go after GATE_STALE_MS, then docks the ferry', async () => {
    const { h, deps } = harness({ gateRec: dockOf(ARRIVE + 2 * SEC) });
    const keeper = createGateKeeper(deps);
    // The board here reads the claim as a dock, but the keeper has not seen
    // the ferry's port hold it: a session opens at once.
    const t = ARRIVE + 3 * SEC;
    await tickAt(keeper, h, t);
    expect(h.opened).toEqual([seed(FERRY)]);
    await tickAt(keeper, h, t + SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(ARRIVE + 2 * SEC)); // waits on it, nothing beside it
    await tickAt(keeper, h, t + SEC + GATE_STALE_MS);
    const freed = t + SEC + GATE_STALE_MS;
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(freed));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    // The gate free, its stay still on: the keeper docks the ferry itself.
    await tickAt(keeper, h, freed + SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(freed + SEC));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(freed + SEC));
  });

  // Copilot (PR 204): a paused or finished route wants no session of its
  // own, but a claim at a gate is still settled.
  it('settles a claim at its gate while the route is paused, then hangs up', async () => {
    const paused = pauseCheckpoint(R, 1, { at: ARRIVE + SEC })!;
    const { h, deps } = harness({ gateRec: dockOf(ARRIVE + 2 * SEC), ckpts: [S, paused] });
    const keeper = createGateKeeper(deps);
    const t = ARRIVE + 3 * SEC;
    await tickAt(keeper, h, t);
    expect(h.opened).toEqual([seed(FERRY)]);
    await tickAt(keeper, h, t + SEC);
    await tickAt(keeper, h, t + SEC + GATE_STALE_MS);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t + SEC + GATE_STALE_MS));
    // Nothing left to settle, and a paused route docks nothing.
    await tickAt(keeper, h, t + 2 * SEC + GATE_STALE_MS);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(1);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  it('settles a claim at its gate on a ferry whose route has finished', async () => {
    const { h, deps } = harness({ gateRec: dockOf(ARRIVE + 2 * SEC) });
    const { startedAt: _run, startStop: _from, ...saved } = R;
    const ship = h.ferry.getMap('ship');
    for (const k of [...ship.keys()]) if (k !== 'route') ship.delete(k);
    ship.set('route', routeToWire(saved as ShipRoute));
    h.entry = entry({ route: saved as ShipRoute, checkpoints: [], endedRun: T0 });
    const keeper = createGateKeeper(deps);
    const t = ARRIVE + 3 * SEC;
    await tickAt(keeper, h, t);
    expect(h.opened).toEqual([seed(FERRY)]);
    await tickAt(keeper, h, t + SEC);
    await tickAt(keeper, h, t + SEC + GATE_STALE_MS);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t + SEC + GATE_STALE_MS));
    await tickAt(keeper, h, t + 2 * SEC + GATE_STALE_MS);
    expect(keeper.sessions()).toEqual([]);
    // This board had the finish already.
    expect(h.published).toEqual([]);
  });

  // Copilot (PR 204): a finish this board missed would keep its timetable
  // running here, and the keeper dialling on it.
  it('tells this board a finish it missed, with the run it ended, and dials on it no more', async () => {
    const { h, deps } = harness();
    const { startedAt: _run, startStop: _from, ...saved } = R;
    // The finish keeps the run's start key.
    h.ferry.getMap('ship').set('route', routeToWire(saved as ShipRoute));
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    expect(h.opened).toEqual([seed(FERRY)]);
    await tickAt(keeper, h, ARRIVE + 2 * SEC);
    expect(h.published.map(([room]) => room)).toEqual(['here']);
    const pub = h.published[0][1];
    expect(pub).toMatchObject({ route: saved, checkpoints: [], endedRun: T0 });
    // It outranks every snapshot of that run, whatever the clocks say.
    expect(departureRouteNewer(pub, { ...entry(), at: pub.at + HOUR })).toBe(true);
    await tickAt(keeper, h, ARRIVE + 3 * SEC);
    expect(keeper.sessions()).toEqual([]);
    await tickAt(keeper, h, D0);
    await tickAt(keeper, h, DEPART + GATE_CAST_OFF_DEFER_MS);
    expect(h.opened).toHaveLength(1);
    expect(h.published).toHaveLength(1);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  it('hangs up on a docked ferry once it has seen both ends agree', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, D0 + SEC);
    expect(h.opened).toHaveLength(1);
    await tickAt(keeper, h, D0 + 2 * SEC);
    await tickAt(keeper, h, D0 + 3 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
  });

  // Copilot (PR 204): a checkpoint the ferry's room never acknowledged must
  // not reach any board.
  it('publishes a checkpoint only once the ferry room acknowledges it', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    const keeper = createGateKeeper(deps);
    const late = DEPART + HOUR;
    h.ack = false;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    expect(routeIn(h.ferry.getMap('ship'), late + SEC).checkpoints.some((e) => e.kind === 'dock')).toBe(true);
    // Never acknowledged: nothing published, and the session is replaced.
    expect(h.published).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.closes).toBe(1);
    // It landed after all: the next session tells every stop.
    h.ack = true;
    await tickAt(keeper, h, late + 2 * SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, late + 3 * SEC);
    expect(h.published.map(([room]) => room)).toEqual(['here', 'room-0']);
  });

  // Copilot (PR 204): a checkpoint never acknowledged is owed to every stop,
  // even once this board has it from another game.
  it('tells every stop a checkpoint never acknowledged, even once this board has it from another game', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    const keeper = createGateKeeper(deps);
    const late = DEPART + HOUR;
    h.ack = false;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    const news = routeIn(h.ferry.getMap('ship'), late + SEC);
    expect(news.checkpoints.some((e) => e.kind === 'dock')).toBe(true);
    expect(h.published).toEqual([]);
    // Another game's keeper tells this board what the ferry's room holds.
    h.entry = { ...h.entry, route: news.route!, checkpoints: [...news.checkpoints], at: late + SEC };
    h.ack = true;
    await tickAt(keeper, h, late + 2 * SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, late + 3 * SEC);
    expect(h.published.map(([room]) => room)).toEqual(['here', 'room-0']);
  });

  it("tells every stop a checkpoint never acknowledged after the room's last auto-dock gate is switched off", async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    const late = DEPART + HOUR;
    h.ack = false;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    expect(h.published).toEqual([]);
    expect(h.closes).toBe(1);
    h.auto.clear();
    h.ack = true;
    await tickAt(keeper, h, late + 2 * SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, late + 3 * SEC);
    expect(h.published.map(([room]) => room)).toEqual(['here', 'room-0']);
    // Told: nothing is left to watch.
    await tickAt(keeper, h, late + 4 * SEC);
    await tickAt(keeper, h, late + 5 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
  });

  it('forgets a checkpoint never acknowledged once the ferry stops calling here', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    let entries: DepartureFerry[] | null = null;
    const keeper = createGateKeeper({ ...deps, ferries: () => entries ?? [h.entry] });
    const late = DEPART + HOUR;
    h.ack = false;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    entries = [];
    h.ack = true;
    for (let i = 2; i <= 6; i++) await tickAt(keeper, h, late + i * SEC);
    expect(h.published).toEqual([]);
    expect(keeper.sessions()).toEqual([]);
  });

  it("forgets a checkpoint never acknowledged once the ferry's room holds no route", async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    const late = DEPART + HOUR;
    h.ack = false;
    await tickAt(keeper, h, late);
    await tickAt(keeper, h, late + SEC);
    h.ferry.getMap('ship').delete('route');
    h.auto.clear();
    h.ack = true;
    for (let i = 2; i <= 6; i++) await tickAt(keeper, h, late + i * SEC);
    expect(h.opened).toHaveLength(2);
    expect(h.published).toEqual([]);
    expect(keeper.sessions()).toEqual([]);
  });

  // Copilot (PR 204): a write to the ferry's side of a dock that is never
  // acknowledged is read back from a fresh session and made again.
  it("makes a cast-off the ferry's room never took again, backing off while acknowledgments fail", async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0), replica: true });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    expect(h.opened).toHaveLength(1);
    h.ack = false;
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    await tickAt(keeper, h, t);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t));
    expect(h.notes).toEqual([['x+', 'Cast off FERRY ONE, but its module did not confirm yet.', 'warn']]);
    expect(h.closes).toBe(1);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    // A fresh session at once, which reads the port still docked and lets it go.
    await tickAt(keeper, h, t + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, t + 2 * SEC);
    expect(h.closes).toBe(2);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    // Unacknowledged again: the next try waits GATE_REDIAL_MS.
    await tickAt(keeper, h, t + 3 * SEC);
    expect(h.opened).toHaveLength(2);
    h.ack = true;
    await tickAt(keeper, h, t + 2 * SEC + GATE_REDIAL_MS);
    expect(h.opened).toHaveLength(3);
    await tickAt(keeper, h, t + 3 * SEC + GATE_REDIAL_MS);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t }));
    // Both ends agree, and the ferry flies on: the session hangs up.
    await tickAt(keeper, h, t + 4 * SEC + GATE_REDIAL_MS);
    await tickAt(keeper, h, t + 5 * SEC + GATE_REDIAL_MS);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(3);
  });

  it('reads a dock never acknowledged back from a fresh session: one that never landed is let go and made again', async () => {
    const { h, deps } = harness({ replica: true });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    h.ack = false;
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(h.closes).toBe(1);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    h.ack = true;
    await tickAt(keeper, h, D0 + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, D0 + 2 * SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    const freed = D0 + 2 * SEC + GATE_STALE_MS;
    await tickAt(keeper, h, freed);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(freed));
    await tickAt(keeper, h, freed + SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(freed + SEC));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(freed + SEC));
  });

  it('reads a dock never acknowledged back from a fresh session: one that landed after all stands', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    h.ack = false;
    await tickAt(keeper, h, D0);
    expect(h.closes).toBe(1);
    h.ack = true;
    await tickAt(keeper, h, D0 + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, D0 + 2 * SEC);
    await tickAt(keeper, h, D0 + 3 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
  });

  // Copilot (PR 204): the gate is read whatever its setting, so a claim at
  // a gate switched off while it settles is seen, and taken back.
  // Copilot (PR 204): a dock counts only while both ends hold it.
  it("lets the ferry's port go once another ship has taken its gate while the dock was asked", async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    const other = dockOf(T0, { room: 'ship-2' });
    let n = 0;
    h.wait = async () => { if (++n === 2) h.station.getMap('doors').set('x+', other); };
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    expect(h.notes).toEqual([]);
    h.wait = instant;
    await tickAt(keeper, h, D0 + SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(other);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(
      buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: D0 + SEC }),
    );
  });

  // Copilot (PR 204): a station move, a tow or this room's flight that
  // starts while a claim settles docks nothing.
  it("takes a claim back when a station move or the room's flight locks the dock while it settles", async () => {
    for (const lock of ['move', 'flight'] as const) {
      const { h, deps } = harness();
      let locked = false;
      const keeper = createGateKeeper({
        ...deps,
        dockLocked: (rooms) => locked && lock === 'move' && rooms.includes(HERE) && rooms.includes(FERRY),
        mayPair: () => !(locked && lock === 'flight'),
      });
      await tickAt(keeper, h, ARRIVE + SEC);
      h.wait = async () => { locked = true; };
      await tickAt(keeper, h, D0);
      expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(D0 + 1));
      expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
      expect(h.notes).toEqual([]);
    }
  });

  // Copilot (PR 204): a watch whose ferry stops calling here by its port
  // still settles what it left under way at a gate.
  it('settles a claim at its gate after the ferry stops calling here, then forgets it', async () => {
    // A newer route that leaves this room out, or an entry the capped map
    // evicted.
    const elsewhere = entry({ route: running({ stops: [stop(0, 0), stop(2, 2)] }) });
    for (const later of [[elsewhere], []]) {
      const { h, deps } = harness({ gateRec: dockOf(ARRIVE + 2 * SEC) });
      let entries: DepartureFerry[] | null = null;
      const keeper = createGateKeeper({ ...deps, ferries: () => entries ?? [h.entry] });
      const t = ARRIVE + 3 * SEC;
      await tickAt(keeper, h, t);
      expect(h.opened).toEqual([seed(FERRY)]);
      entries = later;
      await tickAt(keeper, h, t + SEC);
      await tickAt(keeper, h, t + SEC + GATE_STALE_MS);
      expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t + SEC + GATE_STALE_MS));
      await tickAt(keeper, h, t + 2 * SEC + GATE_STALE_MS);
      expect(keeper.sessions()).toEqual([]);
      expect(h.opened).toHaveLength(1);
      expect(h.closes).toBe(1);
    }
  });

  it("settles a claim by the port it was made with, while a newer route's port gets a watch of its own", async () => {
    const { h, deps } = harness({ gateRec: dockOf(ARRIVE + 2 * SEC) });
    // Gate 2 remembers the ferry docked by its other port, y+.
    const byY = buildDoorTombstone(seed(FERRY), { farDoor: 'y+', farWall: 'y+', farLateral: 0, undockedAt: T0 - HOUR });
    h.station.getMap('doors').set('y-', byY);
    const keeper = createGateKeeper(deps);
    const t = ARRIVE + 3 * SEC;
    await tickAt(keeper, h, t);
    expect(h.opened).toEqual([seed(FERRY)]);
    // A newer route docks by y+ and stays here longer; its riders told this
    // board.
    const next = running({ shipPort: 'y+', stops: [stop(0, 0), stop(1, 1, { waitSecs: 600 })] });
    h.ferry.getMap('ship').set('route', routeToWire(next));
    h.entry = entry({ route: next });
    await tickAt(keeper, h, t + SEC);
    await tickAt(keeper, h, t + SEC + GATE_STALE_MS);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t + SEC + GATE_STALE_MS));
    // The old port's watch is done with, and the new port's opens a session
    // of its own.
    await tickAt(keeper, h, t + 2 * SEC + GATE_STALE_MS);
    expect(h.closes).toBe(1);
    expect(h.opened).toEqual([seed(FERRY), seed(FERRY)]);
    expect(readDoorFrom(h.station, 'y-')).toEqual(byY);
  });

  it("makes a cast-off the ferry's room never took again after its entry here is gone", async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0), replica: true });
    let entries: DepartureFerry[] | null = null;
    const keeper = createGateKeeper({ ...deps, ferries: () => entries ?? [h.entry] });
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    h.ack = false;
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    await tickAt(keeper, h, t);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    // The capped map evicted its entry; the ferry's room answers again.
    entries = [];
    h.ack = true;
    await tickAt(keeper, h, t + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, t + 2 * SEC);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t }));
    await tickAt(keeper, h, t + 3 * SEC);
    await tickAt(keeper, h, t + 4 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
  });

  it('takes a claim back at a gate whose AUTO-DOCK is switched off while it settles', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    h.wait = async () => { h.auto.delete('x+'); };
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(D0 + 1));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  // Copilot (PR 204): a gate that takes another pairing never gives it up,
  // so the ferry's port lets go, even when no other gate is free.
  it('lets the ferry go from its gate once another ship holds it, with no other gate free', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, D0 + SEC);
    await tickAt(keeper, h, D0 + 2 * SEC);
    await tickAt(keeper, h, D0 + 3 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(1);
    // The gate let the ferry go (its word never reached the ferry), and
    // another ship docked there.
    h.station.getMap('doors').set('x+', dockOf(D0 + 10 * SEC, { room: 'ship-2' }));
    await tickAt(keeper, h, D0 + 11 * SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, D0 + 12 * SEC);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: D0 + 12 * SEC }));
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0 + 10 * SEC, { room: 'ship-2' }));
    // Both ends agree: nothing is left to settle, and no gate is free.
    await tickAt(keeper, h, D0 + 13 * SEC);
    await tickAt(keeper, h, D0 + 14 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
  });

  // Copilot (PR 204): what the keeper left under way at a gate is settled
  // after its AUTO-DOCK is switched off, the room's last one included.
  it('makes a cast-off the ferry never took again after the gate is switched off', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0), replica: true });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    h.ack = false;
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    await tickAt(keeper, h, t);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    expect(h.closes).toBe(1);
    h.auto.delete('x+');
    h.ack = true;
    await tickAt(keeper, h, t + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, t + 2 * SEC);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t }));
    await tickAt(keeper, h, t + 3 * SEC);
    await tickAt(keeper, h, t + 4 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
  });

  // Copilot (PR 204): the gate's port taken off before the retry of a
  // cast-off the ferry never took: the ferry's port still lets go.
  it("lets the ferry's port go once the gate's port is taken off while a cast-off is unacknowledged", async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0), replica: true });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    h.ack = false;
    const t = DEPART + GATE_CAST_OFF_DEFER_MS;
    await tickAt(keeper, h, t);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(t));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
    // The owner takes the gate's port off (docking.ts removeDockPort): a
    // plain tombstone, and AUTO-DOCK goes with the port.
    h.station.getMap('doors').set('x+', buildDoorTombstone(seed(FERRY)));
    h.auto.delete('x+');
    h.ack = true;
    await tickAt(keeper, h, t + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, t + 2 * SEC);
    expect(readDoorFrom(h.ferry, PORT))
      .toEqual(buildDoorTombstone(seed(HERE), { farDoor: 'x+', farWall: 'x+', farLateral: 0, undockedAt: t + 2 * SEC }));
    expect(readDoorFrom(h.station, 'x+')).toEqual(buildDoorTombstone(seed(FERRY)));
    await tickAt(keeper, h, t + 3 * SEC);
    await tickAt(keeper, h, t + 4 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(h.closes).toBe(2);
  });

  // Copilot (PR 204): a DOCK refuses a berth where the module would land on
  // another one of the station, and so does the station's keeper.
  it('docks at the next gate when the ferry would overlap a module at its own, and says why when every gate would', async () => {
    const { h, deps } = harness();
    const clash = new Map<string, string>([['x+', 'Cargo Bay'], ['y-', 'Hab Ring']]);
    const asked: Array<[string, unknown]> = [];
    const keeper = createGateKeeper({
      ...deps,
      overlap: (doorId, ferry) => {
        asked.push([doorId, ferry]);
        return clash.get(doorId) ?? null;
      },
    });
    await tickAt(keeper, h, ARRIVE + SEC);
    await tickAt(keeper, h, D0);
    // Posed as this room remembers the ferry's port.
    const pose = { roomId: FERRY, farWall: 'x-', farLateral: 0 };
    expect(asked).toEqual([['x+', pose], ['y-', pose]]);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(T0 - HOUR));
    expect(readDoorFrom(h.station, 'y-')).toBeUndefined();
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    expect(h.notes).toEqual([['x+', "Can't dock FERRY ONE here: it would overlap Cargo Bay.", 'bad']]);
    // Gate 2 is clear now: the next pass docks there.
    clash.delete('y-');
    const t = D0 + KEEPER_RETRY_MS;
    await tickAt(keeper, h, t - SEC);
    expect(readDoorFrom(h.station, 'y-')).toBeUndefined();
    await tickAt(keeper, h, t);
    expect(readDoorFrom(h.station, 'y-')).toEqual(dockOf(t));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(t, 'y-'));
    expect(h.notes.at(-1)).toEqual(['y-', 'Docked FERRY ONE automatically.', 'ok']);
  });

  it('docks nothing where the overlap check fails', async () => {
    const { h, deps } = harness();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const keeper = createGateKeeper({ ...deps, overlap: () => { throw new Error('no atlas'); } });
      await tickAt(keeper, h, ARRIVE + SEC);
      await tickAt(keeper, h, D0);
    } finally {
      console.warn = warn;
    }
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(T0 - HOUR));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    expect(h.notes).toEqual([['x+', "Can't dock FERRY ONE here: it would overlap another module.", 'bad']]);
  });

  it('lets go of a claim the ferry never took at a gate switched off, and docks nothing more there', async () => {
    const { h, deps } = harness({ replica: true });
    h.auto = new Set(['x+']);
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    h.ack = false;
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(h.closes).toBe(1);
    h.auto.delete('x+');
    h.ack = true;
    await tickAt(keeper, h, D0 + SEC);
    expect(h.opened).toHaveLength(2);
    await tickAt(keeper, h, D0 + 2 * SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    const freed = D0 + 2 * SEC + GATE_STALE_MS;
    await tickAt(keeper, h, freed);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(freed));
    await tickAt(keeper, h, freed + SEC);
    await tickAt(keeper, h, freed + 2 * SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(freed));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  it('docks at no other gate while one switched off still claims the ferry', async () => {
    const { h, deps } = harness({ replica: true });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    h.ack = false;
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    h.auto.delete('x+');
    h.ack = true;
    await tickAt(keeper, h, D0 + SEC);
    expect(h.opened).toHaveLength(2);
    // Its claim may yet land on the ferry's side: y- stays free meanwhile,
    // past the keeper's next pass too.
    await tickAt(keeper, h, D0 + 2 * SEC);
    await tickAt(keeper, h, D0 + 2 * SEC + KEEPER_RETRY_MS);
    await tickAt(keeper, h, D0 + 3 * SEC + KEEPER_RETRY_MS);
    expect(readDoorFrom(h.station, 'y-')).toBeUndefined();
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
  });

  it('leaves a dock at a gate switched off to people: no cast-off there', async () => {
    const { h, deps } = harness({ port: portDockedAt(D0), gateRec: dockOf(D0) });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, D0 + SEC);
    await tickAt(keeper, h, D0 + 2 * SEC);
    h.auto.delete('x+');
    await tickAt(keeper, h, DEPART - GATE_PRE_DIAL_MS + SEC);
    await tickAt(keeper, h, DEPART + GATE_CAST_OFF_DEFER_MS);
    await tickAt(keeper, h, DEPART + GATE_CAST_OFF_DEFER_MS + SEC);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(portDockedAt(D0));
  });

  // Copilot (PR 204): a dock's awaits can outlast a reset (the player left
  // and came straight back to the same room); nothing it does after reaches
  // either end, and the next keeper settles the claim it left.
  it('writes nothing more for a dock under way once the keeper has reset', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    let settle: () => void = () => {};
    h.wait = () => new Promise<void>((r) => { settle = r; });
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    keeper.reset();
    h.wait = instant;
    settle();
    await flush();
    expect(readDoorFrom(h.station, 'x+')).toEqual(dockOf(D0));
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    // The claim is unsettled: the keeper watches it at once.
    await tickAt(keeper, h, D0 + SEC);
    expect(keeper.sessions()).toEqual([FERRY]);
  });

  // Copilot (PR 204): the berthing and the gates' claims are the entry's
  // port's, so a newer route on another port waits until this board has it.
  it("docks nothing while the ferry's own route names another port than this board's entry", async () => {
    const { h, deps } = harness();
    h.ferry.getMap('ship').set('route', routeToWire({ ...R, shipPort: 'y-' }));
    h.ferry.getMap('doorLayout').set('y-', { id: 'y-', wall: 'y-', lateral: 0, placed: true });
    h.ferry.getMap('doorPolicy').set('y-', { passage: 'public', construction: 'owner', adapter: true });
    const keeper = createGateKeeper(deps);
    await tickAt(keeper, h, ARRIVE + SEC);
    await tickAt(keeper, h, D0);
    // The session told this board of the new port, and docked nothing.
    expect(h.entry.route.shipPort).toBe('y-');
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(T0 - HOUR));
    expect(readDoorFrom(h.ferry, 'y-')).toBeUndefined();
    // That port never docked in this room, so nothing here can pose it.
    await tickAt(keeper, h, D0 + SEC);
    expect(keeper.sessions()).toEqual([]);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(T0 - HOUR));
  });

  it('docks nothing while this room may not pair, and replaces a session held GATE_SESSION_MAX_MS', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper({ ...deps, mayPair: () => false });
    await tickAt(keeper, h, ARRIVE + SEC);
    expect(h.opened).toHaveLength(1);
    await tickAt(keeper, h, D0);
    expect(readDoorFrom(h.station, 'x+')).toEqual(memoryOf(T0 - HOUR));
    await tickAt(keeper, h, ARRIVE + SEC + GATE_SESSION_MAX_MS);
    expect(h.closes).toBe(1);
    await tickAt(keeper, h, ARRIVE + 2 * SEC + GATE_SESSION_MAX_MS);
    expect(h.opened).toHaveLength(2);
    expect(readDoorFrom(h.ferry, PORT)).toEqual(leftStop0());
    keeper.reset();
    expect(h.closes).toBe(2);
    expect(keeper.sessions()).toEqual([]);
  });

  it('keeps a session past GATE_SESSION_MAX_MS while the departure is near', async () => {
    const { h, deps } = harness();
    const keeper = createGateKeeper({ ...deps, mayPair: () => false });
    await tickAt(keeper, h, DEPART - GATE_SESSION_MAX_MS - 20 * SEC);
    expect(h.opened).toHaveLength(1);
    await tickAt(keeper, h, DEPART - 20 * SEC);
    expect(h.closes).toBe(0);
    expect(keeper.sessions()).toEqual([FERRY]);
    // Not docked here, the guard band before its departure ends it.
    await tickAt(keeper, h, DEPART - GUARD_BAND_MS);
    expect(h.closes).toBe(1);
    expect(keeper.sessions()).toEqual([]);
  });
});
