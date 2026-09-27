/**
 * 🚏🧑‍✈️ Helm route — the helm's ROUTE panel and a person flying the route
 * (design §2b, §5): the words and clocks, the stops the editor offers (only
 * gates this ship may use, in arrival order, then the remembered berth and
 * the live dock), the local draft, the editor's refusals (same station,
 * shared orbit, other planet, a leg or — with the home refill — a round trip
 * costing more than the tanks hold), START's refusals, what the running panel
 * offers (DEPART opening 30 s before the window, the guard band keying of
 * TAKE / HAND / KEEP / SKIP), the checklist and FLIGHT PLAN lines, and the
 * writers over a real ship doc: START in one transaction, a person's DEPART
 * (go + in-flight), DEPART off route pausing (fuel and flight copied), RESUME
 * (the ceiling first), the handover, SKIP and STOP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { GUARD_BAND_MS, ROBOT_TAKEOVER_MS, helmCheckpoint, routeLegFuel, stopPairWindow } from './pilotRoute';
import type { RouteFlight } from './pilotRoute';
import { bindShipDoc, readFlightRecord, readFuelLevel, setFuelDrawMeter, shipDocHandle, writeFlightRecord, writeFuelLevel } from './shipDoc';
import {
  ROUTE_FUEL_METER,
  installRouteFlight,
  readRouteCheckpoints,
  readRouteFlight,
  readShipRoute,
} from './shipRoute';
import type { RouteStop, ShipRoute } from './shipRoute';
import { adriftAt } from './stationDirectory';
import { listStations, planetById } from './stations';
import type { StationBerthRecord } from './stations';
import {
  DEFAULT_WAIT_SECS,
  ROUTE_DEPART_OPENS_MS,
  ROUTE_WAIT_CHOICES,
  addDraftStop,
  checkRouteDraft,
  choiceIndexFor,
  departRouteFromHelm,
  describeGateChoice,
  describeRouteProblem,
  describeRouteStartRefusal,
  draftFromRoute,
  draftLegAfter,
  formatClock,
  formatRouteSpan,
  formatWait,
  goneWords,
  handOverRoute,
  helmEntryStay,
  isShipPilotRoutine,
  moveDraftStop,
  nextLegPilot,
  pauseRouteFromHelm,
  readHelmCheckpoints,
  refreshDraftStops,
  removeDraftStop,
  resumeRouteFromHelm,
  resumeStopIndex,
  routeDepartLine,
  routeDepartState,
  routeEndStopIndex,
  routeFromDraft,
  routeHelmView,
  routeNoteStands,
  routePathLabel,
  routeRenderKey,
  routeStartRefusal,
  routeStatusLine,
  routeStopCandidates,
  routeStopIndexAt,
  setDraftAnyGate,
  setDraftBerth,
  setDraftWait,
  skipRouteStop,
  startRouteFromHelm,
  stopRouteFromHelm,
} from './helmRoute';
import type { RouteDraft, RouteStartInput, RouteStationLike, RouteStopCandidate } from './helmRoute';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const CAP = 100;

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

function saved(slots: number[] = [0, 1], over: Partial<ShipRoute> = {}): ShipRoute {
  return {
    stops: slots.map((s, i) => stop(i, s)),
    shape: 'backAndForth',
    shipPort: 'x-',
    robotDockId: 'dock-1',
    homeRefuel: true,
    ...over,
  };
}

function draft(slots: number[] = [0, 1], over: Partial<RouteDraft> = {}): RouteDraft {
  return { stops: slots.map((s, i) => stop(i, s)), shape: 'backAndForth', shipPort: 'x-', robotDockId: null, homeRefuel: true, ...over };
}

/** A docked stay of a person-flown route, figures made up (pure tests). */
function flight(over: Partial<RouteFlight> = {}): RouteFlight {
  return {
    status: 'docked',
    locationId: 'st-0',
    legSeq: 4,
    stopIndex: 0,
    nextStopIndex: 1,
    stayStart: T0,
    departsAt: T0 + 5 * MIN,
    scheduledAt: T0 + 5 * MIN,
    arrivesAt: T0 + 6 * MIN,
    holding: false,
    holdSince: null,
    overdue: false,
    skipped: false,
    gone: false,
    goneStops: [],
    takeoverAt: null,
    pilot: 'person',
    fuel: 50,
    paused: false,
    stopping: false,
    ended: null,
    ...over,
  };
}

function station(i: number, slot: number, over: Partial<RouteStationLike> = {}): RouteStationLike {
  return { id: `st-${i}`, name: `Stop ${i}`, planetId: SOV, orbitSlot: slot, welcomeRoomId: `room-${i}`, ...over };
}

function countUpdates(doc: Y.Doc): { readonly n: number } {
  const c = { n: 0 };
  doc.on('update', () => { c.n++; });
  return c;
}

let doc: Y.Doc;
let clock = T0;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  doc = new Y.Doc();
  bindShipDoc(doc);
  clock = T0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setFuelDrawMeter(ROUTE_FUEL_METER, null);
  warn.mockRestore();
});

// ── Words and clocks ─────────────────────────────────────────────────────────

describe('words and clocks', () => {
  it('formatClock shows local HH:MM:SS rounded down, and dashes for no time', () => {
    expect(formatClock(new Date(2026, 8, 27, 14, 5, 17, 900).getTime())).toBe('14:05:17');
    expect(formatClock(new Date(2026, 8, 27, 9, 0, 3).getTime())).toBe('09:00:03');
    expect(formatClock(null)).toBe('--:--:--');
    expect(formatClock(Number.NaN)).toBe('--:--:--');
  });

  it('formatRouteSpan reads seconds, minutes, hours and days', () => {
    expect(formatRouteSpan(55 * SEC)).toBe('55 s');
    expect(formatRouteSpan(89 * SEC)).toBe('89 s');
    expect(formatRouteSpan(324 * SEC)).toBe('5.4 min');
    expect(formatRouteSpan(15 * MIN)).toBe('15 min');
    expect(formatRouteSpan(9.8 * 60 * MIN)).toBe('9.8 h');
    expect(formatRouteSpan(3 * 24 * 60 * MIN)).toBe('3 d');
    expect(formatRouteSpan(-5 * SEC)).toBe('0 s');
  });

  it('formatWait covers the choices, 30 s to 10 min', () => {
    expect(ROUTE_WAIT_CHOICES[0]).toBe(30);
    expect(ROUTE_WAIT_CHOICES[ROUTE_WAIT_CHOICES.length - 1]).toBe(600);
    expect(ROUTE_WAIT_CHOICES).toContain(DEFAULT_WAIT_SECS);
    expect(ROUTE_WAIT_CHOICES.map(formatWait)).toEqual(['30 s', '45 s', '1 min', '1.5 min', '2 min', '3 min', '4 min', '5 min', '7 min', '10 min']);
  });

  it('routePathLabel draws one full cycle of the shape', () => {
    const n = (...names: string[]) => names.map((name) => ({ name }));
    expect(routePathLabel([], 'loop')).toBe('—');
    expect(routePathLabel(n('A'), 'loop')).toBe('A');
    expect(routePathLabel(n('A', 'B'), 'backAndForth')).toBe('A→B→A');
    expect(routePathLabel(n('A', 'B'), 'loop')).toBe('A→B→A');
    expect(routePathLabel(n('A', 'B', 'C'), 'loop')).toBe('A→B→C→A');
    expect(routePathLabel(n('A', 'B', 'C'), 'backAndForth')).toBe('A→B→C→B→A');
  });

  it('the robot captain routine is only the Ship pilot routine', () => {
    expect(isShipPilotRoutine('pilot')).toBe(true);
    expect(isShipPilotRoutine('clean')).toBe(false);
    expect(isShipPilotRoutine(null)).toBe(false);
    expect(isShipPilotRoutine(undefined)).toBe(false);
  });
});

// ── The stops the editor offers ──────────────────────────────────────────────

describe('routeStopCandidates', () => {
  const SHIP = 'ship-room';
  const gates: StationBerthRecord[] = [
    { roomId: 'room-1a', doorId: 'x+', gate: 1 },
    { roomId: 'room-1b', doorId: 'x+', gate: 2, access: 'closed' },
    { roomId: 'room-1c', doorId: 'x+', gate: 3, access: 'reserved', reservedFor: 'another-ship' },
    { roomId: 'room-1d', doorId: 'x+', gate: 4, access: 'pass', occupied: true },
    { roomId: 'room-1e', doorId: 'x+', gate: 5, access: 'reserved', reservedFor: SHIP },
    { roomId: 'room-1f', doorId: 'y-' },
    { roomId: 'room-1g', doorId: 'not a door' },
    { roomId: 'room-1a', doorId: 'x+', gate: 1 },
  ];
  const stations: RouteStationLike[] = [
    station(2, 4),
    station(1, 1, { berths: gates }),
    station(9, 2, { planetId: 'planet-other' }),
    station(3, 3),
  ];

  it('lists the stations around the planet in orbit order, and only gates this ship may use, in arrival order', () => {
    const c = routeStopCandidates({ stations, planetId: SOV, shipRoomId: SHIP, holdsPass: (r) => r !== 'room-1d' });
    expect(c.map((x) => x.stationId)).toEqual(['st-1', 'st-3', 'st-2']);
    const st1 = c[0];
    expect(st1.choices.map((x) => x.berth.roomId)).toEqual(['room-1e', 'room-1a', 'room-1f', 'room-1d']);
    expect(st1.choices[0]).toEqual({ berth: { roomId: 'room-1e', farDoor: 'x+', gate: 5 }, source: 'gate', access: 'reserved', held: true });
    expect(st1.choices[1]).toEqual({ berth: { roomId: 'room-1a', farDoor: 'x+', gate: 1 }, source: 'gate', held: true });
    expect(st1.choices[2]).toEqual({ berth: { roomId: 'room-1f', farDoor: 'y-' }, source: 'berth', held: true });
    expect(st1.choices[3]).toEqual({ berth: { roomId: 'room-1d', farDoor: 'x+', gate: 4 }, source: 'gate', access: 'pass', occupied: true, held: false });
    // A station with no known berth is listed with no choice (fly there by hand once).
    expect(c[1].choices).toEqual([]);
    // Never a pass in the route's copy.
    for (const ch of st1.choices) expect(ch.berth).not.toHaveProperty('anyGate');
  });

  it('adds the remembered berth and the live dock after the gates, never one the station refuses or already lists', () => {
    const remembered = (id: string) => (id === 'st-1' ? { roomId: 'room-1b', farDoor: 'x+' } : id === 'st-3' ? { roomId: 'room-3', farDoor: 'y+', farWall: 'y+' as const } : null);
    const c = routeStopCandidates({
      stations,
      planetId: SOV,
      shipRoomId: SHIP,
      remembered,
      liveDock: { stationId: 'st-1', roomId: 'room-1h', farDoor: 'y+' },
    });
    const st1 = c.find((x) => x.stationId === 'st-1')!;
    // The memory points at the closed gate 2: not offered.
    expect(st1.choices.some((x) => x.berth.roomId === 'room-1b')).toBe(false);
    // 🧭 The berth the ship is docked in comes first: the editor's default.
    expect(st1.choices[0]).toEqual({ berth: { roomId: 'room-1h', farDoor: 'y+' }, source: 'dock', held: true });
    expect(st1.choices.slice(1).map((x) => x.berth.roomId)).toEqual(['room-1e', 'room-1a', 'room-1f', 'room-1d']);
    const st3 = c.find((x) => x.stationId === 'st-3')!;
    expect(st3.choices).toEqual([{ berth: { roomId: 'room-3', farDoor: 'y+', farWall: 'y+' }, source: 'memory', held: true }]);
    // A live dock that is a listed gate is not listed twice; it comes first.
    const again = routeStopCandidates({ stations, planetId: SOV, shipRoomId: SHIP, liveDock: { stationId: 'st-1', roomId: 'room-1a', farDoor: 'x+' } });
    expect(again[0].choices.filter((x) => x.berth.roomId === 'room-1a')).toHaveLength(1);
    expect(again[0].choices[0]).toMatchObject({ berth: { roomId: 'room-1a', gate: 1 }, source: 'gate' });
    // 🧭 Docked in a gate the atlas shows taken: taken by this ship, so not
    // "taken now", and first.
    const inFour = routeStopCandidates({ stations, planetId: SOV, shipRoomId: SHIP, liveDock: { stationId: 'st-1', roomId: 'room-1d', farDoor: 'x+' } });
    expect(inFour[0].choices[0]).toEqual({ berth: { roomId: 'room-1d', farDoor: 'x+', gate: 4 }, source: 'gate', access: 'pass', held: true });
    expect(describeGateChoice(inFour[0].choices[0])).not.toContain('taken now');
  });

  it('describes each choice and finds a berth among them', () => {
    const c = routeStopCandidates({ stations, planetId: SOV, shipRoomId: SHIP, holdsPass: (r) => r !== 'room-1d' })[0].choices;
    expect(c.map(describeGateChoice)).toEqual([
      'Gate 5 · reserved for this ship',
      'Gate 1',
      'Berth door',
      'Gate 4 · needs a granted rider aboard · taken now · no pass',
    ]);
    expect(describeGateChoice({ berth: { roomId: 'r', farDoor: 'x+' }, source: 'memory', held: true })).toBe('Remembered berth');
    expect(describeGateChoice({ berth: { roomId: 'r', farDoor: 'x+' }, source: 'dock', held: true })).toBe('The berth docked at now');
    expect(choiceIndexFor(c, { roomId: 'room-1f', farDoor: 'y-' })).toBe(2);
    expect(choiceIndexFor(c, { roomId: 'room-1f', farDoor: 'x+' })).toBe(-1);
  });
});

// ── The draft ────────────────────────────────────────────────────────────────

describe('the draft', () => {
  const cand = (i: number, slot: number): RouteStopCandidate => ({
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    choices: [
      { berth: { roomId: `room-${i}`, farDoor: 'x+', gate: 1 }, source: 'gate', held: true },
      { berth: { roomId: `room-${i}b`, farDoor: 'y-', gate: 2 }, source: 'gate', held: true },
    ],
  });

  it('starts from the saved route, or a new back-and-forth with the home refill', () => {
    expect(draftFromRoute(null, 'x-')).toEqual({ stops: [], shape: 'backAndForth', shipPort: 'x-', robotDockId: null, homeRefuel: true });
    const r = saved([0, 1], { shape: 'loop', robotDockId: undefined, homeRefuel: false });
    const d = draftFromRoute(r, 'y+');
    expect(d).toEqual({ stops: r.stops, shape: 'loop', shipPort: 'x-', robotDockId: null, homeRefuel: false });
    // A copy: editing the draft leaves the route alone.
    d.stops[0].berth.anyGate = false;
    expect(r.stops[0].berth.anyGate).toBe(true);
  });

  it('turns into a route to save, with no run fields; none without a port', () => {
    const d = draft([0, 1], { robotDockId: 'dock-1' });
    expect(routeFromDraft(d)).toEqual({ stops: d.stops, shape: 'backAndForth', shipPort: 'x-', robotDockId: 'dock-1', homeRefuel: true });
    expect(routeFromDraft({ ...d, robotDockId: null })).not.toHaveProperty('robotDockId');
    expect(routeFromDraft({ ...d, shipPort: null })).toBeNull();
  });

  it('adds, removes and reorders stops; a full route or a station with no berth adds nothing', () => {
    let d = draft([]);
    d = addDraftStop(d, cand(0, 0));
    d = addDraftStop(d, cand(1, 1), 1);
    expect(d.stops).toEqual([
      { stationId: 'st-0', name: 'Stop 0', planetId: SOV, orbitSlot: 0, berth: { roomId: 'room-0', farDoor: 'x+', gate: 1, anyGate: true }, waitSecs: DEFAULT_WAIT_SECS },
      { stationId: 'st-1', name: 'Stop 1', planetId: SOV, orbitSlot: 1, berth: { roomId: 'room-1b', farDoor: 'y-', gate: 2, anyGate: true }, waitSecs: DEFAULT_WAIT_SECS },
    ]);
    expect(addDraftStop(d, { ...cand(2, 2), choices: [] })).toBe(d);
    expect(moveDraftStop(d, 0, 1).stops.map((s) => s.stationId)).toEqual(['st-1', 'st-0']);
    expect(moveDraftStop(d, 0, -1)).toBe(d);
    expect(removeDraftStop(d, 0).stops.map((s) => s.stationId)).toEqual(['st-1']);
    expect(removeDraftStop(d, 5)).toBe(d);
    let full = draft([]);
    for (let i = 0; i < 8; i++) full = addDraftStop(full, cand(i, i));
    expect(full.stops).toHaveLength(8);
    expect(addDraftStop(full, cand(9, 9))).toBe(full);
  });

  it('sets a clamped wait, a berth that keeps its pin, and the pin', () => {
    const d = draft([0, 1]);
    expect(setDraftWait(d, 0, 10).stops[0].waitSecs).toBe(30);
    expect(setDraftWait(d, 0, 9999).stops[0].waitSecs).toBe(600);
    expect(setDraftWait(d, 1, 90.4).stops[1].waitSecs).toBe(90);
    expect(setDraftWait(d, 0, Number.NaN)).toBe(d);
    const pinned = setDraftAnyGate(d, 1, false);
    expect(pinned.stops[1].berth.anyGate).toBe(false);
    expect(d.stops[1].berth.anyGate).toBe(true);
    const moved = setDraftBerth(pinned, 1, { berth: { roomId: 'room-1b', farDoor: 'y-', gate: 2 }, source: 'gate', held: true });
    expect(moved.stops[1].berth).toEqual({ roomId: 'room-1b', farDoor: 'y-', gate: 2, anyGate: false });
    expect(setDraftBerth(d, 7, cand(0, 0).choices[0])).toBe(d);
  });

  it('refreshDraftStops copies orbit, name and gate number afresh (through the alias), and keeps a stop the list no longer shows', () => {
    const d = draft([0, 1]);
    const out = refreshDraftStops(d, [
      station(0, 3, { id: 'local-0', name: 'Renamed', berths: [{ roomId: 'room-0', doorId: 'x+', gate: 7 }] }),
    ], (id) => (id === 'st-0' ? 'local-0' : id));
    expect(out.stops[0]).toMatchObject({ stationId: 'st-0', name: 'Renamed', orbitSlot: 3, berth: { roomId: 'room-0', farDoor: 'x+', gate: 7, anyGate: true } });
    expect(out.stops[1]).toEqual(d.stops[1]);
    expect(d.stops[0].orbitSlot).toBe(0);
  });
});

// ── Checks ───────────────────────────────────────────────────────────────────

describe('checkRouteDraft', () => {
  const leg01 = stopPairWindow([stop(0, 0), stop(1, 1)], 0, 1)!;

  it('a flyable ferry passes, with its round-trip fuel', () => {
    const c = checkRouteDraft(draft([0, 1]), { capacity: CAP });
    expect(c).toEqual({ ok: true, problems: [], cycleFuel: 2 * leg01.fuelCost });
    expect(leg01.fuelCost).toBe(routeLegFuel(saved(), 0, 1));
  });

  it('refuses too few stops, no port and no tank', () => {
    const c = checkRouteDraft(draft([0], { shipPort: null }), { capacity: 0 });
    expect(c.ok).toBe(false);
    expect(c.problems.map((p) => p.kind)).toEqual(['too-few-stops', 'no-port', 'no-tank']);
    expect(c.cycleFuel).toBeNull();
  });

  it('refuses the same station twice in a row, another planet, and a shared orbit, each pair once', () => {
    const same = draft([0, 1]);
    same.stops[1] = { ...stop(0, 1), name: 'Again' };
    expect(checkRouteDraft(same, { capacity: CAP }).problems).toEqual([{ kind: 'same-station', from: 0, to: 1 }]);
    const planet = draft([0, 1]);
    planet.stops[1].planetId = 'planet-other';
    expect(checkRouteDraft(planet, { capacity: CAP }).problems).toEqual([{ kind: 'other-planet', from: 0, to: 1 }]);
    const shared = checkRouteDraft(draft([0, 0]), { capacity: CAP });
    expect(shared.problems).toEqual([{ kind: 'shared-orbit', from: 0, to: 1 }]);
    expect(shared.cycleFuel).toBeNull();
    // A loop closes back to the first stop: 0 → 1 → 2 → 0 with 2 sharing 0's orbit.
    expect(checkRouteDraft(draft([0, 1, 0], { shape: 'loop' }), { capacity: CAP }).problems)
      .toEqual([{ kind: 'shared-orbit', from: 2, to: 0 }]);
  });

  it('refuses a leg that burns more than the tanks hold, and with the home refill a round trip too', () => {
    const leg = checkRouteDraft(draft([0, 1]), { capacity: leg01.fuelCost - 1 });
    expect(leg.problems).toEqual([{ kind: 'leg-too-costly', from: 0, to: 1, fuel: leg01.fuelCost, capacity: leg01.fuelCost - 1 }]);
    const cycle = checkRouteDraft(draft([0, 1]), { capacity: leg01.fuelCost + 1 });
    expect(cycle.problems).toEqual([{ kind: 'cycle-too-costly', fuel: 2 * leg01.fuelCost, capacity: leg01.fuelCost + 1 }]);
    // Without the home refill, each stop's REFUEL is the captain's: legs only.
    expect(checkRouteDraft(draft([0, 1], { homeRefuel: false }), { capacity: leg01.fuelCost + 1 }).ok).toBe(true);
  });

  it('draftLegAfter shows the leg leaving each stop as the editor lists it', () => {
    const d = draft([0, 1, 2]);
    expect(draftLegAfter(d, 0)).toMatchObject({ to: 1, problem: null });
    expect(draftLegAfter(d, 0)!.window).toEqual(stopPairWindow(d.stops, 0, 1));
    expect(draftLegAfter(d, 2)).toBeNull();
    expect(draftLegAfter({ ...d, shape: 'loop' }, 2)).toMatchObject({ to: 0, problem: null });
    expect(draftLegAfter(draft([0, 0]), 0)).toEqual({ to: 1, window: null, problem: 'shared-orbit' });
    expect(draftLegAfter(draft([0]), 0)).toBeNull();
  });

  it('describes each problem by stop name', () => {
    const names = [{ name: 'Alpha' }, { name: 'Beta' }];
    expect(describeRouteProblem({ kind: 'shared-orbit', from: 0, to: 1 }, names)).toBe('Alpha → Beta: they share an orbit, so no transfer exists.');
    expect(describeRouteProblem({ kind: 'leg-too-costly', from: 1, to: 0, fuel: 123, capacity: 100 }, names))
      .toBe('Beta → Alpha burns 123 fuel; the tanks hold 100. Fit more fuel tanks.');
    expect(describeRouteProblem({ kind: 'cycle-too-costly', fuel: 132, capacity: 100 }, names)).toContain('free refill is only at Alpha');
  });
});

// ── START ────────────────────────────────────────────────────────────────────

describe('START refusals', () => {
  const ok: RouteStartInput = {
    commander: true,
    running: false,
    flightCapable: true,
    flightStatus: 'docked',
    startStop: 0,
    check: { ok: true, problems: [], cycleFuel: 66 },
    portFitted: true,
    robotReady: true,
    chainedDoors: 0,
    towing: false,
    fuel: 0,
    firstLegFuel: 33,
  };

  it('is offered only to the helm gate, docked at a stop, with a valid route', () => {
    expect(routeStartRefusal({ ...ok, fuel: 40 })).toBeNull();
    expect(routeStartRefusal({ ...ok, commander: false })).toBe('no-owner');
    expect(routeStartRefusal({ ...ok, running: true })).toBe('running');
    expect(routeStartRefusal({ ...ok, flightCapable: false })).toBe('not-flight-capable');
    expect(routeStartRefusal({ ...ok, check: { ok: false, problems: [{ kind: 'too-few-stops' }], cycleFuel: null } })).toBe('invalid');
    expect(routeStartRefusal({ ...ok, portFitted: false })).toBe('port-missing');
    expect(routeStartRefusal({ ...ok, robotReady: false })).toBe('robot-not-ready');
    expect(routeStartRefusal({ ...ok, flightStatus: 'in-flight' })).toBe('not-docked');
    expect(routeStartRefusal({ ...ok, startStop: -1 })).toBe('not-at-stop');
    expect(routeStartRefusal({ ...ok, chainedDoors: 1 })).toBe('chained');
    expect(routeStartRefusal({ ...ok, towing: true })).toBe('towing');
  });

  it('the first leg flies on the fuel aboard (the home refill comes on arrival, not at START)', () => {
    expect(routeStartRefusal(ok)).toBe('no-fuel');
    expect(routeStartRefusal({ ...ok, fuel: 33 })).toBeNull();
    expect(routeStartRefusal({ ...ok, firstLegFuel: null })).toBeNull();
    expect(describeRouteStartRefusal('no-fuel', { stops: [], firstLegFuel: 33, fuel: 5 })).toBe('Not enough fuel for the first leg (33 needed, 5 aboard). REFUEL first.');
    expect(describeRouteStartRefusal('not-at-stop', { stops: [{ name: 'A' }, { name: 'B' }] })).toBe("Dock at one of the route's stops (A, B) to START there.");
  });

  it('finds the stop the ship is at (through the alias), and RESUME the soonest visit', () => {
    const r = saved([0, 1, 2]);
    expect(routeStopIndexAt(r.stops, 'st-2')).toBe(2);
    expect(routeStopIndexAt(r.stops, 'local-1', (id) => (id === 'st-1' ? 'local-1' : id))).toBe(1);
    expect(routeStopIndexAt(r.stops, 'st-9')).toBe(-1);
    // A→B→A→C→A: stop 0 is called at twice; RESUME picks the first later visit.
    const twice = { stops: [stop(0, 0), stop(1, 1), stop(0, 0), stop(2, 2)], shape: 'loop' as const };
    expect(resumeStopIndex(twice, 1, 'st-0')).toBe(2);
    expect(resumeStopIndex(twice, 3, 'st-0')).toBe(0);
    expect(resumeStopIndex(twice, 1, 'st-9')).toBe(-1);
  });
});

// ── What the running panel offers ────────────────────────────────────────────

describe('routeDepartState', () => {
  const W = T0 + 5 * MIN;

  it('boarding until 30 s before the window, then open (late: still open)', () => {
    expect(routeDepartState(flight(), W - ROUTE_DEPART_OPENS_MS - 1)).toEqual({ kind: 'boarding', opensAt: W - ROUTE_DEPART_OPENS_MS, windowAt: W });
    expect(routeDepartState(flight(), W - ROUTE_DEPART_OPENS_MS)).toEqual({ kind: 'open', windowAt: W });
    expect(routeDepartState(flight(), W + 10 * MIN)).toEqual({ kind: 'open', windowAt: W });
  });

  it('times a person from the scheduled window, even when a takeover moved departsAt', () => {
    expect(routeDepartState(flight({ departsAt: W + 7 * MIN, takeoverAt: W + 5 * MIN }), W)).toEqual({ kind: 'open', windowAt: W });
  });

  it('the robot, a hold, the end and flight have no person DEPART', () => {
    expect(routeDepartState(flight({ pilot: 'robot' }), T0)).toEqual({ kind: 'robot', departsAt: W });
    expect(routeDepartState(flight({ holding: true, departsAt: null, scheduledAt: null }), T0)).toEqual({ kind: 'holding' });
    expect(routeDepartState(flight({ ended: 'stop' }), T0)).toEqual({ kind: 'ended' });
    expect(routeDepartState(flight({ status: 'in-flight' }), T0)).toEqual({ kind: 'away' });
    expect(routeDepartState(flight({ departsAt: null, scheduledAt: null }), T0)).toEqual({ kind: 'unknown' });
  });
});

describe('helmEntryStay and nextLegPilot (the guard band)', () => {
  const W = T0 + 5 * MIN;

  it('this stay while docked, the next one within 10 s of the departure or in flight', () => {
    const robot = flight({ pilot: 'robot' });
    expect(helmEntryStay(robot, W - GUARD_BAND_MS - 1)).toBe(4);
    expect(helmEntryStay(robot, W - GUARD_BAND_MS)).toBe(5);
    expect(helmEntryStay(flight({ status: 'in-flight' }), T0)).toBe(5);
    // A person the ferry waits for keeps this stay, even past the window.
    expect(helmEntryStay(flight(), W + MIN)).toBe(4);
    // A person with a robot takeover pending: the robot's departure is the edge.
    expect(helmEntryStay(flight({ takeoverAt: W + 5 * MIN, departsAt: W + 6 * MIN }), W + MIN)).toBe(4);
    expect(helmEntryStay(flight({ takeoverAt: W + 5 * MIN, departsAt: W + 6 * MIN }), W + 6 * MIN - 5 * SEC)).toBe(5);
  });

  it('the next pilot: this stay\'s, or the newest helm entry at the next stay', () => {
    const r = saved();
    const inFlight = flight({ status: 'in-flight', pilot: 'robot' });
    expect(nextLegPilot(inFlight, [], T0)).toBe('robot');
    const take = helmCheckpoint(r, 5, { at: T0, pilot: 'person' })!;
    const hand = helmCheckpoint(r, 5, { at: T0 + SEC, pilot: 'robot' })!;
    expect(nextLegPilot(inFlight, [take], T0)).toBe('person');
    expect(nextLegPilot(inFlight, [hand, take], T0)).toBe('robot');
    // An entry keyed to another stay is not this one's.
    expect(nextLegPilot(inFlight, [helmCheckpoint(r, 7, { at: T0, pilot: 'person' })!], T0)).toBe('robot');
    // Docked outside the band: this stay's pilot.
    expect(nextLegPilot(flight({ pilot: 'robot' }), [take], T0)).toBe('robot');
  });
});

describe('routeHelmView', () => {
  const W = T0 + 5 * MIN;

  it('offers TAKE to a robot leg and HAND to a person one, only with a robot captain', () => {
    const v = routeHelmView(saved(), flight({ pilot: 'robot' }), [], T0);
    expect(v).toMatchObject({ helmStay: 4, nextPilot: 'robot', take: true, hand: false, keep: false, skip: true, stop: true });
    expect(routeHelmView(saved(), flight(), [], T0)).toMatchObject({ take: false, hand: true });
    expect(routeHelmView(saved([0, 1], { robotDockId: undefined }), flight(), [], T0)).toMatchObject({ take: false, hand: false, keep: false });
  });

  it('KEEP while a takeover is pending, useful once the window has passed', () => {
    const pending = flight({ takeoverAt: W + 5 * MIN, departsAt: W + 6 * MIN });
    expect(routeHelmView(saved(), pending, [], W - MIN)).toMatchObject({ keep: true, keepUseful: false });
    expect(routeHelmView(saved(), pending, [], W + MIN)).toMatchObject({ keep: true, keepUseful: true });
  });

  it('no SKIP in flight, within the band, or twice; nothing but STOP on a stopping, ended or paused route', () => {
    expect(routeHelmView(saved(), flight({ status: 'in-flight' }), [], T0).skip).toBe(false);
    expect(routeHelmView(saved(), flight({ pilot: 'robot' }), [], W - 5 * SEC).skip).toBe(false);
    expect(routeHelmView(saved(), flight({ skipped: true }), [], T0).skip).toBe(false);
    for (const f of [flight({ stopping: true }), flight({ ended: 'fuel' }), flight({ paused: true })]) {
      expect(routeHelmView(saved(), f, [], T0)).toMatchObject({ take: false, hand: false, keep: false, skip: false, stop: true });
    }
    expect(routeHelmView(saved([0, 1], { startedAt: T0, stoppedAt: T0 + SEC }), flight({ stopping: true }), [], T0).stop).toBe(false);
  });
});

describe('the ROUTE and FLIGHT PLAN lines', () => {
  const W = T0 + 5 * MIN;
  const running = saved([0, 1], { startedAt: T0 });
  const clk = formatClock;

  it('the checklist line: none, saved, starting, paused', () => {
    expect(routeStatusLine(null, null, T0)).toEqual({ text: 'none set', tone: 'dim' });
    expect(routeStatusLine(saved(), null, T0)).toEqual({ text: 'Stop 0→Stop 1→Stop 0 · saved · not running', tone: 'dim' });
    expect(routeStatusLine(running, null, T0)).toEqual({ text: 'Stop 0→Stop 1→Stop 0 · starting…', tone: 'dim' });
    expect(routeStatusLine(running, flight({ paused: true }), T0)).toEqual({ text: 'PAUSED · off route', tone: 'warn' });
  });

  it('the checklist line of a running route', () => {
    expect(routeStatusLine(running, flight({ pilot: 'robot' }), T0).text).toBe(`Stop 0→Stop 1→Stop 0 · robot · departs ${clk(W)} for Stop 1`);
    expect(routeStatusLine(running, flight({ status: 'in-flight' }), T0).text).toBe(`Stop 0→Stop 1→Stop 0 · person · arrives ${clk(T0 + 6 * MIN)} at Stop 1`);
    expect(routeStatusLine(running, flight({ holding: true }), T0)).toEqual({ text: 'HOLDING FOR BERTH AT Stop 0', tone: 'warn' });
    expect(routeStatusLine(running, flight(), W + SEC)).toEqual({ text: 'DELAYED · Stop 0 waits for its pilot', tone: 'warn' });
    expect(routeStatusLine(running, flight({ takeoverAt: W + 5 * MIN }), W + SEC).text)
      .toBe(`DELAYED · Stop 0 waits for its pilot · robot takes the helm at ${clk(W + 5 * MIN)}`);
    expect(routeStatusLine(running, flight({ pilot: 'robot', overdue: true }), W + SEC).text).toBe(`DELAYED AT Stop 0 · was due ${clk(W)}`);
    expect(routeStatusLine(running, flight({ ended: 'stop' }), T0).text).toBe('STOPPING AT Stop 0');
    expect(routeStatusLine(running, flight({ ended: 'fuel' }), T0)).toEqual({ text: 'OUT OF FUEL AT Stop 0 · REFUEL or STOP', tone: 'warn' });
    expect(routeStatusLine(running, flight({ pilot: 'robot', skipped: true, stopping: true }), T0).text)
      .toBe(`Stop 0→Stop 1→Stop 0 · robot · departs ${clk(W)} for Stop 1 · passing without docking · the route ends at the next stop`);
  });

  it('the FLIGHT PLAN line says when to depart, and what DEPART does when late', () => {
    expect(routeDepartLine(running, flight(), T0)).toBe(`ROUTE Stop 0→Stop 1→Stop 0 · Depart for Stop 1 at ${clk(W)} (launch window)`);
    expect(routeDepartLine(running, flight(), W + 5 * SEC)).toBe(`ROUTE Stop 0→Stop 1→Stop 0 · Depart for Stop 1: the ${clk(W)} window has passed, so DEPART takes the next one`);
    expect(routeDepartLine(running, flight({ pilot: 'robot' }), T0)).toBe(`ROUTE Stop 0→Stop 1→Stop 0 · The robot captain departs for Stop 1 at ${clk(W)} (launch window)`);
    expect(routeDepartLine(running, flight({ holding: true }), T0)).toBe('ROUTE Stop 0→Stop 1→Stop 0 · Holding for a berth at Stop 0');
    expect(routeDepartLine(running, flight({ ended: 'stop' }), T0)).toBe('ROUTE Stop 0→Stop 1→Stop 0 · The route ends here at Stop 0');
    expect(routeDepartLine(running, flight({ status: 'in-flight' }), T0)).toBe('ROUTE Stop 0→Stop 1→Stop 0 · In flight to Stop 1');
  });

  it('⛔ a route blocked by gone stops says which, and that STOP ends it', () => {
    const three = saved([0, 1, 2], { startedAt: T0 });
    expect(goneWords(three, { goneStops: [1] })).toBe('Stop 1 is gone');
    expect(goneWords(three, { goneStops: [1, 2] })).toBe('Stop 1 and Stop 2 are gone');
    expect(routeStatusLine(running, flight({ ended: 'blocked', goneStops: [1] }), T0))
      .toEqual({ text: 'ROUTE BLOCKED · Stop 1 is gone · STOP to end', tone: 'warn' });
    expect(routeDepartLine(running, flight({ ended: 'blocked', goneStops: [1] }), T0))
      .toBe('ROUTE Stop 0→Stop 1→Stop 0 · Blocked at Stop 0: Stop 1 is gone. STOP ends the route here');
    expect(routeStatusLine(running, flight({ pilot: 'robot', skipped: true, gone: true, goneStops: [0] }), T0).text)
      .toBe(`Stop 0→Stop 1→Stop 0 · robot · departs ${clk(W)} for Stop 1 · passing: its berth is gone`);
  });

  it('🛑 STOP ends at this stop once the timetable ended it here, else at the next one', () => {
    expect(routeEndStopIndex(flight({ ended: 'stop' }))).toBe(0);
    // Pressed inside the guard band: still docked here, ending at the next.
    expect(routeEndStopIndex(flight({ stopping: true }))).toBe(1);
    expect(routeEndStopIndex(flight({ status: 'in-flight', stopping: true }))).toBe(1);
  });

  it('🧾 a keeper\'s note stands only at its stay, and a hold note only while the ferry holds', () => {
    const tie = { run: T0, legSeq: 4 };
    expect(routeNoteStands(undefined, null, null)).toBe(true);
    expect(routeNoteStands(tie, running, flight())).toBe(true);
    expect(routeNoteStands(tie, running, flight({ legSeq: 5 }))).toBe(false);
    expect(routeNoteStands(tie, { ...running, startedAt: T0 + 1 }, flight())).toBe(false);
    expect(routeNoteStands(tie, running, flight({ paused: true }))).toBe(false);
    expect(routeNoteStands(tie, running, null)).toBe(false);
    const hold = { ...tie, hold: true };
    expect(routeNoteStands(hold, running, flight({ holding: true }))).toBe(true);
    // Another rider's dock, STOP or SKIP ended the hold.
    expect(routeNoteStands(hold, running, flight())).toBe(false);
    expect(routeNoteStands(hold, running, flight({ ended: 'stop' }))).toBe(false);
    expect(routeNoteStands(hold, running, flight({ skipped: true }))).toBe(false);
  });

  it('the render key flips when DEPART opens, the window passes, the band starts and the robot takes over', () => {
    const f = flight({ takeoverAt: W + 5 * MIN, departsAt: W + 6 * MIN });
    expect(routeRenderKey(null, T0)).toBe('');
    const keys = [T0, W - 29 * SEC, W, W + 6 * MIN - 9 * SEC, W + 5 * MIN].map((t) => routeRenderKey(f, t));
    expect(new Set(keys).size).toBe(5);
    expect(routeRenderKey(f, T0)).toBe(routeRenderKey(f, T0 + MIN));
  });
});

// ── The writers, over a real ship doc ────────────────────────────────────────

describe('the helm writers', () => {
  let off: (() => void) | null = null;
  beforeEach(() => { off = installRouteFlight({ capacity: () => CAP, clock: () => clock }); });
  afterEach(() => { off?.(); off = null; });

  /** START a saved route at T0 at stop 0 (home: docked at st-0). */
  function start(r: ShipRoute = saved(), fuel = 70): { run: number; route: ShipRoute; departAt: number; arriveAt: number } {
    writeFlightRecord({ status: 'docked', locationId: 'st-0' });
    writeFuelLevel(fuel, CAP);
    const run = startRouteFromHelm({ route: r, now: T0, startStop: 0, fuel, capacity: CAP });
    if (run === null) throw new Error('START refused');
    const s = readRouteCheckpoints().find((e) => e.kind === 'start') as { departAt: number; arriveAt: number };
    return { run, route: readShipRoute()!, departAt: s.departAt, arriveAt: s.arriveAt };
  }

  it('START saves the route and starts it in ONE transaction; the robot captain flies when named', () => {
    writeFuelLevel(40, CAP);
    const updates = countUpdates(doc);
    const run = startRouteFromHelm({ route: saved(), now: T0, startStop: 0, fuel: 40, capacity: CAP });
    expect(run).not.toBeNull();
    expect(updates.n).toBe(1);
    expect(readShipRoute()).toMatchObject({ startedAt: T0, startStop: 0, robotDockId: 'dock-1' });
    // The level aboard flies the first leg; the tanks fill on arriving back here.
    expect(readRouteFlight(T0 + SEC)).toMatchObject({ status: 'docked', legSeq: 0, stopIndex: 0, pilot: 'robot', fuel: 40 });
    expect(readFuelLevel(CAP)).toBe(40);
    // A second START while running does nothing.
    expect(startRouteFromHelm({ route: saved(), now: T0 + SEC, startStop: 0, fuel: 40, capacity: CAP })).toBeNull();
    expect(updates.n).toBe(1);
  });

  it('START with people only makes a person the pilot; a malformed route starts nothing', () => {
    start(saved([0, 1], { robotDockId: undefined }));
    expect(readRouteFlight(T0 + SEC)).toMatchObject({ pilot: 'person' });
    doc = new Y.Doc();
    bindShipDoc(doc);
    expect(startRouteFromHelm({ route: saved([0, 0]), now: T0, startStop: 0, fuel: 40, capacity: CAP })).toBeNull();
    expect(readShipRoute()).toBeNull();
  });

  it("a person's route DEPART: refused while boarding; then go + in-flight in one transaction", () => {
    const { departAt, arriveAt } = start(saved([0, 1], { robotDockId: undefined }));
    expect(departAt - ROUTE_DEPART_OPENS_MS).toBeGreaterThan(T0 + SEC);
    expect(departRouteFromHelm({ now: T0 + SEC })).toBeNull();
    const now = departAt - 10 * SEC;
    const updates = countUpdates(doc);
    const go = departRouteFromHelm({ now });
    expect(go).toMatchObject({ kind: 'go', legSeq: 0, stayStart: T0, departAt, arriveAt });
    expect(updates.n).toBe(1);
    expect(readFlightRecord()).toEqual({ status: 'in-flight', locationId: 'st-0', destinationId: 'st-1', departedAt: departAt, etaAt: arriveAt });
    expect(readRouteFlight(departAt + SEC)).toMatchObject({ status: 'in-flight', legSeq: 0 });
    // Not twice: the leg has gone.
    expect(departRouteFromHelm({ now: departAt + SEC })).toBeNull();
  });

  it("a person's route DEPART records where its next stop orbits as it casts off (PR 174's destinationAt)", () => {
    const home = listStations().find((st) => st.id === 'furlong-station')!;
    const r = saved([0, 1], { robotDockId: undefined });
    r.stops[1] = { ...r.stops[1], stationId: 'furlong-station' };
    const { departAt } = start(r);
    expect(departRouteFromHelm({ now: departAt - 10 * SEC })).not.toBeNull();
    expect(readFlightRecord()).toMatchObject({
      status: 'in-flight',
      destinationId: 'furlong-station',
      destinationAt: adriftAt(planetById(home.planetId).id, home.orbitSlot),
    });
  });

  it('a route DEPART pressed late takes the next window', () => {
    const { departAt } = start(saved([0, 1], { robotDockId: undefined }));
    const now = departAt + 2 * SEC;
    expect(readRouteFlight(now)).toMatchObject({ status: 'docked', legSeq: 0 });
    const go = departRouteFromHelm({ now })!;
    expect(go.departAt).toBeGreaterThanOrEqual(now);
    expect(go.departAt).toBeGreaterThan(departAt);
  });

  it('the robot flies its own legs: no person DEPART', () => {
    const { departAt } = start();
    expect(departRouteFromHelm({ now: departAt - 10 * SEC })).toBeNull();
  });

  it('DEPART off route pauses, copies the fuel and the stop into the stored records, then applies the caller\'s DEPART', () => {
    const { route, arriveAt } = start();
    const cost = routeLegFuel(route, 0, 1)!;
    clock = arriveAt + 5 * SEC;
    expect(readRouteFlight()).toMatchObject({ status: 'docked', legSeq: 1, stopIndex: 1 });
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    const updates = countUpdates(doc);
    const seen: number[] = [];
    const ok = pauseRouteFromHelm({
      now: clock,
      capacity: CAP,
      apply: (level) => {
        seen.push(level);
        writeFlightRecord({ status: 'in-flight', locationId: 'st-1', destinationId: 'elsewhere', departedAt: clock, etaAt: clock + MIN });
      },
    });
    expect(ok).toBe(true);
    expect(updates.n).toBe(1);
    expect(seen).toEqual([70 - cost]);
    expect(readRouteFlight()).toMatchObject({ paused: true });
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(readFlightRecord()).toMatchObject({ status: 'in-flight', locationId: 'st-1', destinationId: 'elsewhere' });
    // Paused: nothing more to pause.
    expect(pauseRouteFromHelm({ now: clock + SEC, capacity: CAP })).toBe(false);
  });

  it('a pause with no caller writes leaves the stored flight docked at the stop', () => {
    const { arriveAt } = start();
    clock = arriveAt + 5 * SEC;
    expect(pauseRouteFromHelm({ now: clock, capacity: CAP })).toBe(true);
    expect(readFlightRecord()).toEqual({ status: 'docked', locationId: 'st-1' });
  });

  it('RESUME at a stop: the ceiling first, a fresh stay at the first later visit, the level aboard kept', () => {
    const { route, arriveAt } = start();
    const cost = routeLegFuel(route, 0, 1)!;
    clock = arriveAt + 5 * SEC;
    expect(pauseRouteFromHelm({ now: clock, capacity: CAP })).toBe(true);
    // Refused on a stop the route does not have, or while not paused.
    expect(resumeRouteFromHelm({ now: clock, capacity: CAP, stopIndex: 5 })).toBe(false);
    clock += MIN;
    const updates = countUpdates(doc);
    expect(resumeRouteFromHelm({ now: clock, capacity: CAP, stopIndex: 1 })).toBe(true);
    expect(updates.n).toBe(1);
    const f = readRouteFlight()!;
    expect(f).toMatchObject({ paused: false, status: 'docked', legSeq: 3, stopIndex: 1, stayStart: clock, pilot: 'robot', fuel: 70 - cost });
    expect(f.departsAt!).toBeGreaterThanOrEqual(clock + 60 * SEC);
    expect(readFuelLevel(CAP)).toBe(70 - cost);
    expect(resumeRouteFromHelm({ now: clock + SEC, capacity: CAP, stopIndex: 1 })).toBe(false);
  });

  it('TAKE THE HELM docked, outside the band: this stay; HAND TO ROBOT re-times it', () => {
    const { departAt } = start();
    clock = T0 + 5 * SEC;
    const take = handOverRoute({ now: clock, pilot: 'person' })!;
    expect(take).toMatchObject({ kind: 'helm', legSeq: 0, pilot: 'person' });
    expect(take).not.toHaveProperty('departAt');
    expect(readRouteFlight()).toMatchObject({ pilot: 'person' });
    clock += 5 * SEC;
    const hand = handOverRoute({ now: clock, pilot: 'robot' })!;
    expect(hand).toMatchObject({ kind: 'helm', legSeq: 0, pilot: 'robot', stayStart: T0, departAt });
    expect(readRouteFlight()).toMatchObject({ pilot: 'robot', departsAt: departAt });
  });

  it('in flight, or within the band, the handover is the next stay\'s', () => {
    const { departAt } = start();
    clock = departAt + SEC;
    const take = handOverRoute({ now: clock, pilot: 'person' })!;
    expect(take.legSeq).toBe(1);
    expect(readRouteFlight()).toMatchObject({ status: 'in-flight', pilot: 'robot' });
    expect(nextLegPilot(readRouteFlight()!, readHelmCheckpoints(), clock)).toBe('person');
    expect(routeHelmView(readShipRoute()!, readRouteFlight()!, readHelmCheckpoints(), clock)).toMatchObject({ helmStay: 1, nextPilot: 'person', hand: true, take: false });
  });

  it('a person who lets the window pass: the robot takes the helm 5 minutes later; KEEP restarts the 5 minutes', () => {
    const { departAt } = start();
    clock = T0 + 5 * SEC;
    expect(handOverRoute({ now: clock, pilot: 'person' })).not.toBeNull();
    clock = departAt + MIN;
    const f = readRouteFlight()!;
    expect(f).toMatchObject({ status: 'docked', legSeq: 0, pilot: 'person' });
    expect(f.takeoverAt).toBe(departAt + ROBOT_TAKEOVER_MS);
    const view = routeHelmView(readShipRoute()!, f, readHelmCheckpoints(), clock);
    expect(view).toMatchObject({ keep: true, keepUseful: true, helmStay: 0 });
    expect(routeStatusLine(readShipRoute(), f, clock).text).toContain(`robot takes the helm at ${formatClock(departAt + ROBOT_TAKEOVER_MS)}`);
    const keep = handOverRoute({ now: clock, pilot: 'person' })!;
    expect(keep.legSeq).toBe(0);
    expect(readRouteFlight()!.takeoverAt).toBe(clock + ROBOT_TAKEOVER_MS);
    // And the person may still DEPART (the next window).
    expect(departRouteFromHelm({ now: clock })).not.toBeNull();
  });

  it('HAND TO ROBOT is refused without a robot captain; nothing is handed on a paused route', () => {
    start(saved([0, 1], { robotDockId: undefined }));
    expect(handOverRoute({ now: T0 + SEC, pilot: 'robot' })).toBeNull();
    expect(pauseRouteFromHelm({ now: T0 + 2 * SEC, capacity: CAP })).toBe(true);
    expect(handOverRoute({ now: T0 + 3 * SEC, pilot: 'person' })).toBeNull();
  });

  it('HAND TO ROBOT at a skipped stay is a plain helm entry: it never re-times the skip', () => {
    start();
    clock = T0 + 5 * SEC;
    expect(skipRouteStop({ now: clock })).toBe(true);
    const skipped = readRouteFlight()!;
    expect(handOverRoute({ now: clock + SEC, pilot: 'person' })).not.toBeNull();
    const hand = handOverRoute({ now: clock + 2 * SEC, pilot: 'robot' })!;
    expect(hand).not.toHaveProperty('departAt');
    expect(readRouteFlight()).toMatchObject({ skipped: true, departsAt: skipped.departsAt, pilot: 'robot' });
  });

  it('SKIP STOP at a stop: the ferry leaves at the next window; not in flight, not twice', () => {
    const { departAt } = start();
    clock = T0 + 5 * SEC;
    expect(skipRouteStop({ now: clock })).toBe(true);
    const f = readRouteFlight()!;
    expect(f).toMatchObject({ skipped: true, legSeq: 0 });
    expect(f.departsAt!).toBeGreaterThanOrEqual(clock);
    expect(f.departsAt!).toBeLessThanOrEqual(departAt);
    expect(skipRouteStop({ now: clock + SEC })).toBe(false);
    clock = f.departsAt! + SEC;
    expect(readRouteFlight()).toMatchObject({ status: 'in-flight' });
    expect(skipRouteStop({ now: clock })).toBe(false);
  });

  it('STOP stamps the stop on a running route, and finishes a paused one at once', () => {
    start();
    expect(stopRouteFromHelm({ now: T0 + 5 * SEC })).toBe('stopping');
    expect(readShipRoute()!.stoppedAt).toBe(T0 + 5 * SEC);
    expect(readRouteFlight(T0 + 6 * SEC)).toMatchObject({ ended: 'stop' });
    // STOPPING: no handover or skip.
    expect(handOverRoute({ now: T0 + 6 * SEC, pilot: 'person' })).toBeNull();
    expect(skipRouteStop({ now: T0 + 6 * SEC })).toBe(false);

    doc = new Y.Doc();
    bindShipDoc(doc);
    start();
    expect(pauseRouteFromHelm({ now: T0 + 5 * SEC, capacity: CAP })).toBe(true);
    expect(stopRouteFromHelm({ now: T0 + 6 * SEC })).toBe('finished');
    const r = readShipRoute()!;
    expect(r.startedAt).toBeUndefined();
    expect(readRouteCheckpoints()).toEqual([]);
    expect(shipDocHandle()!.map.has('route')).toBe(true);
    expect(stopRouteFromHelm({ now: T0 + 7 * SEC })).toBeNull();
  });
});
