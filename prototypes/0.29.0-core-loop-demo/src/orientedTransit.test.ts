/**
 * 🧭 Issue #102 — ORIENTED TRANSIT reproduction harnesses.
 *
 * Round 1 harnesses (H1/H2/H3) — the pose primitives.
 * Round 1 audit-remediation harnesses (H2b, H4, H5) — the composite path and
 * the two audit findings that survived the primitives being correct.
 *
 * Each harness is phrased so a failure would put the issue back in the BUG
 * state, not just red a check. All live beside the code they exercise so a
 * `vitest run` sees them without cross-package plumbing.
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
 * (H2b — audit round 1) End-to-end composition of the arrival hook: bind a
 *      real Yjs doc with the arrival room's door layout, then compose the
 *      SAME functions completeAdapterArrival composes (selectArrivalDoorLayout
 *      → computeArrivalStationBias) and assert the R2 delta lands. Guards
 *      against a future re-wiring that keeps the primitives correct but
 *      breaks their composition — the exact regression class the round-1
 *      audit flagged as uncovered by H1/H2/H3.
 *
 * (H3) Round-trip rotY cancellation via `mirrorSegments`. Building a chain of
 *      flex bends and reading its exit heading with `foldChainEnd`, then doing
 *      the same on `mirrorSegments(chain)`, must yield equal and opposite yaw:
 *      the return-leg rotation exactly undoes the outbound leg, so a two-hop
 *      round-trip preserves heading with zero drift. That is the whole reason
 *      `mirrorSegments` negates every flex bend (stationParts.ts:185–191).
 *
 * (H4 — audit round 1) T5 seatFaceOverride flag arming. The flag is one-shot,
 *      consumed by zoomIn on the 2→1 dive; arming it at currentLevel === 1
 *      (a seat entered from inside first person) leaves it stranded and
 *      silently defeats the next dive's rig-inherit seed. `shouldPinSeatFaceOverride`
 *      is the pure predicate the runtime uses inline.
 *
 * (H5 — audit round 1) T2 vestibule-fade target continuity at dist = FADE_HOLD.
 *      Pre-fix the ramp used the full FADE_OUT_AT − FADE_IN_AT range and
 *      produced a target jump of ~0.6 at the hold boundary. Fixed by having
 *      each side's ramp span only its half of the band. Asserted directly on
 *      the pure `computeVestibuleFadeTarget`.
 */

import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeArrivalStationBias,
  physicalDoorPose,
  physicalDoorPoseOrNull,
  poseFromWall,
  type DoorRecordsMap,
} from './doorLayout';
import type { DoorWall } from './doorLayoutDoc';
import {
  bindDoorLayoutDoc,
  markDoorSetAuthoritative,
  selectArrivalDoorLayout,
  writeDoorLayout,
} from './doorLayoutDoc';
import {
  foldChainEnd,
  projectionPoseFromWall,
  type ConnectorSegment,
} from './adapter';
import { mirrorSegments } from './stationParts';
import { shouldPinSeatFaceOverride } from './zoomSeatPolicy';
import { computeVestibuleFadeTarget } from './vestibuleFade';

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

// ── (H2b) COMPOSITE arrival hook path (audit round 1) ───────────────────────

describe('#102 H2b: completeAdapterArrival composition, end-to-end from a doc', () => {
  // The round-1 audit's second finding: H1/H2/H3 exercise the pose primitives
  // but never the composite the arrival hook actually runs
  //   arrival-layout capture (selectArrivalDoorLayout)
  //   → resolveArrivalDoor's caller supplies an id
  //   → computeArrivalStationBias(depWall, id, arrivalLayout)
  //   → addStationBias(delta).
  // A future re-wiring that keeps every primitive green but reads the wrong
  // map here would slip past H1/H2/H3. This suite binds a real Y.Doc, seeds
  // the arrival room's door layout, and composes the SAME extracted helpers
  // completeAdapterArrival composes — so the composite path is regression-
  // guarded even without mounting the whole World class.

  beforeEach(() => {
    // Fresh doc per test — the bound doc lives module-globally in
    // doorLayoutDoc.ts, so tests must isolate each other. bindDoorLayoutDoc
    // replaces the previous binding (mirror of bindFurnitureDoc).
    bindDoorLayoutDoc(new Y.Doc());
  });

  it('selectArrivalDoorLayout returns the STORED records when the arrival room has authored some', () => {
    // Owner-authored arrival room: 'north' migrated to the y+ wall — the exact
    // silent-180 case H2 illustrates. The arrival hook MUST read those.
    writeDoorLayout({ id: 'north', wall: 'y+', lateral: 0, placed: true });
    markDoorSetAuthoritative();
    const layout = selectArrivalDoorLayout();
    expect(layout.size).toBe(1);
    expect(layout.get('north')?.wall).toBe('y+');
  });

  it('selectArrivalDoorLayout returns the STORED (empty) set for an authoritative-empty arrival room', () => {
    // A room that has declared "I have no doors" — marker present, no records.
    // The arrival hook must respect that declaration rather than pretending the
    // room still has the four cardinal defaults (the walk-in bail in
    // completeAdapterArrival covers the empty case; falling back to defaults
    // here would re-materialize doors the owner deleted).
    markDoorSetAuthoritative();
    const layout = selectArrivalDoorLayout();
    expect(layout.size).toBe(0);
  });

  it('selectArrivalDoorLayout falls back to the four cardinal defaults for an UN-migrated arrival room', () => {
    // Empty map, no marker: the pre-#28-S4 fallback. Every cardinal must be
    // synthesized so a room authored before the doorLayout store still has
    // arrivable doors.
    const layout = selectArrivalDoorLayout();
    expect(layout.size).toBe(4);
    for (const id of ['north', 'south', 'east', 'west']) {
      expect(layout.has(id)).toBe(true);
    }
  });

  it('composite delta: opposite walls (SAME layout in both rooms) → zero R2 bias', () => {
    // The pure-primitive H1 case, but going through the SAME two helpers
    // completeAdapterArrival composes. Depart NORTH (y-) → arrive at the far
    // room's SOUTH (y+): opposite walls, no camera rotation needed.
    writeDoorLayout({ id: 'south', wall: 'y+', lateral: 0, placed: true });
    markDoorSetAuthoritative();
    const arrivalLayout = selectArrivalDoorLayout();
    const delta = computeArrivalStationBias('y-', 'south', arrivalLayout);
    expect(Math.abs(wrap(delta))).toBeLessThan(EPS);
  });

  it('composite delta: silent-180 setup (arrival N migrated to y+) — arrival answer differs from departure answer by π', () => {
    // The pre-#102 buggy path in one composed line. Both rooms name a door
    // 'north' but the arrival room's records place it on the y+ wall (a
    // migrated cardinal) while the LEGACY_ID_WALL default puts it on y-.
    // Correct composite: reads arrival map ⇒ y+, hArr = 0 + π = π,
    // hDep = π ⇒ delta = 0 (opposite walls, no camera rotation needed).
    // Silent-180 buggy composite: reads DEPARTURE map ⇒ y-, hArr = 2π,
    // delta = π (the camera would suddenly rotate 180° across the transit).
    writeDoorLayout({ id: 'north', wall: 'y+', lateral: 0, placed: true });
    markDoorSetAuthoritative();
    const arrivalLayout = selectArrivalDoorLayout();
    const delta = computeArrivalStationBias('y-', 'north', arrivalLayout);
    // The CORRECT answer for opposite walls: no bias — walk through, keep
    // heading. Enforces that the composite reads the arrival records.
    expect(Math.abs(wrap(delta))).toBeLessThan(EPS);
    // Prove that reading through the departure map gives the SILENT-180
    // answer this composite is meant to prevent — H2's exclamation mark
    // in composite form, kept here as the regression anchor for a future
    // re-wire that reads the wrong map.
    const depLayoutOnly = records([{ id: 'north', wall: 'y-' }]);
    const silentDelta = computeArrivalStationBias('y-', 'north', depLayoutOnly);
    expect(Math.abs(Math.abs(wrap(silentDelta)) - Math.PI)).toBeLessThan(EPS);
  });

  it('composite delta: perpendicular walls (casino-pairs echo) → −π/2 bias', () => {
    // Arrival 'east' on the west wall (x-): departing NORTH (y-) into an
    // EAST-door arrival matches the retired casino-pairs continuity from H1,
    // now via the composed helpers.
    writeDoorLayout({ id: 'east', wall: 'x-', lateral: 0, placed: true });
    markDoorSetAuthoritative();
    const arrivalLayout = selectArrivalDoorLayout();
    const delta = computeArrivalStationBias('y-', 'east', arrivalLayout);
    expect(Math.abs(wrap(delta - -Math.PI / 2))).toBeLessThan(EPS);
  });
});

// ── (H4) T5 seatFaceOverride flag arming (audit round 1) ────────────────────

describe('#102 H4: shouldPinSeatFaceOverride guards a one-shot flag', () => {
  // The audit finding this suite exists for: `requestFirstPerson` set the
  // seatFaceOverride flag whenever a faceAngle was supplied, but zoomIn (the
  // sole consumer that CLEARS it) only runs on the 2→1 dive. A sit-down that
  // fires while already at level 1 (world.ts:472-473 onSeatSettled →
  // onFirstPersonSeat?.(seat.faceAngle)) armed the flag with no zoomIn to
  // clear it, silently defeating the very next 2→1 rig-inherit yaw seed and
  // re-opening the R2 continuity gap this flag was written to close. The
  // predicate below encodes the fix: arm only when a zoomIn will consume it.

  it('at level 2 with a defined faceAngle: ARM (the normal dive)', () => {
    // 2→1 will run; the flag must pin the seat's world-face through the
    // rig-inherit seed.
    expect(shouldPinSeatFaceOverride(2, 0)).toBe(true);
    expect(shouldPinSeatFaceOverride(2, Math.PI)).toBe(true);
    expect(shouldPinSeatFaceOverride(2, -Math.PI / 2)).toBe(true);
  });

  it('at level 1 with a defined faceAngle: DO NOT ARM (already there — nothing to consume it)', () => {
    // The exact bug case: seat entered from inside first person, faceAngle
    // written directly. Arming the flag here strands it until the NEXT
    // dive, which then skips its rig-inherit seed.
    expect(shouldPinSeatFaceOverride(1, 0)).toBe(false);
    expect(shouldPinSeatFaceOverride(1, Math.PI)).toBe(false);
  });

  it('at any level with UNDEFINED faceAngle: DO NOT ARM (nothing to pin)', () => {
    // No face override supplied ⇒ no need to defeat the rig-inherit seed. The
    // flag stays clean either way.
    expect(shouldPinSeatFaceOverride(1, undefined)).toBe(false);
    expect(shouldPinSeatFaceOverride(2, undefined)).toBe(false);
    // Levels > 2 are unreachable in production (M-dep of #33 clamps zoom-out
    // at 2 without ?devzoom), but the predicate must still degrade cleanly.
    expect(shouldPinSeatFaceOverride(3, undefined)).toBe(false);
  });

  it('at levels other than 2 with a defined angle: DO NOT ARM (zoomIn only fires at 2→1)', () => {
    // Anything that is not "we are at 2 and about to dive to 1" leaves the
    // flag alone. The 3+ case can only be reached via ?devzoom but must still
    // be handled — a request from level 3 will not trigger zoomIn to 1 either.
    expect(shouldPinSeatFaceOverride(0, Math.PI)).toBe(false);
    expect(shouldPinSeatFaceOverride(3, Math.PI)).toBe(false);
    expect(shouldPinSeatFaceOverride(8, Math.PI)).toBe(false);
  });
});

// ── (H5) T2 vestibule-fade target continuity (audit round 1) ────────────────

describe('#102 H5: computeVestibuleFadeTarget is continuous at every threshold', () => {
  // The audit's third finding: at dist = FADE_HOLD the flat hold branch
  // returned 1.0 and the fall-through ramp returned ~0.4, a target-value
  // jump of ~0.6 that the per-frame lerp then chased across many frames.
  // Fixed by having each side's ramp span only its HALF of the hysteresis
  // band (FADE_HOLD → FADE_OUT_AT for fade-out; FADE_IN_AT → FADE_HOLD for
  // fade-in), so the target value is continuous with the flat regions.
  //
  // Uses the production thresholds so the assertions read against the same
  // numbers a running client sees, but the helper is pure and framework-free.
  const thresholds = { fadeInAt: 1.5, fadeHold: 3.0, fadeOutAt: 4.0 };
  const BASE = 0.0; // production VESTIBULE_BASE_OPACITY
  // Boundary probe distance — a metre-tenth past the boundary is enough to
  // exit any if-branch that ties on `dist === threshold` and expose the jump.
  const NUDGE = 1e-6;

  it('continuous at FADE_HOLD when materialising (was ~0.6 jump pre-fix)', () => {
    // Pre-fix: hold branch returned 1.0 at dist ≤ FADE_HOLD; a hair PAST
    // FADE_HOLD dropped to ramp = 1 − (3.0001 − 1.5)/2.5 ≈ 0.4, a 0.6 jump.
    // Post-fix: the ramp's range is FADE_OUT_AT − FADE_HOLD (= 1.0), so at
    // dist = FADE_HOLD + ε it reads t ≈ 1, target ≈ 1.0.
    const inside = computeVestibuleFadeTarget(thresholds.fadeHold, true, thresholds, BASE);
    const outside = computeVestibuleFadeTarget(thresholds.fadeHold + NUDGE, true, thresholds, BASE);
    expect(inside).toBe(1.0);
    expect(Math.abs(outside - inside)).toBeLessThan(1e-4);
  });

  it('continuous at FADE_HOLD when faded (mirror side must also join cleanly)', () => {
    // Pre-fix, the fade-IN ramp shared the full range too, giving the same
    // discontinuity on the way back in. Post-fix, the ramp's range is
    // FADE_HOLD − FADE_IN_AT (= 1.5); at dist = FADE_HOLD − ε it reads
    // t ≈ 0, target ≈ BASE — continuous with the flat faded region.
    const inside = computeVestibuleFadeTarget(thresholds.fadeHold, false, thresholds, BASE);
    const outside = computeVestibuleFadeTarget(thresholds.fadeHold - NUDGE, false, thresholds, BASE);
    expect(inside).toBe(BASE);
    expect(Math.abs(outside - inside)).toBeLessThan(1e-4);
  });

  it('continuous at FADE_IN_AT (fade-in enters the material region cleanly)', () => {
    // At the near edge the target must join 1.0 without a jump. Materialising
    // or not, dist ≤ FADE_IN_AT unconditionally returns 1.0; a hair past that
    // must be ≈ 1.0 as well (the near half of the fade-in ramp starts here).
    const at = computeVestibuleFadeTarget(thresholds.fadeInAt, false, thresholds, BASE);
    const past = computeVestibuleFadeTarget(thresholds.fadeInAt + NUDGE, false, thresholds, BASE);
    expect(at).toBe(1.0);
    expect(Math.abs(past - at)).toBeLessThan(1e-4);
  });

  it('continuous at FADE_OUT_AT (fade-out leaves for the faded region cleanly)', () => {
    // Symmetric boundary at the far edge — dist ≥ FADE_OUT_AT unconditionally
    // returns BASE; a hair before must be ≈ BASE too, as the far half of the
    // fade-out ramp ends there.
    const at = computeVestibuleFadeTarget(thresholds.fadeOutAt, true, thresholds, BASE);
    const before = computeVestibuleFadeTarget(thresholds.fadeOutAt - NUDGE, true, thresholds, BASE);
    expect(at).toBe(BASE);
    expect(Math.abs(before - at)).toBeLessThan(1e-4);
  });

  it('flat solid inside FADE_IN_AT (fully material — the near unconditional region)', () => {
    // Anywhere at or nearer than FADE_IN_AT: target = 1.0 regardless of the
    // hysteresis bit. Any drift here would produce a shimmer at the door.
    expect(computeVestibuleFadeTarget(0, true, thresholds, BASE)).toBe(1.0);
    expect(computeVestibuleFadeTarget(0, false, thresholds, BASE)).toBe(1.0);
    expect(computeVestibuleFadeTarget(thresholds.fadeInAt, true, thresholds, BASE)).toBe(1.0);
    expect(computeVestibuleFadeTarget(thresholds.fadeInAt, false, thresholds, BASE)).toBe(1.0);
  });

  it('flat faded outside FADE_OUT_AT (fully invisible — the far unconditional region)', () => {
    // Symmetric far region: BASE regardless of the hysteresis bit.
    expect(computeVestibuleFadeTarget(10, true, thresholds, BASE)).toBe(BASE);
    expect(computeVestibuleFadeTarget(10, false, thresholds, BASE)).toBe(BASE);
    expect(computeVestibuleFadeTarget(thresholds.fadeOutAt, true, thresholds, BASE)).toBe(BASE);
    expect(computeVestibuleFadeTarget(thresholds.fadeOutAt, false, thresholds, BASE)).toBe(BASE);
  });

  it('hold-band bit distinguishes the two states inside the band (hysteresis preserved)', () => {
    // The whole point of the band is that the two hysteresis states produce
    // DIFFERENT targets across it — solid stays solid past the point a faded
    // vestibule would still be dark, and vice versa. Each state is flat on
    // ITS half of the band (a mirror-image split): solid is flat 1.0 in
    // [FADE_IN_AT, FADE_HOLD], faded is flat BASE in [FADE_HOLD, FADE_OUT_AT].
    // Probing both halves proves the split rather than any one value.

    // Near half of the band — solid is on the flat SOLID region, faded is
    // ramping in (the fade-in gradient starts here).
    const nearMid = (thresholds.fadeInAt + thresholds.fadeHold) / 2; // 2.25
    const solidNear = computeVestibuleFadeTarget(nearMid, true, thresholds, BASE);
    const fadedNear = computeVestibuleFadeTarget(nearMid, false, thresholds, BASE);
    expect(solidNear).toBe(1.0); // flat solid across the near half
    expect(solidNear).toBeGreaterThan(fadedNear); // ramping-in has not caught up

    // Far half of the band — faded is on the flat FADED region, solid is
    // ramping out (the fade-out gradient starts here).
    const farMid = (thresholds.fadeHold + thresholds.fadeOutAt) / 2; // 3.5
    const solidFar = computeVestibuleFadeTarget(farMid, true, thresholds, BASE);
    const fadedFar = computeVestibuleFadeTarget(farMid, false, thresholds, BASE);
    expect(fadedFar).toBe(BASE); // flat faded across the far half
    expect(solidFar).toBeGreaterThan(fadedFar); // ramping-out has not fallen to BASE
  });

  it('respects a NONZERO baseOpacity (the general contract, not just BASE=0)', () => {
    // The runtime passes VESTIBULE_BASE_OPACITY, currently 0. If it ever
    // moves off zero (a partially-visible resting vestibule), the ramps
    // must still land on it at their far ends and on 1.0 at their near ends.
    const nonZeroBase = 0.2;
    const at = computeVestibuleFadeTarget(thresholds.fadeOutAt, true, thresholds, nonZeroBase);
    const before = computeVestibuleFadeTarget(thresholds.fadeOutAt - NUDGE, true, thresholds, nonZeroBase);
    expect(at).toBe(nonZeroBase);
    expect(Math.abs(before - at)).toBeLessThan(1e-4);
    // And the fade-in ramp still ends at 1.0 at the near boundary.
    const nearAt = computeVestibuleFadeTarget(thresholds.fadeInAt, false, thresholds, nonZeroBase);
    const nearPast = computeVestibuleFadeTarget(thresholds.fadeInAt + NUDGE, false, thresholds, nonZeroBase);
    expect(nearAt).toBe(1.0);
    expect(Math.abs(nearPast - nearAt)).toBeLessThan(1e-4);
  });
});
