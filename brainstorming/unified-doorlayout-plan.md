# Unified `doorLayout.ts` — reconciling R1 (room-size) with the PRs' door-layout swap

*Owner ruling 2026-07-20: "hold R1, unify doors first" — R1 (#66 slice-1) and the two open room PRs
(#71 casino, #72 pool) each rework the door subsystem; land one derived door authority so R1 and the
PRs rebase onto it already-reconciled. Grounded in: R1's uncommitted door changes + both PRs'
`doorLayout.ts` + their consumer call-sites (read in-branch 2026-07-20).*

## The collision (established)

Three implementations of the SAME door-pose model live in `doors.ts` / `docking.ts` / `adapter.ts`:
- **R1**: door positions DERIVE from `roomHalfExtents()` (variable room size), but only the 4 legacy
  cardinal slots (`basePoints()`, `doorPositions()`, `FACE`, `ourFace`).
- **#71 / #72**: add `doorLayout.ts` — a richer pose table (`PhysicalDoorPose` carries wall/x/z/
  outwardYaw/frameYaw/front/through/faceAngle/tangent) with a **layout swap** (`legacy` +
  `casino-pairs`/`pool-pairs`, doors re-slotted onto shared walls) — but **every coord hardcoded ±6**.

They agree byte-for-byte at the default room (R1's `half−1.5`=4.5, `half+1`=7, `±half`=±6 == the PRs'
`LEGACY` table). The two PRs' `doorLayout.ts` are near-identical: `LEGACY` byte-identical, and
`CASINO_PAIRS` === `POOL_PAIRS` (same coords) — only the kind *name* differs.

## Resolution — one DERIVED authority

`doorLayout.ts` becomes the single door-pose source of truth, adopting the PRs' API **but building its
tables from `roomHalfExtents()`** (folding in R1's derivation). R1's `basePoints()` / `doorPositions()`
/ `FACE` / `ourFace` are deleted; `doors.ts` / `docking.ts` / `adapter.ts` route through
`physicalDoorPose(id, delta)` exactly as the PRs do.

### API (matches both PRs so they rebase cleanly)
```ts
export type PhysicalDoorId = DoorId;
export type DoorLayoutKind = 'legacy' | 'casino-pairs' | 'pool-pairs'; // both PR names valid
export interface PhysicalDoorPose { wall: DoorId; x; z; outwardYaw; frameYaw;
  front:{x;z}; through:{x;z}; faceAngle; tangent:'x'|'z'; }
export function physicalDoorPose(id: DoorId, lateralDelta = 0): PhysicalDoorPose;
export function setActiveDoorLayout(k: DoorLayoutKind): void;
export function activeDoorLayout(): DoorLayoutKind;
```
- Tables are FUNCTIONS of `roomHalfExtents()`: legacy insets `FRONT_INSET=1.5`, `THROUGH_OUTSET=1.0`,
  `EW_LATERAL=−0.5`; pairs use a fixed `PAIR_OFFSET=2.7` (R2/R3 may scale it) on the derived walls.
- `casino-pairs` and `pool-pairs` map to the SAME derived PAIRS table (alias) — so #71's
  `setActiveDoorLayout('casino-pairs')` and #72's `'pool-pairs')` both work unchanged.
- `physicalDoorPose(id, delta)` picks the active table, applies `delta` along `tangent`, returns the
  full pose (x/z/front/through shifted).

### Consumer rewiring (adopt the PRs' exact call pattern → those sites stop conflicting)
- `doors.ts applyDoorSlideDeltas`: `pose = physicalDoorPose(id, delta)` → set `front/through` AND
  `faceAngle` (delete `basePoints()`/`BASE_POINTS`/insets).
- `docking.ts buildPorts`: `doorsConfig = [{id, isLarge}]`; `pose = physicalDoorPose(id)` →
  `group.position.set(pose.x, 2, pose.z)`, `rotation.y = pose.frameYaw` (delete the hardcoded pos/rotY).
- `docking.ts repositionDoorGroups`: `pose = physicalDoorPose(id, delta)` → set FULL position
  (`pose.x, 2, pose.z`) + `frameYaw` (was: only the lateral axis — the pose form also handles PAIRS).
- `adapter.ts` vestibule + `buildConnectorChain`: `pose = physicalDoorPose(id, delta)` →
  `position.set(pose.x,0,pose.z)`, `rotation.y = pose.outwardYaw`. Delete `DOOR_POS`/`doorPositions()`/
  `slidDoorPos()`.
- `adapter.ts projectionPoseForDoor`: source `dPos`/`dYaw` from the pose; adopt the PRs' legacy branch
  `dPos + outward*(LEGACY_PROJECTION_OFFSET−6)` — **verified byte-identical** to R1 at the default
  (door centre ±6 + 9.2 = 15.2 == R1's `sign*15.2`). Keep `ROOM_HALF=5.9`/`LEGACY_PROJECTION_OFFSET`
  as neighbour placeholders (#66 R4).
- `docking.ts` `chainBoxesFor` FACE + jetbridge `ourFace`: source our door centre from
  `physicalDoorPose(id).{x,z}`; keep the neighbour `doorFaceLocal` at ±6 (R4).

### Byte-identical gate (LEGACY layout, default 2×2 room)
`activeDoorLayout()` defaults to `'legacy'`; every derived value reduces to the current R1 output at
`half=6`. Verify: door walk-targets + group positions + vestibule/chain anchors unchanged (live probe);
tsc clean; then **test-merge #71 and #72** onto R1+unified — the door-subsystem conflicts
(`doors.ts`/`docking.ts`/`adapter.ts`) should shrink to near-zero.

### Caveats (flag, don't solve here)
- **PAIRS ⟂ the doc slide model.** In pairs, logical `south` sits on the *north* wall, so
  `floorPlanDoc.doorWallCoord(south)` (=+halfZ) disagrees with the physical pose (−halfZ). Harmless
  while pairs rooms don't slide doors (deltas 0). The slide UI on a pairs room is a PR/R3 concern.
- **PAIR_OFFSET=2.7** is fixed (fine for the default-sized casino/pool; a ≤1-tile axis would want it
  clamped) — R2/R3 debt.
- Whole-file Prettier reformat in the PRs still churns `world.ts`/`player.ts` textually — unrelated to
  the door model; re-apply R1's derivations on top at rebase.

## Blank-rooms-by-default (owner ruling: "empty + wall-computer + one door to connect to")
Lands AFTER doors + the PRs. Seed a newly-*minted* module (main.ts `mintedRoomIds` path) with a
**minimal fixture doc** — just the wall-computer (the only in-game edit-mode entry) — instead of the
full lobby, so `reconcileFurniture` wipes the local defaults (empty doc ⇒ full lobby, so a signal is
required). Doors are structural (all four exist), satisfying "one door to connect to"; no reconcile-
guard change, no zero-item sentinel. Separate slice; see the conflict-analysis synthesis.
