/**
 * 🚏⏱️ Pilot route — the ferry timetable (build notes A2 + A3): stops along
 * a loop or a back-and-forth, the window rules (never replan at a stored
 * window), on-time legs from the clock alone, a hold shifting every later
 * leg, two writers of one event agreeing, the reader checks against hostile
 * or impossible entries, the live-dock rule, a person at the helm and the
 * robot captain's takeover, STOP, fuel with the home refill, pause and
 * RESUME, pruning that keeps the anchor, and the walk cache. A4: the
 * resolved flight and what a helm-gated game copies back into the stored
 * records (after STOP, or following a landed person's in-flight).
 */
import { describe, expect, it } from 'vitest';
import { planTransfer } from './orbits';
import {
  CLOCK_AHEAD_MS,
  HOLD_UNWATCHED_MS,
  ROBOT_TAKEOVER_MS,
  checkpointsToPrune,
  createRouteWalkCache,
  dockCheckpoint,
  fuelCheckpoint,
  goCheckpoint,
  helmCheckpoint,
  holdCheckpoint,
  legWindowAfter,
  legWindowAt,
  liveDockFrom,
  nextStayAtStop,
  pauseCheckpoint,
  renewedHold,
  resolvedFlight,
  routeCycleLength,
  routeFlightAt,
  routeFlightPlaces,
  routeStayOffList,
  routeFlightRecord,
  routeLegFuel,
  routeLegPairs,
  routeLegsPlannable,
  routeRefuelStay,
  routeRulesFlight,
  routeSettleAction,
  skipCheckpoint,
  startCheckpoint,
  stopAt,
  validateCheckpoints,
} from './pilotRoute';
import type { LiveDockAt, RouteFlight } from './pilotRoute';
import type { FlightRecord } from './shipDoc';
import type { RouteCheckpoint, RoutePilot, RouteShape, RouteStop, ShipRoute, StartCheckpoint } from './shipRoute';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Fuel and capacity for tests that are not about fuel: never runs dry. */
const BIG = 1e6;

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

/** A route over `slots` (one stop per slot), running from T0 at startStop. */
function running(
  slots: number[],
  shape: RouteShape = 'backAndForth',
  over: Partial<ShipRoute> = {},
): ShipRoute {
  return {
    stops: slots.map((s, i) => stop(i, s)),
    shape,
    shipPort: 'x-',
    robotDockId: 'dock-1',
    startedAt: T0,
    startStop: 0,
    ...over,
  };
}

/** The same route with no robot captain. */
function peopleOnly(r: ShipRoute): ShipRoute {
  const { robotDockId: _drop, ...rest } = r;
  return rest;
}

function start(r: ShipRoute, o: { pilot?: RoutePilot; fuel?: number; at?: number } = {}): StartCheckpoint {
  const s = startCheckpoint(r, { at: o.at ?? r.startedAt!, pilot: o.pilot ?? 'robot', fuel: o.fuel ?? BIG });
  if (!s) throw new Error('start leg not plannable');
  return s;
}

function at(
  r: ShipRoute,
  ckpts: readonly RouteCheckpoint[],
  now: number,
  o: { liveDock?: LiveDockAt | null; capacity?: number } = {},
): RouteFlight {
  const f = routeFlightAt(r, ckpts, o.liveDock ?? null, now, o.capacity ?? BIG);
  if (!f) throw new Error('no timetable');
  return f;
}

interface ChainLeg { legSeq: number; stop: number; depart: number; arrive: number }

/** The on-time chain (A3 rule 4), laid out by hand from the start entry:
 *  each leg leaves at the first window after arrival + the minimum wait. */
function onTimeChain(r: ShipRoute, s: StartCheckpoint, legs: number): ChainLeg[] {
  const out: ChainLeg[] = [{ legSeq: 0, stop: stopAt(r, 0), depart: s.departAt, arrive: s.arriveAt }];
  for (let k = 1; k < legs; k++) {
    const w = legWindowAfter(r, k, out[k - 1].arrive + r.stops[stopAt(r, k)].waitSecs * SEC)!;
    out.push({ legSeq: k, stop: stopAt(r, k), depart: w.departAt, arrive: w.arriveAt });
  }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const FERRY_SLOTS = [0, 1]; // the owner's 0 ↔ 1 ferry: 55 s legs, a window every 5.4 min, 33 fuel

// ── Stops along the shape ────────────────────────────────────────────────────

describe('stops along the shape', () => {
  const seq = (r: ShipRoute, n: number) => Array.from({ length: n }, (_, k) => stopAt(r, k));

  it('a loop goes round, from whichever stop START was pressed at', () => {
    expect(seq(running([0, 1, 2], 'loop'), 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(seq(running([0, 1, 2], 'loop', { startStop: 1 }), 5)).toEqual([1, 2, 0, 1, 2]);
    expect(routeCycleLength(3, 'loop')).toBe(3);
  });

  it('a back-and-forth turns at each end', () => {
    expect(seq(running([0, 1, 2]), 9)).toEqual([0, 1, 2, 1, 0, 1, 2, 1, 0]);
    expect(seq(running([0, 1, 2], 'backAndForth', { startStop: 2 }), 5)).toEqual([2, 1, 0, 1, 2]);
    expect(seq(running([0, 1, 2], 'backAndForth', { startStop: 1 }), 5)).toEqual([1, 2, 1, 0, 1]);
    expect(seq(running(FERRY_SLOTS), 4)).toEqual([0, 1, 0, 1]);
    expect(routeCycleLength(3, 'backAndForth')).toBe(4);
  });

  it('a two-stop ferry is the same route either way', () => {
    const seqLoop = seq(running(FERRY_SLOTS, 'loop'), 6);
    expect(seqLoop).toEqual(seq(running(FERRY_SLOTS, 'backAndForth'), 6));
  });

  it('lists each leg pair once, and finds the next visit to a stop', () => {
    expect(routeLegPairs(3, 'loop')).toEqual([[0, 1], [1, 2], [2, 0]]);
    expect(routeLegPairs(3, 'backAndForth')).toEqual([[0, 1], [1, 0], [1, 2], [2, 1]]);
    const r = running([0, 1, 2]);
    expect(nextStayAtStop(r, 1, 0)).toBe(4);
    expect(nextStayAtStop(r, 1, 1)).toBe(1);
    expect(nextStayAtStop(r, 3, 2)).toBe(6);
  });

  it('refuses shapes whose legs cannot be planned', () => {
    const stops = (slots: number[], planets: string[] = slots.map(() => SOV)) =>
      slots.map((s, i) => stop(i, s, { planetId: planets[i] }));
    expect(routeLegsPlannable(stops([0, 1]), 'loop')).toBe(true);
    // Neighbours sharing an orbit have no transfer.
    expect(routeLegsPlannable(stops([1, 1]), 'backAndForth')).toBe(false);
    // A loop also flies home from the last stop: 0 → 1 → 0 closes on a shared orbit.
    expect(routeLegsPlannable(stops([0, 1, 0]), 'loop')).toBe(false);
    expect(routeLegsPlannable(stops([0, 1, 0]), 'backAndForth')).toBe(true);
    // Ships fly between one planet's stations.
    expect(routeLegsPlannable(stops([0, 1], [SOV, 'planet-aris']), 'loop')).toBe(false);
    expect(routeLegsPlannable(stops([0]), 'loop')).toBe(false);
  });

  it('prices each leg with PR 172\'s hop pricing', () => {
    const r = running(FERRY_SLOTS);
    expect(routeLegFuel(r, 0, 1)).toBe(33);
    expect(routeLegFuel(r, 1, 0)).toBe(33);
    expect(routeLegFuel(running([0, 5]), 0, 1)).toBe(123); // more than a tank holds
  });
});

// ── Window rules ─────────────────────────────────────────────────────────────

describe('window rules', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);

  it('the first leg leaves at the first window after the minimum wait', () => {
    const w = legWindowAfter(r, 0, 0)!;
    const lead = s.departAt - (s.stayStart + 60 * SEC);
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(lead).toBeLessThanOrEqual(w.synodicMs);
    expect(Math.abs(s.arriveAt - s.departAt - w.transferMs)).toBeLessThan(0.01);
    expect(w.transferMs / SEC).toBeCloseTo(55.1, 1);
    expect(w.synodicMs / MIN).toBeCloseTo(5.41, 2);
  });

  it('asking AT a stored window can answer the next one; legWindowAt never does', () => {
    // Why the rule exists: planTransfer asked at its own window time lands
    // on either side of it, by floating-point luck.
    const probe = { id: 'a', planetId: SOV, orbitSlot: 0 };
    const target = { id: 'b', planetId: SOV, orbitSlot: 1 };
    const first = planTransfer(probe, target, T0)!;
    const again = planTransfer(probe, target, first.departAt)!;
    expect([0, first.synodicMs].some((d) => Math.abs(again.departAt - first.departAt - d) < 1)).toBe(true);
    // Every stored window is found again exactly, many windows on.
    let base = s.departAt;
    for (let i = 0; i < 50; i++) {
      const w = legWindowAfter(r, 0, base + 7 * SEC)!;
      const found = legWindowAt(r, 0, w.departAt)!;
      expect(found).not.toBeNull();
      expect(Math.abs(found.departAt - w.departAt)).toBeLessThanOrEqual(1);
      base = w.departAt;
    }
  });

  it('windows are whole milliseconds, never before the orbital one, and a fractional stored one is still found', () => {
    // A flight record stores only safe integer times (PR 172's
    // isFlightRecord), and the timetable's times become its departedAt and
    // etaAt: planHop's rounding, up, applied here too.
    const probe = { id: 'a', planetId: SOV, orbitSlot: FERRY_SLOTS[0] };
    const target = { id: 'b', planetId: SOV, orbitSlot: FERRY_SLOTS[1] };
    let base = T0 + 3;
    let fractional = 0;
    for (let i = 0; i < 20; i++) {
      const t = planTransfer(probe, target, base)!;
      if (!Number.isInteger(t.departAt) || !Number.isInteger(t.arriveAt)) fractional++;
      const w = legWindowAfter(r, 0, base)!;
      expect(Number.isSafeInteger(w.departAt) && Number.isSafeInteger(w.arriveAt)).toBe(true);
      expect(w.departAt).toBe(Math.ceil(t.departAt));
      expect(w.arriveAt).toBe(Math.ceil(t.arriveAt));
      expect(w.departAt).toBeGreaterThanOrEqual(base);
      // A route started before the rounding stored the fraction.
      expect(legWindowAt(r, 0, t.departAt)?.departAt).toBe(w.departAt);
      base = w.arriveAt + 7 * SEC;
    }
    expect(fractional).toBeGreaterThan(0);
    // So is every time a timetable flight hands PR 172's readers.
    const chain = onTimeChain(r, s, 4);
    for (const leg of chain) {
      const f = at(r, [s], leg.depart + SEC);
      expect(f.status).toBe('in-flight');
      for (const v of [f.departedAt, f.etaAt, f.departsAt, f.arrivesAt]) expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it('a time that is not a window of the leg is not found', () => {
    expect(legWindowAt(r, 0, s.departAt + 1000)).toBeNull();
    expect(legWindowAt(r, 0, s.departAt - 30 * SEC)).toBeNull();
    // A window of the OTHER direction is not one of this leg's.
    const back = legWindowAfter(r, 1, s.arriveAt)!;
    expect(legWindowAt(r, 0, back.departAt)).toBeNull();
  });

  it('readers use the stored window: writers a second apart can differ by a whole window', () => {
    // Put START's base just before a window: one writer catches it, a
    // writer a second late gets the next, and each reads what was stored.
    const w = legWindowAfter(r, 0, T0 + HOUR)!;
    const early = running(FERRY_SLOTS, 'backAndForth', { startedAt: Math.floor(w.departAt - 60 * SEC - 500) });
    const late = running(FERRY_SLOTS, 'backAndForth', { startedAt: Math.floor(w.departAt - 60 * SEC + 500) });
    const a = start(early);
    const b = start(late);
    expect(Math.abs(b.departAt - a.departAt - w.synodicMs)).toBeLessThan(1);
    expect(at(early, [a], a.stayStart + SEC).departsAt).toBe(a.departAt);
    expect(at(late, [b], b.stayStart + SEC).departsAt).toBe(b.departAt);
  });
});

// ── On time: the clock moves the ferry ───────────────────────────────────────

describe('on time, the clock alone moves the ferry', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const chain = onTimeChain(r, s, 12);

  it('docked until departAt, in flight until arriveAt, docked at the next stop', () => {
    for (const leg of chain) {
      const before = at(r, [s], leg.depart - SEC);
      expect(before).toMatchObject({ status: 'docked', legSeq: leg.legSeq, stopIndex: leg.stop, departsAt: leg.depart });
      expect(before.locationId).toBe(r.stops[leg.stop].stationId);
      const flying = at(r, [s], leg.depart + SEC);
      expect(flying).toMatchObject({
        status: 'in-flight',
        legSeq: leg.legSeq,
        locationId: r.stops[leg.stop].stationId,
        destinationId: r.stops[stopAt(r, leg.legSeq + 1)].stationId,
        departedAt: leg.depart,
        etaAt: leg.arrive,
      });
      const landed = at(r, [s], leg.arrive + SEC);
      expect(landed).toMatchObject({ status: 'docked', legSeq: leg.legSeq + 1, stayStart: leg.arrive });
    }
  });

  it('a 60 s wait on the 0 ↔ 1 ferry makes a stay of 1 to 6.4 minutes', () => {
    for (let k = 1; k < chain.length; k++) {
      const stay = chain[k].depart - chain[k - 1].arrive;
      expect(stay).toBeGreaterThanOrEqual(60 * SEC);
      expect(stay).toBeLessThanOrEqual(60 * SEC + legWindowAfter(r, k, 0)!.synodicMs + 1);
    }
  });

  it('there is no redocking beat, and the answer is a FlightRecord', () => {
    for (let t = T0; t < chain[11].arrive; t += 7 * SEC) {
      const f = at(r, [s], t);
      expect(['docked', 'in-flight']).toContain(f.status);
      if (f.status === 'in-flight') expect(f.etaAt! > f.departedAt!).toBe(true);
    }
  });

  it('reads nothing but its arguments and changes none of them', () => {
    const frozenRoute = deepFreeze(running(FERRY_SLOTS));
    const frozen = deepFreeze([start(frozenRoute)]);
    const first = routeFlightAt(frozenRoute, frozen, null, chain[5].depart + SEC, BIG);
    expect(first).toMatchObject({ status: 'in-flight', legSeq: 5 });
    expect(routeFlightAt(frozenRoute, frozen, null, chain[5].depart + SEC, BIG)).toEqual(first);
  });

  it('far from the last checkpoint, the walk agrees with the hand-laid chain', () => {
    const long = onTimeChain(r, s, 300);
    const leg = long[299];
    expect(at(r, [s], leg.depart - SEC)).toMatchObject({ legSeq: 299, departsAt: leg.depart });
  });

  it('with no run, or no anchor, there is no timetable', () => {
    const { startedAt: _a, startStop: _b, ...idle } = r;
    expect(routeFlightAt(idle, [s], null, T0, 100)).toBeNull();
    expect(routeFlightAt(r, [], null, T0, 100)).toBeNull();
    expect(routeFlightAt(null, [s], null, T0, 100)).toBeNull();
  });
});

// ── A hold shifts every later leg ────────────────────────────────────────────

describe('holding for a taken berth', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 8);
  const A0 = on[0].arrive;
  const S = legWindowAfter(r, 1, 0)!.synodicMs;
  const hold = holdCheckpoint(r, 1, { at: A0 + 5 * SEC });

  it('holds docked-with-no-departure at the stop until the berth frees', () => {
    const f = at(r, [s, hold], A0 + 30 * SEC);
    expect(f).toMatchObject({ status: 'docked', legSeq: 1, stopIndex: 1, holding: true, holdSince: hold.since, departsAt: null });
    // Renewed each minute, it holds past the on-time departure.
    const renewed = renewedHold(hold, on[1].depart + 10 * SEC);
    expect(renewed.at).toBe(hold.at);
    expect(at(r, [s, renewed], on[1].depart + 20 * SEC)).toMatchObject({ holding: true, legSeq: 1 });
  });

  it('once docked, waits its minimum wait, leaves at the next window, and every later departure moves', () => {
    const dockedAt = on[1].depart + 30 * SEC; // the pairing's own stamp
    const dock = dockCheckpoint(r, 1, { at: dockedAt + 2 * SEC, stayStart: dockedAt, pilot: 'robot' })!;
    const ck = [s, hold, dock];
    expect(at(r, ck, dockedAt + 5 * SEC)).toMatchObject({ holding: false, stayStart: dockedAt, departsAt: dock.departAt });
    // A missed window costs one whole window, and on a two-stop ferry every
    // later departure moves by the same amount.
    const shift = dock.departAt - on[1].depart;
    expect(Math.abs(shift - S)).toBeLessThan(1);
    for (let k = 2; k < 8; k++) {
      const f = at(r, ck, on[k - 1].arrive + shift + SEC);
      expect(f.legSeq).toBe(k);
      expect(Math.abs(f.departsAt! - on[k].depart - shift)).toBeLessThan(1);
    }
  });

  it('a short hold usually costs nothing: the stay had slack before its window', () => {
    const dockedAt = A0 + 10 * SEC;
    expect(on[1].depart - (dockedAt + 60 * SEC)).toBeGreaterThan(0); // slack in this fixture
    const dock = dockCheckpoint(r, 1, { at: dockedAt + SEC, stayStart: dockedAt, pilot: 'robot' })!;
    expect(Math.abs(dock.departAt - on[1].depart)).toBeLessThan(1);
    const f = at(r, [s, holdCheckpoint(r, 1, { at: A0 + SEC }), dock], on[4].depart - SEC);
    expect(f.legSeq).toBe(4);
    expect(Math.abs(f.departsAt! - on[4].depart)).toBeLessThan(1);
  });

  it('a hold nobody renews ends three minutes on, and the ferry leaves undocked', () => {
    const quiet = holdCheckpoint(r, 1, { at: A0 + 5 * SEC });
    expect(at(r, [s, quiet], quiet.seenAt + HOLD_UNWATCHED_MS - SEC).holding).toBe(true);
    const f = at(r, [s, quiet], quiet.seenAt + HOLD_UNWATCHED_MS + SEC);
    const w = legWindowAfter(r, 1, quiet.seenAt + HOLD_UNWATCHED_MS)!;
    expect(f).toMatchObject({ holding: false, skipped: true, departsAt: w.departAt, status: 'docked' });
    expect(at(r, [s, quiet], w.departAt + SEC)).toMatchObject({ status: 'in-flight', departedAt: w.departAt });
  });

  it('dock, go, skip and pause end a hold (a tie goes to them); a helm entry does not', () => {
    const t = A0 + 20 * SEC;
    const h = holdCheckpoint(r, 1, { at: t });
    const tieDock = dockCheckpoint(r, 1, { at: t, stayStart: t, pilot: 'robot' })!;
    expect(at(r, [s, h, tieDock], t + SEC).holding).toBe(false);
    const skip = skipCheckpoint(r, 1, { at: t + SEC, pilot: 'robot' })!;
    expect(at(r, [s, h, skip], t + 2 * SEC)).toMatchObject({ holding: false, skipped: true, departsAt: skip.departAt });
    const take = helmCheckpoint(r, 1, { at: t + SEC, pilot: 'person' })!;
    expect(at(r, [s, h, take], t + 2 * SEC).holding).toBe(true);
    const pause = pauseCheckpoint(r, 1, { at: t + SEC });
    expect(at(r, [s, h, pause], t + 2 * SEC)).toMatchObject({ paused: true, holding: false });
    // A newer hold after the dock (the dock was lost) holds again.
    const again = holdCheckpoint(r, 1, { at: t + 30 * SEC });
    expect(at(r, [s, tieDock, again], t + 31 * SEC).holding).toBe(true);
  });

  it('holds burn nothing', () => {
    const s100 = start(r, { fuel: 100 });
    // Held (and renewed) well past the on-time departure: only leg 0 burned.
    const renewed = renewedHold(hold, on[1].depart + 10 * SEC);
    const f = at(r, [s100, renewed], on[1].depart + 20 * SEC, { capacity: 100 });
    expect(f).toMatchObject({ holding: true, legSeq: 1, fuel: 100 - 33 });
  });
});

// ── Two writers of one event ─────────────────────────────────────────────────

describe('two writers of one event converge', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 4);

  it('two keepers\' holds for one stay: whichever the doc keeps, the ferry holds', () => {
    const a = holdCheckpoint(r, 1, { at: on[0].arrive + 3 * SEC });
    const b = holdCheckpoint(r, 1, { at: on[0].arrive + 4 * SEC });
    const t = on[0].arrive + 10 * SEC;
    expect(at(r, [s, a], t)).toEqual({ ...at(r, [s, b], t), holdSince: a.since });
  });

  it('two keepers\' docks after a hold carry the pairing\'s stamp, so they leave at the same window', () => {
    const dockedAt = on[1].depart + 40 * SEC;
    const a = dockCheckpoint(r, 1, { at: dockedAt + 1 * SEC, stayStart: dockedAt, pilot: 'robot' })!;
    const b = dockCheckpoint(r, 1, { at: dockedAt + 4 * SEC, stayStart: dockedAt, pilot: 'robot' })!;
    expect(a.departAt).toBe(b.departAt);
    for (const t of [dockedAt + 10 * SEC, a.departAt + SEC, a.arriveAt + 5 * MIN]) {
      expect(at(r, [s, a], t)).toEqual(at(r, [s, b], t));
    }
  });

  it('entries arrive in any order and read alike', () => {
    const h = holdCheckpoint(r, 1, { at: on[0].arrive + 3 * SEC });
    const d = dockCheckpoint(r, 1, { at: on[0].arrive + 200 * SEC, stayStart: on[0].arrive + 199 * SEC, pilot: 'robot' })!;
    const t = on[3].arrive + HOUR;
    expect(at(r, [d, h, s], t)).toEqual(at(r, [s, h, d], t));
  });
});

// ── Reader checks ────────────────────────────────────────────────────────────

describe('reader checks (A2)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 4);
  const A0 = on[0].arrive;
  const now = on[1].depart + 5 * MIN;
  const reasons = (ck: RouteCheckpoint[], t = now) =>
    validateCheckpoints(r, [s, ...ck], t).rejected.map((x) => x.reason);

  it('accepts what the constructors write', () => {
    const d = dockCheckpoint(r, 1, { at: A0 + 100 * SEC, stayStart: A0 + 90 * SEC, pilot: 'robot' })!;
    const v = validateCheckpoints(r, [s, holdCheckpoint(r, 1, { at: A0 + 5 * SEC }), d], now);
    expect(v.rejected).toEqual([]);
    expect(v.anchor).toBe(d);
  });

  it('an entry for another stop than its stay\'s is ignored', () => {
    expect(reasons([{ ...holdCheckpoint(r, 1, { at: A0 + 5 * SEC }), stationId: 'st-0' }])).toEqual(['wrong-stop']);
  });

  it('observed times more than 60 s ahead are ignored until the clock catches up', () => {
    const t = A0 + 30 * SEC;
    const future = holdCheckpoint(r, 1, { at: t + CLOCK_AHEAD_MS + 5 * SEC });
    const v = validateCheckpoints(r, [s, future], t);
    expect(v.rejected.map((x) => x.reason)).toEqual(['ahead']);
    expect(v.recheckAt).toBe(future.at - CLOCK_AHEAD_MS);
    const cache = createRouteWalkCache();
    expect(routeFlightAt(r, [s, future], null, t, 100, cache)!.holding).toBe(false);
    expect(routeFlightAt(r, [s, future], null, v.recheckAt + 1, 100, cache)!.holding).toBe(true);
  });

  it('an entry for a stay the ferry cannot have reached yet is ignored', () => {
    const far = { ...holdCheckpoint(r, 50, { at: T0 + 10 * MIN }) };
    const v = validateCheckpoints(r, [s, far], T0 + 10 * MIN);
    expect(v.rejected.map((x) => x.reason)).toEqual(['ahead']);
    expect(at(r, [s, far], T0 + 10 * MIN).legSeq).toBeLessThan(5);
  });

  it('an entry before the stay\'s earliest arrival is ignored', () => {
    expect(reasons([holdCheckpoint(r, 1, { at: A0 - 5 * SEC })])).toEqual(['early']);
    const d = dockCheckpoint(r, 1, { at: A0 + 5 * SEC, stayStart: A0 - 20 * SEC, pilot: 'robot' })!;
    expect(reasons([d])).toEqual(['early']);
  });

  it('a start that is not stay 0, or a hold whose since is not its at, is ignored', () => {
    expect(reasons([{ ...s, legSeq: 2, stationId: 'st-0' }])).toEqual(['start-not-first']);
    const h = holdCheckpoint(r, 1, { at: A0 + 5 * SEC });
    expect(reasons([{ ...h, since: h.at - 1 }])).toEqual(['bad-stay-start']);
    expect(reasons([{ ...h, seenAt: h.at - 1 }])).toEqual(['bad-stay-start']);
  });

  it('a departAt that is no window, or not the first after its base, is ignored', () => {
    const d = dockCheckpoint(r, 1, { at: A0 + 100 * SEC, stayStart: A0 + 90 * SEC, pilot: 'robot' })!;
    const S = legWindowAfter(r, 1, 0)!.synodicMs;
    expect(reasons([{ ...d, departAt: d.departAt + 1000, arriveAt: d.arriveAt + 1000 }])).toEqual(['not-a-window']);
    expect(reasons([{ ...d, arriveAt: d.arriveAt + 5000 }])).toEqual(['not-a-window']);
    expect(reasons([{ ...d, departAt: d.departAt + S, arriveAt: d.arriveAt + S }])).toEqual(['not-first-window']);
    // A window picked from a later base than the entry's own is not first either.
    const late = dockCheckpoint(r, 1, { at: A0 + 100 * SEC, stayStart: A0 + 90 * SEC + S, pilot: 'robot' })!;
    expect(reasons([{ ...late, stayStart: d.stayStart }], late.at + S)).toEqual(['not-first-window']);
  });

  it('a go from a stay that began after the press is ignored', () => {
    const g = goCheckpoint(r, 1, { at: A0 + 100 * SEC, stayStart: A0 + 100 * SEC + CLOCK_AHEAD_MS + SEC })!;
    expect(reasons([g], g.stayStart)).toEqual(['bad-stay-start']);
  });

  it('while paused, only RESUME, the helm and REFUEL count at later stays', () => {
    const p = pauseCheckpoint(r, 1, { at: A0 + 10 * SEC });
    const later = holdCheckpoint(r, 2, { at: on[1].arrive + 60 * SEC });
    const helm = helmCheckpoint(r, 2, { at: A0 + 30 * SEC, pilot: 'person' })!;
    expect(validateCheckpoints(r, [s, p, later, helm], on[1].arrive + 2 * MIN).rejected.map((x) => x.reason)).toEqual(['paused']);
  });

  it('a helm entry written in flight is keyed to the next stay, bounded by the leg\'s departure', () => {
    const take = helmCheckpoint(r, 1, { at: on[0].depart + 10 * SEC, pilot: 'person' })!;
    expect(reasons([take], on[0].depart + 20 * SEC)).toEqual([]);
    // Inside the 10 s guard band before the departure is fine too; before it is not.
    expect(reasons([{ ...take, at: on[0].depart - 9 * SEC }], on[0].depart)).toEqual([]);
    expect(reasons([{ ...take, at: on[0].depart - 11 * SEC }], on[0].depart)).toEqual(['early']);
  });
});

// ── The live-dock rule ───────────────────────────────────────────────────────

describe('the live-dock rule (A3.3)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 8);

  it('a ferry nobody cast off stays docked, overdue, and flies once the dock is gone', () => {
    const docked: LiveDockAt = (_stop, i) => (i === 0 ? T0 - MIN : null);
    for (const t of [on[0].depart + SEC, on[3].arrive, on[7].arrive + HOUR]) {
      expect(at(r, [s], t, { liveDock: docked })).toMatchObject({
        status: 'docked', legSeq: 0, stopIndex: 0, overdue: true, departsAt: on[0].depart,
      });
    }
    expect(at(r, [s], on[0].depart + SEC)).toMatchObject({ status: 'in-flight', legSeq: 0 });
  });

  it('before its departure a live dock changes nothing', () => {
    const docked: LiveDockAt = (_stop, i) => (i === 0 ? T0 - MIN : null);
    expect(at(r, [s], on[0].depart - SEC, { liveDock: docked })).toEqual(at(r, [s], on[0].depart - SEC));
  });

  it('a dock made at a later visit to the same stop pins that visit, not the first', () => {
    const dockedAt = on[1].arrive + 5 * SEC; // stay 2, back at stop 0
    const docked: LiveDockAt = (_stop, i) => (i === 0 ? dockedAt : null);
    expect(at(r, [s], on[2].depart + HOUR, { liveDock: docked })).toMatchObject({
      legSeq: 2, stopIndex: 0, overdue: true, departsAt: on[2].depart,
    });
    // …and the first visit left on time (the dock came later).
    expect(at(r, [s], dockedAt + 5 * SEC, { liveDock: docked })).toMatchObject({ legSeq: 2, overdue: false });
  });

  it('🕰️ a dock stamped by a clock running ahead still holds the stay it was made at', () => {
    // Made at stay 0 by a rider whose clock runs an hour fast: the stamp is
    // after the departure, and after now.
    const ahead: LiveDockAt = (_stop, i) => (i === 0 ? on[0].depart + HOUR : null);
    expect(at(r, [s], on[0].depart + SEC, { liveDock: ahead })).toMatchObject({
      status: 'docked', legSeq: 0, stopIndex: 0, overdue: true,
    });
    // Stamped after the departure but before the leg could land: no pairing
    // is made in flight, so it was this stay's, and it holds it for good.
    const skewed: LiveDockAt = (_stop, i) => (i === 0 ? on[0].depart + 10 * SEC : null);
    for (const t of [on[0].depart + SEC, on[0].arrive + HOUR]) {
      expect(at(r, [s], t, { liveDock: skewed })).toMatchObject({ status: 'docked', legSeq: 0, overdue: true });
    }
  });

  it('liveDockFrom matches a dock in the stop\'s berth room, or its station by the caller\'s word', () => {
    const live = liveDockFrom([{ roomId: 'room-1', dockedAt: 42 }, { roomId: 'gate-room-b', dockedAt: 43 }]);
    expect(live(r.stops[1], 1)).toBe(42);
    expect(live(r.stops[0], 0)).toBeNull();
    const wide = liveDockFrom([{ roomId: 'gate-room-b', dockedAt: 43 }], (st, room) => st.stationId === 'st-0' && room === 'gate-room-b');
    expect(wide(r.stops[0], 0)).toBe(43);
    expect(wide(r.stops[1], 1)).toBeNull();
  });
});

// ── A person at the helm ─────────────────────────────────────────────────────

describe('a person at the helm (A3.4)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r, { pilot: 'person' });
  const on = onTimeChain(r, s, 4);
  const D0 = on[0].depart;

  it('with no robot captain, the ferry waits for them, DELAYED, as long as it takes', () => {
    const people = peopleOnly(r);
    const ps = start(people, { pilot: 'person' });
    expect(at(people, [ps], D0 - SEC)).toMatchObject({ status: 'docked', departsAt: D0, overdue: false, pilot: 'person' });
    for (const t of [D0 + SEC, D0 + HOUR]) {
      expect(at(people, [ps], t)).toMatchObject({ status: 'docked', legSeq: 0, departsAt: D0, overdue: true, takeoverAt: null });
    }
  });

  it('a robot captain takes the helm 5 minutes after the missed departure and leaves at the next window', () => {
    const takeover = D0 + ROBOT_TAKEOVER_MS;
    const w = legWindowAfter(r, 0, takeover)!;
    expect(at(r, [s], D0 - SEC)).toMatchObject({ departsAt: D0, scheduledAt: D0, pilot: 'person', takeoverAt: takeover });
    expect(at(r, [s], D0 + MIN)).toMatchObject({ status: 'docked', departsAt: w.departAt, scheduledAt: D0, pilot: 'person', overdue: false });
    expect(at(r, [s], takeover + SEC)).toMatchObject({ status: 'docked', pilot: 'robot' });
    expect(at(r, [s], w.departAt + SEC)).toMatchObject({ status: 'in-flight', departedAt: w.departAt, pilot: 'robot' });
    // The robot keeps the helm after that.
    const next = legWindowAfter(r, 1, w.arriveAt + 60 * SEC)!;
    expect(at(r, [s], w.arriveAt + SEC)).toMatchObject({ legSeq: 1, pilot: 'robot', departsAt: next.departAt });
  });

  it('KEEP THE HELM restarts the 5 minutes', () => {
    const keep = helmCheckpoint(r, 0, { at: D0 + 4 * MIN, pilot: 'person' })!;
    expect(at(r, [s, keep], D0 + 4 * MIN + SEC).takeoverAt).toBe(keep.at + ROBOT_TAKEOVER_MS);
  });

  it('their route DEPART flies from the press, holding for the launch window', () => {
    const go = goCheckpoint(r, 0, { at: T0 + 100 * SEC, stayStart: T0 })!;
    const s100 = start(r, { pilot: 'person', fuel: 100 });
    expect(go.departAt).toBe(D0);
    expect(at(r, [s100, go], go.at - SEC, { capacity: 100 })).toMatchObject({ status: 'docked', fuel: 100 });
    expect(at(r, [s100, go], go.at + SEC, { capacity: 100 })).toMatchObject({
      status: 'in-flight', departedAt: D0, etaAt: go.arriveAt, pilot: 'person', fuel: 67,
    });
    // Pressed late, it takes the next window.
    const late = goCheckpoint(r, 0, { at: D0 + 30 * SEC, stayStart: T0 })!;
    expect(Math.abs(late.departAt - D0 - legWindowAfter(r, 0, 0)!.synodicMs)).toBeLessThan(1);
    expect(at(r, [s, late], late.at + SEC)).toMatchObject({ status: 'in-flight', departedAt: late.departAt });
  });

  it('HAND TO ROBOT after the departure passed leaves at the next window, robot flying', () => {
    const hand = helmCheckpoint(r, 0, { at: D0 + 90 * SEC, pilot: 'robot', stayStart: T0 })!;
    const w = legWindowAfter(r, 0, hand.at)!;
    expect(hand.departAt).toBe(w.departAt);
    expect(at(r, [s, hand], hand.at + SEC)).toMatchObject({ departsAt: w.departAt, pilot: 'robot', takeoverAt: null });
  });

  it('TAKE THE HELM in flight applies to the next stay, never to the leg flying', () => {
    const rs = start(r, { pilot: 'robot' });
    const ron = onTimeChain(r, rs, 3);
    const take = helmCheckpoint(r, 1, { at: ron[0].depart + 10 * SEC, pilot: 'person' })!;
    expect(at(r, [rs, take], ron[0].depart + 20 * SEC)).toMatchObject({ status: 'in-flight', pilot: 'robot' });
    expect(at(r, [rs, take], ron[0].arrive + SEC)).toMatchObject({ legSeq: 1, pilot: 'person' });
  });

  it('a robot pilot on a route with no robot captain reads as a person', () => {
    const people = peopleOnly(r);
    const ps = start(people, { pilot: 'robot' });
    expect(at(people, [ps], T0 + SEC).pilot).toBe('person');
    expect(at(people, [ps], D0 + HOUR)).toMatchObject({ legSeq: 0, overdue: true });
  });
});

// ── STOP ─────────────────────────────────────────────────────────────────────

describe('STOP (A3.6)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 6);
  const stopped = (t: number) => ({ ...r, stoppedAt: t });

  it('pressed at a stop well before its departure, the route ends there, pinned docked', () => {
    const rs = stopped(on[0].arrive + 10 * SEC);
    for (const t of [on[1].depart - SEC, on[1].depart + SEC, on[5].arrive + HOUR]) {
      expect(at(rs, [s], t)).toMatchObject({ status: 'docked', legSeq: 1, stopIndex: 1, ended: 'stop', departsAt: null });
    }
    expect(at(rs, [s], on[0].arrive + 5 * SEC)).toMatchObject({ legSeq: 1, ended: 'stop' });
  });

  it('pressed within 10 s of the departure, it ends at the next stop', () => {
    const rs = stopped(on[1].depart - 5 * SEC);
    expect(at(rs, [s], on[1].depart + SEC)).toMatchObject({ status: 'in-flight', legSeq: 1, stopping: true, ended: null });
    for (const t of [on[1].arrive + SEC, on[5].arrive + HOUR]) {
      expect(at(rs, [s], t)).toMatchObject({ status: 'docked', legSeq: 2, stopIndex: 0, ended: 'stop' });
    }
  });

  it('pressed in flight, it ends at the next stop', () => {
    const rs = stopped(on[0].depart + 10 * SEC);
    expect(at(rs, [s], on[0].depart + 20 * SEC).status).toBe('in-flight');
    expect(at(rs, [s], on[3].arrive)).toMatchObject({ legSeq: 1, ended: 'stop' });
  });

  it('pressed while holding, the ferry stays there, no longer holding', () => {
    const hold = holdCheckpoint(r, 1, { at: on[0].arrive + 5 * SEC });
    const rs = stopped(on[0].arrive + MIN);
    expect(at(rs, [s, hold], on[0].arrive + 2 * MIN)).toMatchObject({ legSeq: 1, ended: 'stop', holding: false });
  });

  it('pressed before the first departure, the route ends where it started', () => {
    expect(at(stopped(T0 + 10 * SEC), [s], on[2].arrive)).toMatchObject({ legSeq: 0, stopIndex: 0, ended: 'stop' });
  });
});

// ── Loop and back-and-forth ──────────────────────────────────────────────────

describe('loop and back-and-forth routes', () => {
  const visits = (r: ShipRoute, n: number) => {
    const s = start(r);
    const chain = onTimeChain(r, s, n);
    return chain.slice(0, n - 1).map((leg) => at(r, [s], leg.arrive + SEC).stopIndex);
  };

  it('a three-stop loop calls 1, 2, 0, 1 …', () => {
    expect(visits(running([0, 1, 2], 'loop'), 7)).toEqual([1, 2, 0, 1, 2, 0]);
  });

  it('a three-stop back-and-forth calls 1, 2, 1, 0 …', () => {
    expect(visits(running([0, 1, 2]), 7)).toEqual([1, 2, 1, 0, 1, 2]);
  });

  it('each stop keeps its own minimum wait', () => {
    const r = running([0, 1, 2], 'loop');
    r.stops[1] = { ...r.stops[1], waitSecs: 600 };
    const s = start(r);
    const chain = onTimeChain(r, s, 3);
    expect(chain[1].depart - chain[0].arrive).toBeGreaterThanOrEqual(600 * SEC);
    expect(at(r, [s], chain[0].arrive + SEC).departsAt).toBe(chain[1].depart);
  });
});

// ── Fuel (choice 4 b) ────────────────────────────────────────────────────────

describe('route fuel', () => {
  it('each leg burns its cost when the ferry goes in flight', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r, { fuel: 100 });
    const on = onTimeChain(r, s, 3);
    expect(at(r, [s], on[0].depart - SEC).fuel).toBe(100);
    expect(at(r, [s], on[0].depart + SEC).fuel).toBe(67);
    expect(at(r, [s], on[0].arrive + SEC).fuel).toBe(67);
    expect(at(r, [s], on[1].depart + SEC).fuel).toBe(34);
  });

  it('without the home refill, the route ends docked at the last stop the fuel reaches', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r, { fuel: 70 });
    const on = onTimeChain(r, s, 3);
    expect(at(r, [s], on[1].arrive + SEC)).toMatchObject({ legSeq: 2, fuel: 4, ended: 'fuel', status: 'docked', departsAt: null });
    expect(at(r, [s], on[1].arrive + 30 * HOUR)).toMatchObject({ legSeq: 2, ended: 'fuel' });
  });

  it('with the home refill, the tanks fill on each arrival at the first stop and it runs on', () => {
    const r = running(FERRY_SLOTS, 'backAndForth', { homeRefuel: true });
    const s = start(r, { fuel: 70 });
    const on = onTimeChain(r, s, 3);
    expect(at(r, [s], on[0].arrive + SEC, { capacity: 100 }).fuel).toBe(37);
    expect(at(r, [s], on[1].depart + SEC, { capacity: 100 }).fuel).toBe(4);
    expect(at(r, [s], on[1].arrive + SEC, { capacity: 100 }).fuel).toBe(100);
    const day = at(r, [s], T0 + 24 * HOUR, { capacity: 100 });
    expect(day.ended).toBeNull();
    expect(day.fuel).toBeGreaterThanOrEqual(34);
  });

  it('the refill is at stops[0], not wherever START was pressed', () => {
    const r = running([0, 1, 2], 'loop', { homeRefuel: true, startStop: 1 });
    const s = start(r, { fuel: 90 });
    const on = onTimeChain(r, s, 3); // 1 → 2 → 0 → 1
    const cost12 = routeLegFuel(r, 1, 2)!;
    const cost20 = routeLegFuel(r, 2, 0)!;
    expect(at(r, [s], on[0].arrive + SEC, { capacity: 100 }).fuel).toBe(90 - cost12);
    expect(at(r, [s], on[1].depart + SEC, { capacity: 100 }).fuel).toBe(90 - cost12 - cost20);
    expect(at(r, [s], on[1].arrive + SEC, { capacity: 100 }).fuel).toBe(100);
  });

  it('REFUEL sets the level at its stay, and the route runs on', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r, { fuel: 70 });
    const on = onTimeChain(r, s, 3);
    const refuel = fuelCheckpoint(r, 2, { at: on[1].arrive + 30 * SEC, fuel: 100 });
    const f = at(r, [s, refuel], on[1].arrive + 40 * SEC);
    expect(f).toMatchObject({ legSeq: 2, fuel: 100, ended: null });
  });

  it('fuel is clamped to the tanks fitted now', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r, { fuel: 100 });
    expect(at(r, [s], T0 + SEC, { capacity: 50 }).fuel).toBe(50);
    expect(at(r, [s], T0 + SEC, { capacity: 0 })).toMatchObject({ fuel: 0, ended: 'fuel' });
  });
});

// ── Pause and RESUME ─────────────────────────────────────────────────────────

describe('pause and RESUME', () => {
  const r = running([0, 1, 2]);
  const s = start(r);
  const on = onTimeChain(r, s, 4);
  const pause = pauseCheckpoint(r, 1, { at: on[0].arrive + 10 * SEC });

  it('DEPART off the route pauses it wherever the clock goes', () => {
    for (const t of [pause.at + SEC, on[3].arrive + HOUR]) {
      expect(at(r, [s, pause], t)).toMatchObject({ paused: true, legSeq: 1, stopIndex: 1, departsAt: null });
    }
  });

  it('RESUME at another stop restarts the timetable there, with a fresh minimum wait', () => {
    const k = nextStayAtStop(r, 1, 0); // the first later visit to stop 0
    expect(k).toBe(4);
    const resumeAt = pause.at + 90 * SEC; // faster than the route's own legs could get there
    const resume = dockCheckpoint(r, k, { at: resumeAt, pilot: 'robot', resume: true })!;
    expect(validateCheckpoints(r, [s, pause, resume], resumeAt + SEC).rejected).toEqual([]);
    const f = at(r, [s, pause, resume], resumeAt + SEC);
    expect(f).toMatchObject({ paused: false, legSeq: 4, stopIndex: 0, stayStart: resumeAt, departsAt: resume.departAt });
    expect(resume.departAt - resumeAt).toBeGreaterThanOrEqual(60 * SEC);
    // Pruned down to its anchor, it still reads the same.
    const pruned = new Set(checkpointsToPrune(r, [s, pause, resume], resumeAt + SEC));
    expect(pruned.has(pause)).toBe(true);
    const kept = [s, pause, resume].filter((e) => !pruned.has(e));
    expect(at(r, kept, resumeAt + 2 * MIN)).toEqual(at(r, [s, pause, resume], resumeAt + 2 * MIN));
  });

  it('a plain dock cannot resume a paused route', () => {
    const k = nextStayAtStop(r, 1, 0);
    const plain = dockCheckpoint(r, k, { at: pause.at + 90 * SEC, stayStart: pause.at + 90 * SEC, pilot: 'robot' })!;
    expect(at(r, [s, pause, plain], pause.at + 100 * SEC).paused).toBe(true);
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────

describe('pruning (A2)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r, { fuel: 80 });
  const on = onTimeChain(r, s, 2);
  const A0 = on[0].arrive;
  // A messy run: a hold and its dock at stay 1, a REFUEL there, TAKE in
  // flight, the person's DEPART, HAND TO ROBOT in flight, a REFUEL at stay 3,
  // and a hold and dock at stay 4 (the anchor).
  const hold1 = holdCheckpoint(r, 1, { at: A0 + 5 * SEC });
  const dock1 = dockCheckpoint(r, 1, { at: A0 + 400 * SEC, stayStart: A0 + 399 * SEC, pilot: 'robot' })!;
  const fuel1 = fuelCheckpoint(r, 1, { at: A0 + 410 * SEC, fuel: 90 });
  const helm2 = helmCheckpoint(r, 2, { at: dock1.departAt + 20 * SEC, pilot: 'person' })!;
  const go2 = goCheckpoint(r, 2, { at: dock1.arriveAt + 70 * SEC, stayStart: dock1.arriveAt })!;
  const helm3 = helmCheckpoint(r, 3, { at: go2.departAt + 10 * SEC, pilot: 'robot' })!;
  const fuel3 = fuelCheckpoint(r, 3, { at: go2.arriveAt + 5 * SEC, fuel: 100 });
  const D3 = legWindowAfter(r, 3, go2.arriveAt + 60 * SEC)!;
  const hold4 = holdCheckpoint(r, 4, { at: D3.arriveAt + 2 * SEC });
  const dock4 = dockCheckpoint(r, 4, { at: D3.arriveAt + 100 * SEC, stayStart: D3.arriveAt + 95 * SEC, pilot: 'robot' })!;
  const junk = { ...pauseCheckpoint(r, 3, { at: go2.arriveAt + 6 * SEC }), stationId: 'st-0' };
  const all: RouteCheckpoint[] = [s, hold1, dock1, fuel1, helm2, go2, helm3, fuel3, hold4, dock4];
  const now = dock4.at + SEC;

  it('the history is valid, and the newest timed entry anchors it', () => {
    const v = validateCheckpoints(r, all, now);
    expect(v.rejected).toEqual([]);
    expect(v.anchor).toBe(dock4);
  });

  it('deletes everything below the anchor but START and the newest helm and REFUEL', () => {
    const pruned = checkpointsToPrune(r, [...all, junk], now);
    expect(new Set(pruned)).toEqual(new Set([hold1, dock1, fuel1, helm2, go2, junk]));
    expect(pruned).not.toContain(dock4);
  });

  it('the timetable reads the same after pruning, with the same anchor', () => {
    const pruned = new Set(checkpointsToPrune(r, all, now));
    const kept = all.filter((e) => !pruned.has(e));
    expect(kept).toHaveLength(5);
    expect(validateCheckpoints(r, kept, now).anchor).toBe(dock4);
    for (const t of [now, dock4.departAt + SEC, dock4.arriveAt + SEC, now + HOUR, now + 30 * HOUR]) {
      expect(at(r, kept, t)).toEqual(at(r, all, t));
    }
  });

  it('with nothing timed there is nothing to prune', () => {
    expect(checkpointsToPrune(r, [hold1], now)).toEqual([]);
  });
});

describe('pruning keeps what the reader still needs (review fixes)', () => {
  it('⛽ a ferry refuelled at every stop, on time, keeps one REFUEL key, and reads the same', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r, { fuel: 40 }); // 33 a leg: it must refuel at every stop
    const on = onTimeChain(r, s, 30);
    const all: RouteCheckpoint[] = [s];
    for (let k = 1; k < 30; k++) all.push(fuelCheckpoint(r, k, { at: on[k - 1].arrive + 10 * SEC, fuel: 40 }));
    const now = on[28].arrive + 20 * SEC; // docked at stay 29, after its REFUEL
    expect(validateCheckpoints(r, all, now).rejected).toEqual([]);
    const pruned = new Set(checkpointsToPrune(r, all, now));
    const kept = all.filter((e) => !pruned.has(e));
    expect(kept).toEqual([s, all[29]]);
    for (const t of [now, on[29].depart + SEC, on[29].arrive + SEC]) {
      expect(at(r, kept, t)).toEqual(at(r, all, t));
    }
    expect(at(r, kept, now)).toMatchObject({ legSeq: 29, fuel: 40, ended: null });
    // With no REFUEL at the next stop, it ends there for fuel, as before.
    expect(at(r, kept, on[29].arrive + SEC)).toMatchObject({ legSeq: 30, ended: 'fuel' });
  });

  it('🔁 the RESUME dock survives pruning, so the entries after it still read', () => {
    const r = running([0, 1, 2]);
    const s = start(r);
    const on = onTimeChain(r, s, 4);
    const pause = pauseCheckpoint(r, 1, { at: on[0].arrive + 10 * SEC });
    const k = nextStayAtStop(r, 1, 0);
    const resume = dockCheckpoint(r, k, { at: pause.at + 90 * SEC, pilot: 'robot', resume: true })!;
    // Two stays on, a hold and its dock: the dock is the new floor.
    const w = legWindowAfter(r, k + 1, resume.arriveAt + 60 * SEC)!;
    const hold = holdCheckpoint(r, k + 2, { at: w.arriveAt + 2 * SEC });
    const dock = dockCheckpoint(r, k + 2, { at: w.arriveAt + 90 * SEC, stayStart: w.arriveAt + 85 * SEC, pilot: 'robot' })!;
    const all = [s, pause, resume, hold, dock];
    const now = dock.at + SEC;
    expect(validateCheckpoints(r, all, now).rejected).toEqual([]);
    const pruned = new Set(checkpointsToPrune(r, all, now));
    expect(pruned.has(resume)).toBe(false);
    expect(pruned.has(pause)).toBe(true);
    const kept = all.filter((e) => !pruned.has(e));
    expect(validateCheckpoints(r, kept, now).rejected).toEqual([]);
    for (const t of [now, dock.departAt + SEC, now + HOUR]) expect(at(r, kept, t)).toEqual(at(r, all, t));
  });

  it('🧭 a timed HAND TO ROBOT is no floor: TAKE over it later still reads the history', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r);
    const on = onTimeChain(r, s, 3);
    const A0 = on[0].arrive;
    const hold1 = holdCheckpoint(r, 1, { at: A0 + 5 * SEC });
    const dock1 = dockCheckpoint(r, 1, { at: A0 + 400 * SEC, stayStart: A0 + 399 * SEC, pilot: 'robot' })!;
    const take2 = helmCheckpoint(r, 2, { at: dock1.arriveAt + 5 * SEC, pilot: 'person' })!;
    const hand2 = helmCheckpoint(r, 2, { at: dock1.arriveAt + 10 * SEC, pilot: 'robot', stayStart: dock1.arriveAt })!;
    const withHand = [s, hold1, dock1, hand2];
    const now = hand2.at + SEC;
    expect(validateCheckpoints(r, withHand, now).anchor).toBe(hand2);
    const pruned = new Set(checkpointsToPrune(r, withHand, now));
    expect(pruned.size).toBe(0); // the floor is dock1 (stay 1), not the HAND
    // TAKE again at stay 2 rewrites that key, untimed.
    const retake = { ...take2, at: hand2.at + 5 * SEC };
    const after = withHand.filter((e) => !pruned.has(e) && e !== hand2).concat(retake);
    const full = [s, hold1, dock1, retake];
    for (const t of [retake.at + SEC, retake.at + HOUR]) expect(at(r, after, t)).toEqual(at(r, full, t));
  });

  it('🧭 a keeper\'s restart after a TAKE, stamped later, stands: the robot flies on', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r);
    const on = onTimeChain(r, s, 3);
    const take = helmCheckpoint(r, 1, { at: on[0].arrive + 5 * SEC, pilot: 'person' })!;
    // The robot captain took over; the keeper then restarted the stay (a
    // dock stamped robot), written after the TAKE.
    const restart = dockCheckpoint(r, 1, { at: take.at + 10 * MIN, stayStart: take.at + 10 * MIN, pilot: 'robot' })!;
    const f = at(r, [s, take, restart], restart.departAt + SEC);
    expect(f).toMatchObject({ legSeq: 1, status: 'in-flight', pilot: 'robot' });
    expect(at(r, [s, take, restart], restart.arriveAt + SEC)).toMatchObject({ legSeq: 2, pilot: 'robot' });
    // A TAKE after the restart is the newer word.
    const retake = { ...take, at: restart.at + SEC };
    expect(at(r, [s, retake, restart], restart.at + 2 * SEC).pilot).toBe('person');
  });
});

/** The flight when stay `legSeq` is first docked, walking the clock from `from`. */
function dockedAt(r: ShipRoute, ckpts: readonly RouteCheckpoint[], legSeq: number, from: number): RouteFlight {
  for (let t = from; t < from + 24 * HOUR; t += 5 * SEC) {
    const f = at(r, ckpts, t);
    if (f.legSeq === legSeq && f.status === 'docked') return f;
    if (f.legSeq > legSeq) break;
  }
  throw new Error(`stay ${legSeq} never docked`);
}

describe('⛔ a stop found gone (design §4)', () => {
  it('is passed at every later visit, and flagged from the stay after it was found', () => {
    const r = running([0, 1, 2], 'loop');
    const s = start(r);
    const on = onTimeChain(r, s, 2);
    const gone = skipCheckpoint(r, 1, { at: on[0].arrive + SEC, pilot: 'robot', why: 'gone' })!;
    const f1 = at(r, [s, gone], gone.at + SEC);
    expect(f1).toMatchObject({ legSeq: 1, stopIndex: 1, skipped: true, gone: false, goneStops: [] });
    const f2 = at(r, [s, gone], gone.arriveAt + SEC);
    expect(f2).toMatchObject({ legSeq: 2, stopIndex: 2, skipped: false, goneStops: [1], ended: null });
    // Stay 4 is stop 1 again: passed on arrival, as a skip, never docked.
    const back = dockedAt(r, [s, gone], 4, gone.arriveAt);
    expect(back).toMatchObject({ stopIndex: 1, skipped: true, gone: true, overdue: false, goneStops: [1] });
    expect(back.departsAt).toBe(legWindowAfter(r, 4, back.stayStart!)!.departAt); // no minimum wait
    // A dock at stay 5 is a new floor: the mark survives pruning, and stay 7
    // (stop 1 once more) is still passed.
    const f5 = dockedAt(r, [s, gone], 5, back.stayStart!);
    const dock5 = dockCheckpoint(r, 5, { at: f5.stayStart! + 70 * SEC, stayStart: f5.stayStart!, pilot: 'robot' })!;
    const all = [s, gone, dock5];
    const pruned = checkpointsToPrune(r, all, dock5.at + SEC);
    expect(pruned).toEqual([]);
    expect(dockedAt(r, all, 7, dock5.at)).toMatchObject({ stopIndex: 1, gone: true, skipped: true });
  });

  it('with fewer than two stops left, the route ends BLOCKED at the next one still there', () => {
    const r = running(FERRY_SLOTS);
    const s = start(r);
    const on = onTimeChain(r, s, 2);
    const gone = skipCheckpoint(r, 1, { at: on[0].arrive + SEC, pilot: 'robot', why: 'gone' })!;
    const f = at(r, [s, gone], gone.arriveAt + SEC);
    expect(f).toMatchObject({ legSeq: 2, stopIndex: 0, status: 'docked', ended: 'blocked', departsAt: null, goneStops: [1] });
    expect(at(r, [s, gone], gone.arriveAt + 30 * HOUR)).toMatchObject({ legSeq: 2, ended: 'blocked' });
    // STOP then ends it there for good.
    const stopped = { ...r, stoppedAt: gone.arriveAt + MIN };
    expect(at(stopped, [s, gone], gone.arriveAt + 2 * MIN)).toMatchObject({ legSeq: 2, ended: 'stop' });
    // A helm SKIP is no gone mark: the ferry comes back to that stop.
    const skip = skipCheckpoint(r, 1, { at: on[0].arrive + SEC, pilot: 'robot', why: 'helm' })!;
    expect(at(r, [s, skip], skip.arriveAt + SEC)).toMatchObject({ legSeq: 2, ended: null, goneStops: [] });
  });
});

describe('🛟 a pairing nobody aboard can release holds the stay (A5 Rights)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 3);

  it('a guest berth or another port docked before the departure keeps it docked, overdue', () => {
    const guest = liveDockFrom([{ roomId: 'guest-room', dockedAt: T0 + SEC, doorId: 'x+' }], undefined, { routePort: 'x-' });
    expect(guest.held).toBe(T0 + SEC);
    expect(at(r, [s], on[0].depart + HOUR, { liveDock: guest })).toMatchObject({ status: 'docked', legSeq: 0, overdue: true });
    // A dock on the route's own port is no hold of this kind (the live-dock
    // rule covers it at its own stop only).
    const own = liveDockFrom([{ roomId: 'elsewhere', dockedAt: T0 + SEC, doorId: 'x-' }], undefined, { routePort: 'x-' });
    expect(own.held).toBeNull();
    expect(at(r, [s], on[0].depart + SEC, { liveDock: own }).status).toBe('in-flight');
    // Made once the ferry had landed at its next stop: it holds nothing here.
    const late = liveDockFrom([{ roomId: 'guest-room', dockedAt: on[0].arrive + SEC, doorId: 'x+' }], undefined, { routePort: 'x-' });
    expect(at(r, [s], on[0].arrive + 2 * SEC, { liveDock: late })).toMatchObject({ legSeq: 1, overdue: false });
  });

  it('🕰️ a pairing stamped by a clock running ahead still holds the stay the ferry is at', () => {
    const ahead = liveDockFrom([{ roomId: 'guest-room', dockedAt: on[0].depart + HOUR, doorId: 'x+' }], undefined, { routePort: 'x-' });
    expect(at(r, [s], on[0].depart + SEC, { liveDock: ahead })).toMatchObject({ status: 'docked', legSeq: 0, overdue: true });
    // Without the route's port, a caller (a station's board) never sets it.
    expect(liveDockFrom([{ roomId: 'guest-room', dockedAt: T0, doorId: 'x+' }]).held).toBeNull();
  });
});

// ── The walk cache ───────────────────────────────────────────────────────────

describe('the walk cache', () => {
  const r = running(FERRY_SLOTS, 'backAndForth', { homeRefuel: true });
  const s = start(r, { fuel: 100 });
  const ck = [s];

  it('answers exactly as a fresh walk does, as the clock moves on', () => {
    const cache = createRouteWalkCache();
    for (let t = T0; t < T0 + 3 * HOUR; t += 37 * SEC) {
      expect(routeFlightAt(r, ck, null, t, 100, cache)).toEqual(routeFlightAt(r, ck, null, t, 100));
    }
  });

  it('walks again when a live dock older than its place turns up, or the clock goes back', () => {
    const cache = createRouteWalkCache();
    const on = onTimeChain(r, s, 30);
    routeFlightAt(r, ck, null, on[29].arrive, 100, cache);
    const docked: LiveDockAt = (_st, i) => (i === 1 ? on[4].arrive + SEC : null);
    expect(routeFlightAt(r, ck, docked, on[29].arrive + SEC, 100, cache)).toEqual(
      routeFlightAt(r, ck, docked, on[29].arrive + SEC, 100),
    );
    expect(routeFlightAt(r, ck, null, on[2].arrive, 100, cache)).toEqual(routeFlightAt(r, ck, null, on[2].arrive, 100));
  });

  it('a month of on-time legs walks once, then steps', () => {
    const cache = createRouteWalkCache();
    const month = T0 + 30 * 24 * HOUR;
    const first = routeFlightAt(r, ck, null, month, 100, cache)!;
    expect(first.legSeq).toBeGreaterThan(5000);
    const t = performance.now();
    for (let i = 1; i <= 100; i++) routeFlightAt(r, ck, null, month + i * SEC, 100, cache);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

// ── The flight PR 172's readers follow (A4) ──────────────────────────────────

describe('the resolved flight (A4)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r);
  const on = onTimeChain(r, s, 4);
  const stored: FlightRecord = { status: 'docked', locationId: 'furlong-station' };
  const alias = (id: string) => `here:${id}`;

  it('is PR 172\'s plain record: the route\'s own figures dropped, its station ids aliased', () => {
    const docked = at(r, [s], on[0].arrive + SEC);
    expect(routeFlightRecord(docked, alias)).toEqual({ status: 'docked', locationId: 'here:st-1' });
    const flying = at(r, [s], on[1].depart + SEC);
    expect(routeFlightRecord(flying, alias)).toEqual({
      status: 'in-flight', locationId: 'here:st-1', destinationId: 'here:st-0',
      departedAt: on[1].depart, etaAt: on[1].arrive,
    });
    expect(routeFlightRecord(flying)).toMatchObject({ locationId: 'st-1', destinationId: 'st-0' });
  });

  it('follows the timetable while the route runs unpaused, the stored record otherwise', () => {
    const flying = at(r, [s], on[0].depart + SEC);
    expect(routeRulesFlight(flying)).toBe(true);
    expect(resolvedFlight(stored, flying)).toMatchObject({ status: 'in-flight', departedAt: on[0].depart, etaAt: on[0].arrive });
    // Each leg lands and leaves with no write: the clock alone moves it.
    expect(resolvedFlight(stored, at(r, [s], on[0].arrive + SEC))).toEqual({ status: 'docked', locationId: 'st-1' });
    // No route, none anchored, or paused: the stored record.
    expect(resolvedFlight(stored, null)).toBe(stored);
    const pause = pauseCheckpoint(r, 1, { at: on[0].arrive + 10 * SEC });
    const paused = at(r, [s, pause], on[0].arrive + 20 * SEC);
    expect(routeRulesFlight(paused)).toBe(false);
    expect(resolvedFlight(stored, paused)).toBe(stored);
  });

  it('REFUEL on a route sets the level at the stay the ship is docked at, never in flight', () => {
    expect(routeRefuelStay(at(r, [s], on[0].arrive + SEC))).toBe(1);
    expect(routeRefuelStay(at(r, [s], T0 + SEC))).toBe(0);
    expect(routeRefuelStay(at(r, [s], on[1].depart + SEC))).toBeNull();
  });
});

describe("🚚 where a ruling timetable flies the ship (the route's own copy of each stop)", () => {
  const r = running([0, 1, 2], 'loop');
  const s = start(r);
  const on = onTimeChain(r, s, 3);
  const copyOf = (i: number) => ({ id: `st-${i}`, planetId: SOV, orbitSlot: i });
  // Stop 1's station moved to another planet before the ferry's leg out of
  // it (PR 174): the station list now places it there.
  const listed1 = { id: 'st-1', planetId: 'planet-aris', orbitSlot: 1 };

  it('the stay at a stop whose station has moved, and the leg out of it, are where the route copied the stops', () => {
    expect(routeFlightPlaces(r, at(r, [s], on[0].arrive + SEC))).toEqual({ from: copyOf(1), to: null });
    const leaving = at(r, [s], on[1].depart + SEC);
    expect(leaving).toMatchObject({ status: 'in-flight', stopIndex: 1, nextStopIndex: 2 });
    const places = routeFlightPlaces(r, leaving)!;
    expect(places).toEqual({ from: copyOf(1), to: copyOf(2) });
    // The station list's ends span two planets: no transfer to draw.
    expect(planTransfer(listed1, places.to!, on[1].depart - 1)).toBeNull();
    // The copies give the leg the timetable flies.
    const plan = planTransfer(places.from, places.to!, on[1].depart - 1)!;
    expect(plan).not.toBeNull();
    expect(Math.abs(plan.transferMs - (on[1].arrive - on[1].depart))).toBeLessThanOrEqual(1);
  });

  it("🎚️ carries a stop's copied altitude orbit, which its legs were priced on", () => {
    const orbit = { radiusKm: 7_000, phase0: 0.5 };
    const withOrbit = { ...r, stops: r.stops.map((st, i) => (i === 2 ? { ...st, orbit } : st)) };
    const places = routeFlightPlaces(withOrbit, at(r, [s], on[1].depart + SEC))!;
    expect(places.to).toEqual({ ...copyOf(2), orbit });
    expect(places.from).toEqual(copyOf(1));
  });

  it("names the stops by this install's ids", () => {
    const places = routeFlightPlaces(r, at(r, [s], on[1].depart + SEC), (id) => `here:${id}`);
    expect(places).toMatchObject({ from: { id: 'here:st-1' }, to: { id: 'here:st-2' } });
  });

  it('none while the timetable does not rule (no route, or paused): the station list places the ship then', () => {
    expect(routeFlightPlaces(r, null)).toBeNull();
    expect(routeFlightPlaces(null, at(r, [s], T0 + SEC))).toBeNull();
    const pause = pauseCheckpoint(r, 1, { at: on[0].arrive + 10 * SEC });
    expect(routeFlightPlaces(r, at(r, [s, pause], on[0].arrive + 20 * SEC))).toBeNull();
  });

  // Copilot (PR 180): the station list placed a ferry at its stay where the
  // stop's station had moved since, until the next departure.
  it("keeps a stay at a stop its station has left on the stop's copy, unless a live dock carries the ship along", () => {
    const stay = routeFlightPlaces(r, at(r, [s], on[0].arrive + SEC));
    const listed = (over: Partial<{ planetId: string; orbitSlot: number; moving: boolean }> = {}) =>
      ({ planetId: SOV, orbitSlot: 1, moving: false, ...over });
    // Moved planets, moved slots, between planets now, or listed nowhere.
    expect(routeStayOffList(stay, listed({ planetId: 'planet-aris' }), false)).toEqual(copyOf(1));
    expect(routeStayOffList(stay, listed({ orbitSlot: 3 }), false)).toEqual(copyOf(1));
    expect(routeStayOffList(stay, listed({ moving: true }), false)).toEqual(copyOf(1));
    expect(routeStayOffList(stay, null, false)).toEqual(copyOf(1));
    // Still where the route copied it: the station list places the ship.
    expect(routeStayOffList(stay, listed(), false)).toBeNull();
    // Planet ids read as the station list reads them.
    const planet = (id: string) => (id === 'planet-old-name' ? SOV : id);
    expect(routeStayOffList(stay, listed({ planetId: 'planet-old-name' }), false, planet)).toBeNull();
    // Docked: the station it is docked at carries it, wherever that went.
    expect(routeStayOffList(stay, listed({ planetId: 'planet-aris' }), true)).toBeNull();
    // In flight, or with no ruling timetable, the leg's own ends place it.
    expect(routeStayOffList(routeFlightPlaces(r, at(r, [s], on[1].depart + SEC)), null, false)).toBeNull();
    expect(routeStayOffList(null, null, false)).toBeNull();
  });

  it('🎚️ counts a station that changed altitude at the same slot as gone from the copy', () => {
    const orbit = { radiusKm: 7_000, phase0: 0.5 };
    const withOrbit = { ...r, stops: r.stops.map((st, i) => (i === 1 ? { ...st, orbit } : st)) };
    const stay = routeFlightPlaces(withOrbit, at(r, [s], on[0].arrive + SEC));
    const here = { planetId: SOV, orbitSlot: 1, moving: false };
    expect(routeStayOffList(stay, { ...here, orbit }, false)).toBeNull();
    expect(routeStayOffList(stay, { ...here, orbit: { ...orbit, phase0: orbit.phase0 + 2 * Math.PI } }, false)).toBeNull();
    expect(routeStayOffList(stay, { ...here, orbit: { ...orbit, radiusKm: 7_200 } }, false)).toEqual({ ...copyOf(1), orbit });
    expect(routeStayOffList(stay, here, false)).toEqual({ ...copyOf(1), orbit });
    // A copy on the slot's orbit, a station since on an altitude of its own.
    expect(routeStayOffList(routeFlightPlaces(r, at(r, [s], on[0].arrive + SEC)), { ...here, orbit }, false)).toEqual(copyOf(1));
  });
});

describe('copying the timetable back (A4)', () => {
  const r = running(FERRY_SLOTS);
  const s = start(r, { fuel: 70 });
  const on = onTimeChain(r, s, 4);
  const cost = routeLegFuel(r, 0, 1)!;
  const stopped = { ...r, stoppedAt: on[0].arrive + 10 * SEC };
  const home: FlightRecord = { status: 'docked', locationId: 'st-0' };
  const answered = { dockAnswered: true };

  it('after STOP, at the end stop, the derived flight and fuel are copied back', () => {
    const end = at(stopped, [s], on[3].arrive, { capacity: 100 });
    expect(end).toMatchObject({ ended: 'stop', stopIndex: 1 });
    expect(routeSettleAction(home, end, answered)).toEqual({
      kind: 'finish',
      writes: [{ status: 'docked', locationId: 'st-1' }],
      fuel: 70 - cost,
    });
  });

  it('a stored in-flight record (a person\'s route DEPART) goes through redocking', () => {
    const end = at(stopped, [s], on[3].arrive, { capacity: 100 });
    const flown: FlightRecord = { status: 'in-flight', locationId: 'st-0', destinationId: 'st-1', departedAt: on[0].depart, etaAt: on[0].arrive };
    expect(routeSettleAction(flown, end, answered)).toEqual({
      kind: 'finish',
      writes: [{ status: 'redocking', locationId: 'st-1', etaAt: on[0].arrive }, { status: 'docked', locationId: 'st-1' }],
      fuel: 70 - cost,
    });
  });

  it('waits for the end stop\'s dock to answer, for STOP, and for the end stop itself', () => {
    const end = at(stopped, [s], on[3].arrive, { capacity: 100 });
    expect(routeSettleAction(home, end, { dockAnswered: false })).toBeNull();
    // Not stopped: the route runs on, and robot legs never write the stored flight.
    expect(routeSettleAction(home, at(r, [s], on[0].arrive + SEC, { capacity: 100 }), answered)).toBeNull();
    // Stopped, still on the way to the end stop.
    const late = { ...r, stoppedAt: on[0].depart + 10 * SEC };
    expect(routeSettleAction(home, at(late, [s], on[0].depart + 20 * SEC, { capacity: 100 }), answered)).toBeNull();
    expect(routeSettleAction(home, at(late, [s], on[0].arrive + SEC, { capacity: 100 }), answered)).toMatchObject({ kind: 'finish' });
    // Out of fuel ends the route too, but only STOP finishes it.
    const dry = start(r, { fuel: cost - 1 });
    expect(routeSettleAction(home, at(r, [dry], on[0].depart + SEC, { capacity: 100 }), answered)).toBeNull();
    expect(routeSettleAction(home, at(stopped, [dry], on[0].depart + SEC, { capacity: 100 }), answered)).toMatchObject({
      kind: 'finish', writes: [{ status: 'docked', locationId: 'st-0' }], fuel: cost - 1,
    });
  });

  it('mid-route, a stored in-flight the timetable has landed is walked to docked there', () => {
    const flown: FlightRecord = { status: 'in-flight', locationId: 'st-0', destinationId: 'st-1', departedAt: on[0].depart, etaAt: on[0].arrive };
    // In flight on both: nothing to do.
    expect(routeSettleAction(flown, at(r, [s], on[0].depart + SEC), answered)).toBeNull();
    expect(routeSettleAction(flown, at(r, [s], on[0].arrive + SEC), { dockAnswered: false })).toEqual({
      kind: 'follow',
      writes: [{ status: 'redocking', locationId: 'st-1', etaAt: on[0].arrive }, { status: 'docked', locationId: 'st-1' }],
    });
  });

  it('a paused route or none leaves the stored records alone', () => {
    const pause = pauseCheckpoint(r, 1, { at: on[0].arrive + 10 * SEC });
    const flown: FlightRecord = { status: 'in-flight', locationId: 'st-1', destinationId: 'x', departedAt: 1, etaAt: 2 };
    expect(routeSettleAction(flown, at(stopped, [s, pause], on[3].arrive), answered)).toBeNull();
    expect(routeSettleAction(flown, null, answered)).toBeNull();
  });
});
