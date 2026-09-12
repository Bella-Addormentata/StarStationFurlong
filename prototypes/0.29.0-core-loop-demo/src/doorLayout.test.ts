// doorLayout.ts tests — the pure predicates and geometry helpers that #101's
// docking-pane hardening relies on. Everything covered here runs without a
// Yjs doc bound (roomHalfExtents falls back to the DEFAULT_DIMS 2×2 room, so
// halfX = halfZ = 6, matching the legacy ±6 tables the docking system was
// born with).
//
// The DOM handlers in docking.ts (INITIATE / ACCEPT / provision / assembly)
// are not covered here — they read from and write to a live pane element that
// the test bed does not synthesize. Their honesty is enforced by the type
// system: the `activeDoor` closure returns `string | null`, `completePairing`
// / `receiveInboundPairingRequest` / `animateBlinkingIndicator` /
// `discardUntouchedPrefill` / `editChainSegment` accept `string`, so
// `isCardinalDoorId` narrowing at any downstream call site is checked at
// compile time. See PR #101 body for why guarding those handlers with an
// early return would REGRESS the "any door can pair" design (commit 94df5c6)
// and why the fix is a type-honesty widening instead.

import { describe, expect, it } from "vitest";
import {
  isCardinalDoorId,
  physicalDoorPose,
  physicalDoorPoseOrNull,
  poseFromWall,
  setDoorRecords,
  snapDoorLateral,
  wallAndLateralFromPoint,
  MIN_DOOR_GAP,
  DOOR_OPENING_WIDTH,
  DOOR_FRAME_WIDTH,
  DOOR_POST_WIDTH,
} from "./doorLayout";
import type { DoorWall } from "./doorLayoutDoc";

describe("isCardinalDoorId — the cardinal/free split predicate #101 hardening", () => {
  // #101 fix 2: this predicate is the compiler-checked narrower every
  // cardinal-only helper reaches for; a false negative silently lets a free
  // `d:` id through, a false positive lets `poseFromWall` receive a non-wall
  // string. The four ids MUST return true; anything else — including plausible
  // near-misses — MUST return false, no substring or normalization tricks.

  it("returns true for every cardinal id, and only those", () => {
    expect(isCardinalDoorId("north")).toBe(true);
    expect(isCardinalDoorId("south")).toBe(true);
    expect(isCardinalDoorId("east")).toBe(true);
    expect(isCardinalDoorId("west")).toBe(true);
  });

  it("rejects free `d:` ids — the design shift that made #101 relevant", () => {
    expect(isCardinalDoorId("d:abc12345")).toBe(false);
    expect(isCardinalDoorId("d:00000000")).toBe(false);
    // an empty suffix is still a free-door namespace, not a cardinal
    expect(isCardinalDoorId("d:")).toBe(false);
  });

  it("rejects case-fold impostors — narrowing is strict identity", () => {
    // The compiler proves the four literal strings; a runtime NORTH must NOT
    // narrow to PhysicalDoorId or every case-insensitive input path becomes
    // a poseFromWall entry point.
    expect(isCardinalDoorId("NORTH")).toBe(false);
    expect(isCardinalDoorId("North")).toBe(false);
    expect(isCardinalDoorId("SOUTH ")).toBe(false); // trailing space
    expect(isCardinalDoorId(" east")).toBe(false); // leading space
  });

  it("rejects near-misses that share a substring with a cardinal", () => {
    // Free-door ids that happen to *contain* a compass word must not slip
    // through. Substring reduction was the shape of the retired bug the
    // hoisted predicate replaced.
    expect(isCardinalDoorId("north-door")).toBe(false);
    expect(isCardinalDoorId("d:north")).toBe(false);
    expect(isCardinalDoorId("east2")).toBe(false);
    expect(isCardinalDoorId("westward")).toBe(false);
  });

  it("rejects axis wall labels — walls are NOT door ids", () => {
    // 94df5c6 / d946974 moved walls to axis labels (x+ / x- / y+ / y-). Those
    // are WALL names; the cardinal DOOR ids remained the four compass words
    // for backward compat. A wall label reaching this predicate would be a
    // caller confusion — it must not narrow.
    expect(isCardinalDoorId("x+")).toBe(false);
    expect(isCardinalDoorId("x-")).toBe(false);
    expect(isCardinalDoorId("y+")).toBe(false);
    expect(isCardinalDoorId("y-")).toBe(false);
  });

  it("rejects empty and whitespace strings", () => {
    expect(isCardinalDoorId("")).toBe(false);
    expect(isCardinalDoorId(" ")).toBe(false);
    expect(isCardinalDoorId("\t")).toBe(false);
    expect(isCardinalDoorId("\n")).toBe(false);
  });
});

describe("physicalDoorPose — degrades on unknown ids instead of throwing (#91 / #101)", () => {
  // #101 originally warned that `physicalDoorPose` would throw on a free `d:`
  // id because `poseFromWall(id, …)` fell through with no matching wall and
  // the first property read on `undefined` blew up. That crash is now caught
  // by `fallbackPose` (doorLayout.ts:276), which returns a north-wall centred
  // pose and console.warns once per unknown id. These tests pin that safety
  // in — without it, the "unreachable but existing" INITIATE/ACCEPT crash
  // path #101 called out becomes reachable again.

  it("resolves the four cardinal ids to their self-named walls", () => {
    // With no record set, cardinals fall back through LEGACY_ID_WALL — each
    // one poses on the wall named the same thing. Room is 2×2 (default), so
    // halfX = halfZ = 6. y− is the "north" wall, y+ south, x− west, x+ east.
    setDoorRecords(new Map());
    expect(physicalDoorPose("north").wall).toBe("y-");
    expect(physicalDoorPose("south").wall).toBe("y+");
    expect(physicalDoorPose("east").wall).toBe("x+");
    expect(physicalDoorPose("west").wall).toBe("x-");
  });

  it("returns a valid pose for a free `d:` id with no record (the #91 crash)", () => {
    setDoorRecords(new Map());
    // Before the fallback landed, this line threw. Regression coverage: the
    // return must be a fully-formed pose (every field populated), not
    // undefined and not partial — downstream property reads must succeed.
    const pose = physicalDoorPose("d:unknown-free-door");
    expect(pose).toBeDefined();
    expect(pose.wall).toBeDefined();
    expect(pose.x).toBeTypeOf("number");
    expect(pose.z).toBeTypeOf("number");
    expect(pose.outwardYaw).toBeTypeOf("number");
    expect(pose.frameYaw).toBeTypeOf("number");
    expect(pose.front).toBeDefined();
    expect(pose.through).toBeDefined();
    expect(pose.tangent === "x" || pose.tangent === "z").toBe(true);
  });

  it("physicalDoorPoseOrNull is honest about a miss (the exterior render's read)", () => {
    // physicalDoorPoseOrNull is the "honest" variant the exterior projection
    // and module-overlap tests must use — a confident-wrong pose there would
    // refuse a valid dock. Cardinals still degrade via LEGACY_ID_WALL because
    // they are self-describing, but a bare `d:` id with no record returns
    // null. Compare with the crash-safe physicalDoorPose above.
    setDoorRecords(new Map());
    expect(physicalDoorPoseOrNull("north")).not.toBeNull();
    expect(physicalDoorPoseOrNull("d:no-such-door")).toBeNull();
  });

  it("prefers the record when one is set — free doors are first-class", () => {
    // The "any door can pair" design (94df5c6): a free `d:` id with a real
    // record poses off it, exactly the same way a cardinal does. This is
    // what makes the type-widening in docking.ts honest — a free-door
    // pairing has a real pose to compute against.
    const records = new Map<string, { wall: DoorWall; lateral: number }>([
      ["d:free-door", { wall: "x+", lateral: 2 }],
    ]);
    setDoorRecords(records);
    const pose = physicalDoorPose("d:free-door");
    expect(pose.wall).toBe("x+");
    // With halfX = 6 and lateral = 2, x+ wall places the door at x = 6, z = 2.
    expect(pose.x).toBe(6);
    expect(pose.z).toBe(2);
    // Reset — module-scoped state persists across tests otherwise.
    setDoorRecords(new Map());
  });
});

describe("poseFromWall — the geometry generator every door poses through", () => {
  // poseFromWall is what physicalDoorPose ultimately calls. #101 flagged it
  // as the crash site (its switch has no default arm); the fix hoisted the
  // guard, so this suite pins the four legal walls' pose invariants down.

  it("y- (north) places door on the −z wall facing outward (yaw π)", () => {
    const p = poseFromWall("y-", 0);
    expect(p.wall).toBe("y-");
    expect(p.z).toBe(-6);
    expect(p.x).toBe(0);
    expect(p.outwardYaw).toBe(Math.PI);
    expect(p.tangent).toBe("x");
  });

  it("y+ (south) places door on the +z wall facing outward (yaw 0)", () => {
    const p = poseFromWall("y+", 0);
    expect(p.wall).toBe("y+");
    expect(p.z).toBe(6);
    expect(p.outwardYaw).toBe(0);
    expect(p.tangent).toBe("x");
  });

  it("x- (west) places door on the −x wall facing outward (yaw −π/2)", () => {
    const p = poseFromWall("x-", 0);
    expect(p.wall).toBe("x-");
    expect(p.x).toBe(-6);
    expect(p.outwardYaw).toBe(-Math.PI / 2);
    expect(p.tangent).toBe("z");
  });

  it("x+ (east) places door on the +x wall facing outward (yaw π/2)", () => {
    const p = poseFromWall("x+", 0);
    expect(p.wall).toBe("x+");
    expect(p.x).toBe(6);
    expect(p.outwardYaw).toBe(Math.PI / 2);
    expect(p.tangent).toBe("z");
  });

  it("front point is 1.5 m inside the wall from the door centre", () => {
    // FRONT_INSET is where the avatar stands to interact; it must be inside
    // the room by exactly 1.5 m from the wall, on every wall.
    expect(poseFromWall("y-", 0).front.z).toBe(-6 + 1.5);
    expect(poseFromWall("y+", 0).front.z).toBe(6 - 1.5);
    expect(poseFromWall("x-", 0).front.x).toBe(-6 + 1.5);
    expect(poseFromWall("x+", 0).front.x).toBe(6 - 1.5);
  });

  it("through point is 1.0 m outside the wall from the door centre", () => {
    // THROUGH_OUTSET is where a walk-through lands; outside the wall by 1 m.
    expect(poseFromWall("y-", 0).through.z).toBe(-(6 + 1.0));
    expect(poseFromWall("y+", 0).through.z).toBe(6 + 1.0);
    expect(poseFromWall("x-", 0).through.x).toBe(-(6 + 1.0));
    expect(poseFromWall("x+", 0).through.x).toBe(6 + 1.0);
  });

  it("lateral offset moves the door along its tangent axis, not through the wall", () => {
    // A door at lateral 3 on a y- (north) wall sits 3 m to the +x side of
    // centre, but the wall coordinate (z) is unchanged.
    const p = poseFromWall("y-", 3);
    expect(p.x).toBe(3);
    expect(p.z).toBe(-6);
    // …and its front/through points share the lateral, so avatar stand-point
    // is directly in front of the opening.
    expect(p.front.x).toBe(3);
    expect(p.through.x).toBe(3);
  });
});

describe("snapDoorLateral — grid snap for door centres", () => {
  // #91: door centres lock to integer world coords so the 2 m opening spans
  // exactly 2 grid cells, flush on the lines.

  it("snaps to the nearest integer for both size classes", () => {
    expect(snapDoorLateral("large", 2.3)).toBe(2);
    expect(snapDoorLateral("large", 2.6)).toBe(3);
    // #91 collapsed sizes to one; both accept the parameter for record compat.
    expect(snapDoorLateral("small", 2.5)).toBe(3); // Math.round half-up
    expect(snapDoorLateral("large", -1.4)).toBe(-1);
    expect(snapDoorLateral("large", -1.5)).toBe(-1); // Math.round(-1.5) === -1
    expect(snapDoorLateral("large", 0)).toBe(0);
  });
});

describe("wallAndLateralFromPoint — inverse of poseFromWall (editor placement)", () => {
  // #28 S6b: given a clicked floor point, pick the nearest wall and the
  // along-wall lateral. Used by the door editor to place a free door where
  // the user drags. Must be stable at the corners (deterministic winner).

  it("routes a point near the −z wall to y- with x as the lateral", () => {
    const r = wallAndLateralFromPoint(2, -5.5);
    expect(r.wall).toBe("y-");
    expect(r.lateral).toBe(2);
  });

  it("routes a point near the +z wall to y+ with x as the lateral", () => {
    const r = wallAndLateralFromPoint(1, 5.5);
    expect(r.wall).toBe("y+");
    expect(r.lateral).toBe(1);
  });

  it("routes a point near the −x wall to x- with z as the lateral", () => {
    const r = wallAndLateralFromPoint(-5.5, 2);
    expect(r.wall).toBe("x-");
    expect(r.lateral).toBe(2);
  });

  it("routes a point near the +x wall to x+ with z as the lateral", () => {
    const r = wallAndLateralFromPoint(5.5, -3);
    expect(r.wall).toBe("x+");
    expect(r.lateral).toBe(-3);
  });

  it("origin point picks a valid wall deterministically", () => {
    // At the exact centre all four walls are equidistant. The picker must
    // return a real DoorWall — never undefined — so the editor's drop-point
    // handler always has a target. The specific wall is stable-sort dependent
    // and does not matter here; existence and a real lateral do.
    const r = wallAndLateralFromPoint(0, 0);
    expect(["y-", "y+", "x-", "x+"]).toContain(r.wall);
    expect(r.lateral).toBeTypeOf("number");
  });
});

describe("door geometry constants — #91 invariants", () => {
  // The physical door contract: opening + posts add up, min gap accommodates
  // the exterior docking band, and the frame width is the grid-consistent
  // constant every consumer derives from.

  it("frame width = opening + two posts", () => {
    expect(DOOR_FRAME_WIDTH).toBe(DOOR_OPENING_WIDTH + 2 * DOOR_POST_WIDTH);
  });

  it("opening is 2 m — exactly 2 TILE_SIZE grid cells wide on either side of centre", () => {
    // TILE_SIZE = 6 m per cell; door opening spans 2 m so the 1 m half is on
    // an integer, half on the next integer — one cell each side of centre.
    expect(DOOR_OPENING_WIDTH).toBe(2.0);
  });

  it("MIN_DOOR_GAP accommodates two doors' exterior docking bands + a metre of daylight", () => {
    // hull.EXT_DOOR_BAND is 1.8; two bands = 3.6; rounded up to a whole
    // metre (grid coincidence: snapDoorLateral produces whole-metre gaps
    // only). 4.0 is what the constant must be.
    expect(MIN_DOOR_GAP).toBe(4.0);
    expect(MIN_DOOR_GAP).toBeGreaterThan(3.6);
  });
});
