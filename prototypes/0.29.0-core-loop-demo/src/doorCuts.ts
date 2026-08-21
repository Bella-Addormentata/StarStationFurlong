/**
 * 🚪 #92: DOOR → HULL CUT collector — the door-side analogue of
 * `collectWindowOpenings` in `windowLayout.ts`. Walks the room's live door
 * records (`readAllDoorLayout`, falling back to `defaultDoorLayoutRecords` on
 * an unseeded room — identical branch to `reconcileDoorLayout`) and buckets a
 * `DoorOpening` per door onto its `DoorSurface` (side wall or end cap), for
 * `buildOctagonHull` / `buildOctagonShell` to punch through the barrel.
 *
 * The `along` coordinate falls out cleanly: the door layout stores each door's
 * `lateral` as the ALONG-WALL coord (X world for y± walls, Z world for x±
 * walls; see `poseFromWall`). On a SIDE WALL the strip's extrude coord (`b`
 * in `sectionToWorld`) is precisely that same axis, and on an END CAP the
 * strip's cross-section-a coord (`a` in `sectionToWorld`) is precisely that
 * same axis — see `doorSurfaceForWall` below. So `along === lateral` for
 * every wall, and there is nothing more to compute.
 *
 * Doors on the ROOF or the FLOOR are unrepresentable — `DoorWall` is one of
 * the four vertical walls by construction. A door record with an out-of-band
 * wall value would already have failed `isDoorLayoutRecord`'s shape guard, so
 * every survivor of `readAllDoorLayout()` maps cleanly here.
 *
 * PURE for testability: no THREE, no I/O beyond the doc read wrappers this
 * module imports. `doorSurfaceForWall` is exported so
 * `hullDoorCuts.test.ts` can pin the DoorWall → DoorSurface table under both
 * `narrowAxis` orientations without spinning up a world.
 */

import {
  readAllDoorLayout,
  defaultDoorLayoutRecords,
  doorSetIsAuthoritative,
} from './doorLayoutDoc';
import type { DoorWall } from './doorLayoutDoc';
import { DOOR_OPENING_WIDTH, DOOR_OPENING_HEIGHT } from './doorLayout';
import { roomHalfExtents } from './floorPlanDoc';
import { narrowAxisFor } from './hullSection';
import type { NarrowAxis } from './hullSection';
import type { DoorOpening, DoorSurface, HullDoorCuts } from './octagonHull';

/**
 * 🚪 #92: which of the 4 vertical hull faces a door on `wall` sits on, for the
 * given `narrowAxis`. The narrow-axis walls (perpendicular to the extrude axis)
 * ARE the side-wall STRIPS; the long-axis walls (perpendicular to the extrude
 * axis) are the END CAPS. A square room (halfX == halfZ) picks narrowAxis='x'
 * by tie-break, matching `narrowAxisFor` — that keeps the mapping deterministic
 * for the legacy default room layout.
 *
 * Signs align by axis label:
 *  - 'x-' / 'y-' → the -side (wall-neg or cap-neg)
 *  - 'x+' / 'y+' → the +side (wall-pos or cap-pos)
 *
 * Exported (unlike `collectDoorCuts` below) so the vitest suite in
 * `hullDoorCuts.test.ts` can verify the mapping without booting a world.
 */
export function doorSurfaceForWall(
  wall: DoorWall,
  narrowAxis: NarrowAxis,
): DoorSurface {
  if (narrowAxis === 'x') {
    // Narrow axis is X → the side walls sit at ±halfX (walls x±); the end caps
    // sit at ±halfZ (walls y±).
    switch (wall) {
      case 'x-': return 'wall-neg';
      case 'x+': return 'wall-pos';
      case 'y-': return 'cap-neg';
      case 'y+': return 'cap-pos';
    }
  } else {
    // Narrow axis is Z → the side walls sit at ±halfZ (walls y±); the end caps
    // sit at ±halfX (walls x±).
    switch (wall) {
      case 'y-': return 'wall-neg';
      case 'y+': return 'wall-pos';
      case 'x-': return 'cap-neg';
      case 'x+': return 'cap-pos';
    }
  }
}

/**
 * 🚪 #92: the current room's door openings bucketed by hull face — the ONE
 * source `world.addOctagonHull` / `exteriorView` both consume. Mirrors
 * `collectWindowOpenings` for windows: reads the synced layout doc, falls back
 * to `defaultDoorLayoutRecords` on an unseeded-but-not-marked-empty room (the
 * same fallback `reconcileDoorLayout` uses, so the hull's holes match the door
 * groups the docking system draws). Each door produces a rectangular notch of
 * `w = DOOR_OPENING_WIDTH` × `h = DOOR_OPENING_HEIGHT` centred at `along =
 * lateral`. `enabled` is NOT gated — a disabled door is still a physical hole
 * in the hull (the door LEAF stays but its interactivity is off; the hull
 * geometry must match the leaf that's rendered).
 */
export function collectDoorCuts(): HullDoorCuts {
  const out: HullDoorCuts = {};
  const push = (surface: DoorSurface, o: DoorOpening) => {
    (out[surface] ??= []).push(o);
  };
  const { halfX, halfZ } = roomHalfExtents();
  const narrowAxis = narrowAxisFor(halfX, halfZ);
  // Same fallback as reconcileDoorLayout: an unseeded-and-unmarked-empty room
  // renders its four cardinal defaults, so its hull must cut them too.
  const stored = readAllDoorLayout();
  const records =
    stored.size === 0 && !doorSetIsAuthoritative()
      ? defaultDoorLayoutRecords()
      : stored;
  for (const rec of records.values()) {
    const surface = doorSurfaceForWall(rec.wall, narrowAxis);
    push(surface, {
      along: rec.lateral,
      w: DOOR_OPENING_WIDTH,
      h: DOOR_OPENING_HEIGHT,
    });
  }
  return out;
}
