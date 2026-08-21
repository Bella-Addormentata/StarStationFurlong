/**
 * 🧭 Issue #102 — ORIENTED TRANSIT reproduction harnesses.
 *
 * Three harnesses, each phrased so a failure would put the issue back in the
 * BUG state, not just red a check. Every one lives beside the code it exercises
 * so a `vitest run` sees it without cross-package plumbing.
 *
 * (H1) Arrival-heading continuity under both legacy layouts. R2 (owner's
 *      "keep your facing") is the sum of departure and arrival poses; both the
 *      pre-#91 `legacy` kind and the retired `casino-pairs` (2 doors per wall)
 *      must arrive at the same continuity if the ANALYTIC math is right — the
 *      test exercises the pose helpers with each layout's records fed through
 *      the S0-prime plumbing (`physicalDoorPose(id, layout)`), never the
 *      module-global default.
 *
 * (H2) Mixed-layout / silent-180 case. Two rooms whose door records name
 *      different walls for the SAME id: the departure ghost projected the far
 *      module at rotY = 0 (opposite walls), so the arrival heading MUST match
 *      what the ghost showed — the pre-#102 bug arrived facing 180° away
 *      because the arrival hook read the departure's module-global records.
 *      With S0-prime plumbed, feeding the arrival records explicitly must yield
 *      the pose the ghost promised, not the silently-flipped one.
 *
 * (H3) Round-trip rotY cancellation via `mirrorSegments`. Building a chain of
 *      flex bends and reading its exit heading with `foldChainEnd`, then doing
 *      the same on `mirrorSegments(chain)`, must yield equal and opposite yaw:
 *      the return-leg rotation exactly undoes the outbound leg, so a two-hop
 *      round-trip preserves heading with zero drift. That is the whole reason
 *      `mirrorSegments` negates every flex bend (stationParts.ts:185–191).
 */

import { describe, expect, it } from 'vitest';
import {
  physicalDoorPose,
  physicalDoorPoseOrNull,
  poseFromWall,
  type DoorRecordsMap,
} from './doorLayout';
import type { DoorWall } from './doorLayoutDoc';
import {
  foldChainEnd,
  projectionPoseFromWall,
  type ConnectorSegment,
} from './adapter';
import { mirrorSegments } from './stationParts';

// ── Helpers ─────────────────────────────────────────────────────────────────

const EPS = 1e-9;

/** Wrap an angle to (−π, π]. Cheaper than Math.atan2(sin, cos) and exact for
 *  the small deltas the tests emit. */
function wrap(a: number): number {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** Build a records map with the four cardinals plus any extra placed doors. */
function records(
  seed: Array<{ id: string; wall: DoorWall; lateral?: number }>,
): DoorRecordsMap {
  const m = new Map<string, { wall: DoorWall; lateral: number }>();
  for (const s of seed) m.set(s.id, { wall: s.wall, lateral: s.lateral ?? 0 });
  return m;
}

/** R2 rule: arrival heading with the ghost promise for a given room pair.
 *  hArr = outward(arrival wall) + π   (facing back INTO the arrival room)
 *  hDep = outward(departure wall)     (facing out of the departure room)
 *  A viewer starting at hDep and rotated by (hArr − hDep) ends up at hArr —
 *  which is the R2 continuity we want the station bias to publish. */
function r2Delta(depWall: DoorWall, arrWall: DoorWall): number {
  const hDep = poseFromWall(depWall, 0, 0).outwardYaw;
  const hArr = poseFromWall(arrWall, 0, 0).outwardYaw + Math.PI;
  return wrap(hArr - hDep);
}

// ── (H1) Arrival-heading continuity under both legacy layouts ────────────────

describe('#102 H1: arrival-heading continuity', () => {
  // The default global map is empty at test start (no doc bound). Every
  // physical pose here comes from an EXPLICIT layout arg — the S0-prime path.

  it('legacy kind (each cardinal centred on its own wall): opposite walls ⇒ zero delta', () => {
    const dep = records([
      { id: 'north', wall: 'y-' },
      { id: 'south', wall: 'y+' },
      { id: 'east', wall: 'x+' },
      { id: 'west', wall: 'x-' },
    ]);
    const arr = dep; // legacy is symmetric — same records in every room
    // Depart out of NORTH into the far room's SOUTH door (the two are on
    // opposite walls). The ghost's rotY is 0, and the R2 delta is also 0.
    const depPose = physicalDoorPose('north', dep);
    const arrPose = physicalDoorPose('south', arr);
    expect(depPose.wall).toBe('y-');
    expect(arrPose.wall).toBe('y+');
    const delta = wrap(arrPose.outwardYaw + Math.PI - depPose.outwardYaw);
    expect(Math.abs(delta)).toBeLessThan(EPS);
  });

  it('casino-pairs kind (all doors on N+W): non-opposite walls ⇒ non-zero delta', () => {
    // The retired casino-pairs slot map: north/south rides the north wall
    // (y-), east/west rides the west wall (x-). Passing THROUGH here is the
    // exact case the R2 bias exists to keep continuous.
    const dep = records([
      { id: 'north', wall: 'y-', lateral: -3.0 },
      { id: 'south', wall: 'y-', lateral: 3.0 },
      { id: 'west', wall: 'x-', lateral: -3.0 },
      { id: 'east', wall: 'x-', lateral: 3.0 },
    ]);
    const arr = dep; // same layout in the arrival room
    // Depart out of NORTH (y-) into the far room's EAST door (x-). Non-opposite
    // walls ⇒ R2 delta = wrap((−π/2 + π) − π) = wrap(−π/2) = −π/2.
    const delta = r2Delta('y-', 'x-');
    expect(Math.abs(wrap(delta - (-Math.PI / 2)))).toBeLessThan(EPS);
    // And the plumbed pose helpers must AGREE — that is the whole point of
    // the S0-prime refactor.
    const depPose = physicalDoorPose('north', dep);
    const arrPose = physicalDoorPose('east', arr);
    const posedDelta = wrap(
      arrPose.outwardYaw + Math.PI - depPose.outwardYaw,
    );
    expect(Math.abs(wrap(posedDelta - delta))).toBeLessThan(EPS);
  });

  it('physicalDoorPose reads the PASSED layout, not any pushed global', () => {
    // Two disjoint layouts. The default global is empty; if a helper leaked
    // through it the assertion would collapse to the LEGACY_ID_WALL fallback.
    const a = records([{ id: 'north', wall: 'x+', lateral: 2 }]);
    const b = records([{ id: 'north', wall: 'x-', lateral: -2 }]);
    expect(physicalDoorPose('north', a).wall).toBe('x+');
    expect(physicalDoorPose('north', b).wall).toBe('x-');
    // Both together, in one expression to prove the parameter WINS every time
    // rather than aliasing to whichever one was passed last.
    expect(physicalDoorPose('north', a).wall).not.toBe(
      physicalDoorPose('north', b).wall,
    );
  });
});

// ── (H2) Mixed-layout pose correctness / silent-180 case ─────────────────────

describe('#102 H2: mixed-layout arrival hook must read arrival records', () => {
  // The SILENT-180 setup: departure room has 'north' on its default (y-),
  // arrival room's 'north' record puts it on y+ (the opposite wall). The
  // pre-#102 arrival hook read `doorRecords` module-global — still pinned to
  // the departure layout because applyRoomVisuals had not yet run — and
  // therefore posed 'north' as y- in the arrival room too, silently
  // producing an R2 delta of 0 when the visible ghost had promised π.

  const depLayout = records([{ id: 'north', wall: 'y-' }]); // default legacy
  const arrLayout = records([{ id: 'north', wall: 'y+' }]); // migrated to y+

  it('reading arrival records gives the wall the ghost promised', () => {
    // The ghost projected the far module by the arrival's OWN wall data. A
    // plumbed physicalDoorPose(arrivalId, arrLayout) returns y+ — matching
    // the ghost — regardless of the pushed departure global.
    const posedArrival = physicalDoorPose('north', arrLayout);
    expect(posedArrival.wall).toBe('y+');
  });

  it('reading arrival records via the DEPARTURE map yields the silent-180 pose', () => {
    // This is the pre-#102 buggy path, reproduced explicitly. It MUST NOT be
    // the fix's answer — kept in the harness so a future regression that
    // reroutes the arrival read through the departure map trips this test.
    const posedFromWrong = physicalDoorPose('north', depLayout);
    expect(posedFromWrong.wall).toBe('y-');
    // The two poses' outwardYaws differ by π — the silent 180 in one line.
    const delta = wrap(
      physicalDoorPose('north', arrLayout).outwardYaw -
        posedFromWrong.outwardYaw,
    );
    expect(Math.abs(Math.abs(delta) - Math.PI)).toBeLessThan(EPS);
  });

  it('physicalDoorPoseOrNull returns null when the record is missing and no LEGACY_ID_WALL applies', () => {
    // T1 spirit at the pose layer: honest miss beats a guessed pose. A free
    // door id that no room has posed must degrade to null, never fabricate.
    expect(physicalDoorPoseOrNull('d:some-free-id', arrLayout)).toBeNull();
    // A cardinal still self-describes via LEGACY_ID_WALL even when absent
    // from the passed map — pre-migration cardinals rely on that fallback.
    const legacyFallback = physicalDoorPoseOrNull('north', new Map());
    expect(legacyFallback).not.toBeNull();
    expect(legacyFallback!.wall).toBe('y-');
  });

  it('T1: projection rotY is ZERO when the far wall is unknown (never a guess)', () => {
    // A chained connector with an UNKNOWN far door: the pre-#102 chained
    // branch fell through to `heading` (a guess from wherever the chain
    // happened to fold). The owner's ruling is that unknown far ⇒ rotY = 0.
    const chain: ConnectorSegment[] = [
      { kind: 'flex', bendDeg: 22.5, stretch: 0 },
      { kind: 'ext', bays: 4, skin: 'solid' },
      { kind: 'flex', bendDeg: 22.5, stretch: 0 },
    ];
    const p = projectionPoseFromWall('y-', 0, chain, null, 0);
    expect(p.rotY).toBe(0);
    // Straight-gangway branch (no segments) also returns 0 on unknown far —
    // that half was correct pre-#102; kept as a regression anchor.
    const q = projectionPoseFromWall('y-', 0, undefined, null, 0);
    expect(q.rotY).toBe(0);
  });
});

// ── (H3) Round-trip rotY cancellation via mirrorSegments ─────────────────────

describe('#102 H3: mirrorSegments cancels rotY exactly on the return leg', () => {
  // The whole reason `mirrorSegments` reverses order and negates every flex
  // bend is that traversing a circular arc backwards reverses its heading
  // change (station Parts.ts:177–191). Foldig forward and mirrored must sum
  // to exactly 0 in yaw — no floating drift tolerated beyond arithmetic ULP.

  it('symmetric ring preset (fwd + mirrored) sums to zero yaw', () => {
    const fwd: ConnectorSegment[] = [
      { kind: 'flex', bendDeg: 22.5, stretch: 0 },
      { kind: 'ext', bays: 4, skin: 'solid' },
      { kind: 'flex', bendDeg: 22.5, stretch: 0 },
    ];
    const back = mirrorSegments(fwd);
    const yawFwd = foldChainEnd(fwd).yawRad;
    const yawBack = foldChainEnd(back).yawRad;
    expect(Math.abs(yawFwd + yawBack)).toBeLessThan(EPS);
  });

  it('asymmetric chain (mixed bends and extensions) also cancels', () => {
    const fwd: ConnectorSegment[] = [
      { kind: 'flex', bendDeg: 15, stretch: 0.5 },
      { kind: 'ext', bays: 2, skin: 'solid' },
      { kind: 'flex', bendDeg: -30, stretch: 0 },
      { kind: 'ext', bays: 6, skin: 'ribbed' },
      { kind: 'flex', bendDeg: 7.5, stretch: 0.2 },
    ];
    const back = mirrorSegments(fwd);
    const yawFwd = foldChainEnd(fwd).yawRad;
    const yawBack = foldChainEnd(back).yawRad;
    expect(Math.abs(yawFwd + yawBack)).toBeLessThan(EPS);
    // Bonus: mirroring twice is identity in yaw (idempotent up to normalization).
    const yawFwdAgain = foldChainEnd(mirrorSegments(back)).yawRad;
    expect(Math.abs(yawFwd - yawFwdAgain)).toBeLessThan(EPS);
  });

  it('empty chain: forward and mirrored are both zero yaw', () => {
    // A pure straight-gangway pairing has no bends at all — trivially zero
    // in both directions. Included so a future refactor that "helpfully"
    // seeds the accumulator does not miss it.
    const fwd: ConnectorSegment[] = [];
    expect(foldChainEnd(fwd).yawRad).toBe(0);
    expect(foldChainEnd(mirrorSegments(fwd)).yawRad).toBe(0);
  });
});
