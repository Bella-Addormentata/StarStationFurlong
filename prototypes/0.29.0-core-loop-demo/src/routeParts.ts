/**
 * 🚏 A running ferry route's flight parts. Edit mode keeps the last helm,
 * engine block and fuel tank aboard while the ship's route runs (a paused
 * one included): without a helm nobody could STOP, SKIP or RESUME it (the
 * route keeper would fly on regardless), and without an engine or a tank the
 * module is no ship. Pure; pinned by routeParts.test.ts.
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
