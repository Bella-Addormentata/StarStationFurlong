/**
 * 🎰 Stands — designated STANDING positions at tables (#76), DERIVED from the
 * furniture registry (StandTemplates on each FurnitureDef; see furniture.ts).
 *
 * Unlike seats, a stand has no sit slide: the avatar walks to `front` (a
 * walkable, A*-reachable point ringing the table) and faces the table. Several
 * stands ring one table so multiple players can gather (roulette: 6, one of
 * them the reserved wheel-head; chess: 2).
 *
 * STANDS keeps its array identity: rebuildStands() refills it in place, so it
 * stays in sync after obstacle/grid rebuilds (same call order as rebuildSeats:
 * rebuildObstacles → rebakeWalkableGrid → rebuildSeats → rebuildStands).
 */

import { FURNITURE, buildStandList, type StandSlot } from "./furniture";
import { GRID_SIZE, walkable, worldToCol, worldToRow } from "./pathfinding";

export type { StandSlot };

export const STANDS: StandSlot[] = [];

/** Re-derive STANDS from the furniture registry + current walkable grid. */
export function rebuildStands(): void {
  STANDS.length = 0;
  STANDS.push(
    ...buildStandList(FURNITURE, (x, z) => {
      const row = worldToRow(z);
      const col = worldToCol(x);
      return (
        row >= 0 &&
        row < GRID_SIZE &&
        col >= 0 &&
        col < GRID_SIZE &&
        walkable[row][col]
      );
    }),
  );
}

rebuildStands();

/** All stand slots belonging to one furniture item (id prefix `${itemId}:s`). */
export function standsForItem(itemId: string): StandSlot[] {
  return STANDS.filter((s) => s.id.startsWith(`${itemId}:s`));
}
