/**
 * 🚪 doorLayout — #66 audit remediation tests.
 *
 * This suite locks the pose-lookup contract in `doorLayout.ts` so a future
 * refactor cannot silently swap `physicalDoorPoseOrNull` for its "always
 * returns a pose" sibling in the wrong place — which is precisely the
 * defect the branch's `repositionPairedVestibules` had before this pass.
 *
 * Two related but DISTINCT behaviours:
 *
 *  1. `physicalDoorPoseOrNull(id)` is honest about a miss. A free `d:xxx`
 *     id absent from the live record snapshot returns `null` (not a pose).
 *     Callers that would otherwise mis-pose a physical mesh (a paired
 *     vestibule mid-walk-through whose door just vanished, an exterior
 *     projection of a far room's door) rely on the null return to skip.
 *
 *  2. `physicalDoorPose(id)` guarantees SOME pose for local rendering. A
 *     missing record with no LEGACY_ID_WALL entry falls back to the
 *     north-wall centre (with a console.warn) — legitimate for boot-time
 *     scenery that just needs *a* pose, wrong for anything that would
 *     teleport a live gangway. Making that fallback observable in a test
 *     is what stops a well-meaning caller from switching back.
 *
 * The four LEGACY ids (north/south/east/west) are self-describing even
 * without a record — the boot path in docking.buildPorts constructs those
 * berths before any room is entered — so both lookups agree on them.
 *
 * Tests DELIBERATELY reset the module's record snapshot in `beforeEach`
 * via `setDoorRecords(new Map())` so a prior test's writes cannot leak.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  physicalDoorPose,
  physicalDoorPoseOrNull,
  setDoorRecords,
  poseFromWall,
} from './doorLayout';

// A hostile / stale free-door id — the exact shape a paired-but-vanished
// door leaves behind. LEGACY_ID_WALL has NO entry for these, so the
// or-null read must return null and the fallback must warn.
const FREE_ID = 'd:free-abc';

beforeEach(() => {
  // Reset module state before every test (this module holds a doorRecords
  // singleton pushed by world.reconcileDoorLayout; tests own it entirely).
  setDoorRecords(new Map());
});

describe('physicalDoorPoseOrNull — the honest lookup', () => {
  it('returns null for a free d:xxx id with no live record', () => {
    // This is the branch that stops `repositionPairedVestibules` from
    // teleporting an orphan gangway to the north wall while the avatar
    // is still walking through it (see world.ts docstring).
    expect(physicalDoorPoseOrNull(FREE_ID)).toBeNull();
  });

  it('returns the wall pose when the free door DOES have a live record', () => {
    // Same free id, but now recorded on the y+ wall at lateral 2. Read
    // returns the on-wall pose — no fallback fires.
    setDoorRecords(new Map([[FREE_ID, { wall: 'y+', lateral: 2 }]]));
    const pose = physicalDoorPoseOrNull(FREE_ID);
    expect(pose).not.toBeNull();
    // z=+halfZ (default 6) and x=lateral (2) — the y+ wall's contract in
    // poseFromWall. This ALSO proves the lookup routes through poseFromWall
    // rather than a stale-cached pose.
    expect(pose).toEqual(poseFromWall('y+', 2, 2));
  });

  it('the four LEGACY cardinal ids still resolve without a record', () => {
    // No records set (beforeEach cleared them). The LEGACY_ID_WALL fallback
    // must recognise the four cardinal names — the boot-time state.
    expect(physicalDoorPoseOrNull('north')).toEqual(poseFromWall('y-', 0, 0));
    expect(physicalDoorPoseOrNull('south')).toEqual(poseFromWall('y+', 0, 0));
    expect(physicalDoorPoseOrNull('east')).toEqual(poseFromWall('x+', 0, 0));
    expect(physicalDoorPoseOrNull('west')).toEqual(poseFromWall('x-', 0, 0));
  });

  it('a live record BEATS the LEGACY fallback for a cardinal id', () => {
    // If the room stored `north` on x-, the live record wins — LEGACY is
    // only for the un-reconciled boot state.
    setDoorRecords(new Map([['north', { wall: 'x-', lateral: 3 }]]));
    expect(physicalDoorPoseOrNull('north')).toEqual(poseFromWall('x-', 3, 3));
  });
});

describe('physicalDoorPose — the guaranteed-pose wrapper', () => {
  // The fallback path emits a one-shot warn per id. Because the warned set is
  // module-scoped and persists across tests, we suppress the sink here so
  // vitest's console isolation stays clean.
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => warnSpy.mockClear());

  it('falls back to the north-wall centre for a free id with no record', () => {
    // This is the wrong-for-a-vestibule behaviour repositionPairedVestibules
    // used to inherit. The test PINS the fallback (so a caller who reaches
    // for it does so knowingly) rather than removing it.
    // FREE_ID has never been warned about yet — first miss triggers the sink.
    const uniqueId = `d:free-warntest-${Date.now()}-${Math.random()}`;
    const pose = physicalDoorPose(uniqueId);
    expect(pose).toEqual(poseFromWall('y-', 0, 0));
  });

  it('agrees with physicalDoorPoseOrNull on every id that resolves', () => {
    // The wrapper is `or-null ?? fallback`. Whenever or-null returns a pose,
    // the wrapper must return the SAME pose — no accidental override.
    setDoorRecords(new Map([[FREE_ID, { wall: 'x+', lateral: -1 }]]));
    expect(physicalDoorPose(FREE_ID)).toEqual(physicalDoorPoseOrNull(FREE_ID));
    expect(physicalDoorPose('north')).toEqual(physicalDoorPoseOrNull('north'));
  });
});
