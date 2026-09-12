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
 * 🛡️ CLAMP AT THE BOUNDARY (PR #122 review): a door record is peer-writable
 * — `readAllDoorLayout` reads across the doc trust boundary, `isDoorLayoutRecord`
 * only guarantees the fields are the right SHAPE and finite, not that the
 * numbers name a location that fits the current room. A hostile or malformed
 * `lateral` (or a legitimate one on a room that shrank past it) would otherwise
 * feed the hull builder a cut running off the end of a strip or end cap. #130
 * makes floor-plan placements authoritative over hardcoded constants and so
 * WIDENS this domain, exactly where a boundary clamp is cheapest — one pass
 * over records at collection time rather than per-strip inside the mesh
 * builder. `bucketDoorCutsFromRecords` below is the seam; the mesh builders
 * still run their own final `clampedDoorCuts` for API callers who bypass this
 * collector, so the clamp is idempotent and belt-and-braces.
 *
 * PURE for testability: no THREE, no I/O beyond the doc read wrappers this
 * module imports. `doorSurfaceForWall` and `bucketDoorCutsFromRecords` are
 * exported so `hullDoorCuts.test.ts` can pin them (mapping table under both
 * `narrowAxis` orientations, hostile-record clamp/drop behaviour) without
 * spinning up a world or a Yjs doc.
 */

import {
  readAllDoorLayout,
  defaultDoorLayoutRecords,
  doorSetIsAuthoritative,
} from './doorLayoutDoc';
import type { DoorWall } from './doorLayoutDoc';
import { DOOR_OPENING_WIDTH, DOOR_OPENING_HEIGHT } from './doorLayout';
import { roomHalfExtents } from './floorPlanDoc';
import { computeOctagonProfile, narrowAxisFor } from './hullSection';
import type { NarrowAxis } from './hullSection';
import { clampedDoorCuts } from './octagonHull';
import type { DoorSurface, HullDoorCuts } from './octagonHull';

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
 * 🚪 #92 · PURE core of `collectDoorCuts` (PR #122 review §"clamp at the
 * boundary"): bucket door records onto their hull surfaces AND clamp each
 * opening to that surface's own extent, so a hostile or malformed record
 * (peer-writable — see `doorLayoutDoc.ts` header) cannot produce a cut that
 * runs off the end of a strip or end cap.
 *
 * Contract per surface: side walls (`wall-neg`/`wall-pos`) span the extrude
 * axis (along ∈ [−longHalf, longHalf]); end caps (`cap-neg`/`cap-pos`) span
 * the narrow-axis cross-section (along ∈ [−narrowHalf, narrowHalf]). Both
 * are the vertical [0, wallHeight] band. `clampedDoorCuts` handles the actual
 * clamping (drops an oversized `w`/`h`, shifts an out-of-range `along` back
 * to the inset limit) so every consumer of this function sees only cuts that
 * WILL fit — the mesh builders' own defensive clamp then becomes a no-op for
 * cuts that came through here.
 *
 * Pure: takes records + room half-extents, returns cuts. Exported so the
 * vitest suite can pin the hostile-record clamp/drop behaviour with numbers,
 * without spinning up a Yjs doc.
 */
export function bucketDoorCutsFromRecords(
  records: Iterable<{ wall: DoorWall; lateral: number }>,
  halfX: number,
  halfZ: number,
): HullDoorCuts {
  const narrowAxis = narrowAxisFor(halfX, halfZ);
  // computeOctagonProfile picks the same narrowAxis internally and derives
  // narrowHalf/longHalf/wallHeight from the same halfX/halfZ; call it ONCE
  // rather than re-deriving each extent by hand so a future default-tweak on
  // the profile (e.g. a non-4 wallHeight) can only agree with this collector.
  const { narrowHalf, longHalf, wallHeight } = computeOctagonProfile({ halfX, halfZ });

  // 1) Bucket raw openings per surface — the width/height come from THE
  //    door-geometry contract (doorLayout.ts), not the record, so a hostile
  //    record can only lie about `lateral` (and, indirectly, `wall`; but the
  //    shape guard already normalized that at the doc-read boundary).
  const raw: HullDoorCuts = {};
  for (const rec of records) {
    const surface = doorSurfaceForWall(rec.wall, narrowAxis);
    (raw[surface] ??= []).push({
      along: rec.lateral,
      w: DOOR_OPENING_WIDTH,
      h: DOOR_OPENING_HEIGHT,
    });
  }

  // 2) Clamp each surface's cuts to that surface's own extent. `clampedDoorCuts`
  //    DROPS any cut too wide/tall to fit (rather than crushing it), and SHIFTS
  //    an `along` that pokes past the wall back to the inset limit. Preserves
  //    input order for the survivors.
  const out: HullDoorCuts = {};
  const clampInto = (surface: DoorSurface, alongHalf: number): void => {
    const rawList = raw[surface];
    if (!rawList) return;
    const clamped = clampedDoorCuts(rawList, -alongHalf, alongHalf, wallHeight);
    if (clamped.length > 0) out[surface] = clamped;
  };
  clampInto('wall-neg', longHalf);
  clampInto('wall-pos', longHalf);
  clampInto('cap-neg', narrowHalf);
  clampInto('cap-pos', narrowHalf);
  return out;
}

/**
 * 🚪 #92: the current room's door openings bucketed by hull face — the ONE
 * source `world.addOctagonHull` / `exteriorView` both consume. Mirrors
 * `collectWindowOpenings` for windows: reads the synced layout doc, falls back
 * to `defaultDoorLayoutRecords` on an unseeded-but-not-marked-empty room (the
 * same fallback `reconcileDoorLayout` uses, so the hull's holes match the door
 * groups the docking system draws). Each door produces a rectangular notch of
 * `w = DOOR_OPENING_WIDTH` × `h = DOOR_OPENING_HEIGHT` centred at `along =
 * lateral`, then clamped to the surface's own extent (see
 * `bucketDoorCutsFromRecords`). `enabled` is NOT gated — a disabled door is
 * still a physical hole in the hull (the door LEAF stays but its interactivity
 * is off; the hull geometry must match the leaf that's rendered).
 */
export function collectDoorCuts(): HullDoorCuts {
  const { halfX, halfZ } = roomHalfExtents();
  // Same fallback as reconcileDoorLayout: an unseeded-and-unmarked-empty room
  // renders its four cardinal defaults, so its hull must cut them too.
  const stored = readAllDoorLayout();
  const records =
    stored.size === 0 && !doorSetIsAuthoritative()
      ? defaultDoorLayoutRecords()
      : stored;
  return bucketDoorCutsFromRecords(records.values(), halfX, halfZ);
}
