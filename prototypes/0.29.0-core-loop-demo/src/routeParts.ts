/**
 * 🚏 A running ferry route's flight parts. Edit mode keeps the last helm,
 * engine block and fuel tank aboard while the ship's route runs (a paused
 * one included): without a helm nobody could STOP, SKIP or RESUME it (the
 * route keeper would fly on regardless), and without an engine or a tank the
 * module is no ship. The route's ship port stays too, its door and the
 * docking port on it, in edit mode and at the keypad (routePortTaken). And
 * while the timetable flies the ship, its tanks stay as they are
 * (tanksLockedByRoute). The DEV menu's PLACE, which replaces every piece in
 * the room, waits for the route to stop (templateSwapLockedByRoute). Pure;
 * pinned by routeParts.test.ts.
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

/** 🏗️ Why the DEV menu's PLACE can't put a template in the room now. */
export const TEMPLATE_SWAP_REFUSAL = "the ship's route is running, and a template replaces its helm, engine, tanks and robot captain. Stop the route at the helm first";

/**
 * 🏗️ May the DEV menu's PLACE not swap the room's furniture for a template?
 * Never while the ship's route runs, a paused one included: PLACE replaces
 * every piece in the room, so it would take the route's last helm, engine
 * and tank (lastRoutePartTaken) and its robot captain's dock all at once,
 * each of which edit mode refuses on its own. ADD keeps every piece, so it
 * only answers to tanksLockedByRoute. `route`: the ship's route.
 */
export function templateSwapLockedByRoute(route: { startedAt?: number } | null): boolean {
  return !!route && route.startedAt !== undefined;
}

/** 🚪 Why the route's ship port can't be removed now (edit mode's door, the
 *  keypad's PORT). */
export const ROUTE_PORT_REFUSAL = "the ship's route docks through this door. Stop the route at the helm first";

/**
 * 🚪 Would removing door `doorId`, or the docking port on it, take a running
 * route's ship port (a paused route included)? The keeper docks and casts off
 * through it at every stop, and in flight it is unpaired, so edit mode's
 * paired-door refusal (and the keypad's docked one) would let it go and leave
 * the ferry nowhere to dock. `route`: the ship's route.
 */
export function routePortTaken(doorId: string, route: { shipPort: string; startedAt?: number } | null): boolean {
  return !!route && route.startedAt !== undefined && route.shipPort === doorId;
}
