/**
 * 🚏⏱️ How far a reader walks a long-running timetable (pilotRoute.ts).
 *
 * Robot legs write no checkpoint, so a reader that joins a ferry which has
 * run for weeks lays every stay since the newest entry end to end. The
 * keeper writes a `dock` anchor every ROUTE_ANCHOR_EVERY_STAYS stays
 * (routeKeeper.ts), and these tests count the launch windows a reader plans
 * (stationDirectory.planRecordHop) to show the walk stays short however far
 * the anchor is from START.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hops = vi.hoisted(() => ({ n: 0 }));
vi.mock('./stationDirectory', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stationDirectory')>();
  return {
    ...real,
    planRecordHop: (...args: Parameters<typeof real.planRecordHop>) => {
      hops.n++;
      return real.planRecordHop(...args);
    },
  };
});

import {
  ROUTE_ANCHOR_EVERY_STAYS,
  checkpointsToPrune,
  dockCheckpoint,
  routeFlightAt,
  routeLegFuel,
  startCheckpoint,
  validateCheckpoints,
} from './pilotRoute';
import type { RouteFlight } from './pilotRoute';
import type { RouteStop, ShipRoute } from './shipRoute';

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function stop(i: number, slot: number): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', anyGate: true },
    waitSecs: 60,
  };
}

/** Three stops back and forth from T0, refilled at home: runs for ever. */
const route: ShipRoute = {
  stops: [stop(0, 0), stop(1, 1), stop(2, 3)],
  shape: 'backAndForth',
  shipPort: 'x-',
  robotDockId: 'dock-1',
  homeRefuel: true,
  startedAt: T0,
  startStop: 0,
};
/** Room for one cycle and a bit: the home refill matters on every cycle. */
const CAP = 5 * Math.max(routeLegFuel(route, 0, 1)!, routeLegFuel(route, 1, 2)!);
const s = startCheckpoint(route, { at: T0, pilot: 'robot', fuel: CAP })!;

/** The flight at `now` with START alone (the long walk). */
function bare(now: number): RouteFlight {
  const f = routeFlightAt(route, [s], null, now, CAP);
  if (!f) throw new Error('no timetable');
  return f;
}

/** A docked stay a month in, and the keeper's anchor for it. */
function anchoredMonthIn(): { f: RouteFlight; anchor: NonNullable<ReturnType<typeof dockCheckpoint>> } {
  let now = T0 + 30 * DAY;
  let f = bare(now);
  while (f.status !== 'docked' || f.stayStart === null) {
    now += 20 * SEC;
    f = bare(now);
  }
  const anchor = dockCheckpoint(route, f.legSeq, { at: now, stayStart: f.stayStart, pilot: 'robot' })!;
  return { f, anchor };
}

describe('a long-running timetable', () => {
  beforeEach(() => { hops.n = 0; });

  it('an anchor says what the timetable says: every later flight is the same, fuel and pilot too', () => {
    const { f, anchor } = anchoredMonthIn();
    expect(f.legSeq).toBeGreaterThan(4 * ROUTE_ANCHOR_EVERY_STAYS);
    expect(anchor).toMatchObject({ kind: 'dock', legSeq: f.legSeq, stayStart: f.stayStart, departAt: f.departsAt, arriveAt: f.arrivesAt });
    for (const later of [anchor.at, anchor.at + 30 * SEC, anchor.at + HOUR, anchor.at + DAY]) {
      expect(routeFlightAt(route, [s, anchor], null, later, CAP)).toEqual(bare(later));
    }
    // Nothing else to prune: START stays, and the anchor is the newest entry.
    expect(checkpointsToPrune(route, [s, anchor], anchor.at)).toEqual([]);
  });

  it('a reader checks an anchor a month from START without laying every stay end to end', () => {
    const { f, anchor } = anchoredMonthIn();
    hops.n = 0;
    const v = validateCheckpoints(route, [s, anchor], anchor.at);
    expect(v.rejected).toEqual([]);
    expect(v.anchor).toEqual(anchor);
    expect(hops.n).toBeLessThan(3 * ROUTE_ANCHOR_EVERY_STAYS);
    // …and walks on from it, not from START.
    hops.n = 0;
    expect(routeFlightAt(route, [s, anchor], null, anchor.at + HOUR, CAP)?.legSeq).toBeGreaterThan(f.legSeq);
    expect(hops.n).toBeLessThan(3 * ROUTE_ANCHOR_EVERY_STAYS);
  });

  it('an entry thousands of stays past the anchor is ahead of the clock, found without walking there', () => {
    const { anchor } = anchoredMonthIn();
    const far = dockCheckpoint(route, anchor.legSeq + 3 * ROUTE_ANCHOR_EVERY_STAYS, { at: anchor.at, stayStart: anchor.at, pilot: 'robot' })!;
    hops.n = 0;
    const v = validateCheckpoints(route, [s, anchor, far], anchor.at);
    expect(v.rejected).toEqual([{ entry: far, reason: 'ahead' }]);
    expect(v.anchor).toEqual(anchor);
    expect(hops.n).toBeLessThan(3 * ROUTE_ANCHOR_EVERY_STAYS);
  });

  it('an anchor that claims the ship got there sooner than any chain of transfers could is still refused', () => {
    const { anchor } = anchoredMonthIn();
    const early = dockCheckpoint(route, anchor.legSeq, { at: T0 + HOUR, stayStart: T0 + HOUR, pilot: 'robot' })!;
    const v = validateCheckpoints(route, [s, early], anchor.at);
    expect(v.rejected).toEqual([{ entry: early, reason: 'early' }]);
  });
});
