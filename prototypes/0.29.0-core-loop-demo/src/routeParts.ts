/**
 * 🚏 A running ferry route's flight parts. Edit mode keeps the last helm,
 * engine block and fuel tank aboard while the ship's route runs (a paused
 * one included): without a helm nobody could STOP, SKIP or RESUME it (the
 * route keeper would fly on regardless), and without an engine or a tank the
 * module is no ship. And while the timetable flies the ship, its tanks stay
 * as they are (tanksLockedByRoute). Pure; pinned by routeParts.test.ts.
 */

import { FURNITURE_DEFS } from './furniture';
import type { FurnitureItem } from './furniture';

const ROUTE_PARTS: ReadonlyArray<{ fn: string; name: string }> = [
  { fn: 'helm', name: 'helm' },
  { fn: 'engine', name: 'engine block' },
  { fn: 'fuelTank', name: 'fuel tank' },
];

/** Would removing `itemId` (with `going`: it and what is mounted on it) take
 *  the last of a running route's parts? Its name, or null. */
export function lastRoutePartTaken(
  itemId: string,
  items: readonly FurnitureItem[],
  going: ReadonlySet<string>,
  routeRuns: boolean,
): string | null {
  if (!routeRuns || !going.has(itemId)) return null;
  for (const part of ROUTE_PARTS) {
    const is = (i: FurnitureItem) => FURNITURE_DEFS[i.kind]?.functions?.includes(part.fn) === true;
    if (items.some((i) => going.has(i.id) && is(i)) && !items.some((i) => !going.has(i.id) && is(i))) return part.name;
  }
  return null;
}

const isTank = (i: FurnitureItem) => FURNITURE_DEFS[i.kind]?.functions?.includes('fuelTank') === true;

/** ⛽ Why a tank can't be fitted or taken off (edit mode and the DEV menu). */
export const TANKS_LOCK_REFUSAL = "the ship's route is flying on these tanks. Pause the route at the helm first";

/**
 * ⛽ Would going from `before` to `after` change the ship's tanks while the
 * timetable flies it (`timetableRules`: shipRoute.routeRulesFlightNow, a
 * route running, anchored and not paused; STOP pressed included)? The
 * timetable replays every home refill at the tanks' capacity NOW
 * (devices.shipFuelCapacity, tanks x TANK_CAPACITY), so a tank fitted or
 * taken off mid-run would rewrite fuel the ferry already carried, and could
 * end the route for fuel at a stop it has long left. Paused, they may change:
 * RESUME writes the level afresh (a `fuel` entry at its stay) and the
 * timetable walks on from there. Only the number of tanks counts.
 */
export function tanksLockedByRoute(
  before: readonly FurnitureItem[],
  after: readonly FurnitureItem[],
  timetableRules: boolean,
): boolean {
  return timetableRules && before.filter(isTank).length !== after.filter(isTank).length;
}
