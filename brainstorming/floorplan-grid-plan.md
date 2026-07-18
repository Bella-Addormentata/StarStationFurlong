# Movable Doors & Unit-Grid Floor Plans — One Coherent Plan (#66)

*Star Station Furlong — doors you can pick up and slide along their wall, and floor plans that grow one hull tile at a time. Design synthesis, not code.*

Repo root for prototype paths: `prototypes/0.29.0-core-loop-demo/src/` (the RELEASE_FRONTEND live line, v0.30.6). Line numbers are carried from the three research passes that read the current files in-source this session; anything not source-verified is flagged. This document synthesizes three research lines — **(A)** the fixed-geometry assumption map (every place 11.8×11.8×4.0 and the 4-cardinal `DoorId` union are baked in), **(B)** the floor-plan data model / sync / compat design, and **(C)** generation, rendering + build UX — and resolves their disagreements explicitly (§1.4, plus inline notes at each decision).

> **Companions:** [angled-vestibules-octagon-plan.md](angled-vestibules-octagon-plan.md) (#62 — the invariant "rooms stay cardinal; the connector takes the turn" that this plan must preserve, and the `DoorRecord` wire this plan extends) · [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (module = room = Yjs doc) · [room-durability-plan.md](room-durability-plan.md) (owner-writes, read-side validation, one-doc-at-a-time sync) · shipped #64 (`doorsDoc.ts`).

---

## 1. Executive summary

**What #66 asks:** doors stop being fixtures — the owner can move them along the room's walls like furniture — and the room's floor plan stops being a fixed square: it grows tile-by-tile on a unit grid, eventually into non-rectangular shapes.

**The approach in one paragraph:** the room gets one new source of truth, a `floorPlan` Y.Map in the room doc — a set of unit-tile keys plus one placement record per door slot — and *everything else becomes derived*: wall runs from a boundary walk of the tile set, the `DOORS` table from placements, the walkable grid from tile membership, obstacles from wall pieces, camera framing from the plan bbox. An empty map means today's room, bit-identical. Door *identity* never changes: `DoorId` stays the 4-value union and a door's id **is** its cardinal facing — placement is data, identity is the slot — which preserves #62's invariant ("rooms stay cardinal; the connector takes the turn") through every stage, including non-rectangular plans, and dissolves the one migration line A feared. Ships in four slices: door-slide first (the smallest surface that forces the load-bearing `DOORS`-const→derived-registry refactor), then a zero-diff procedural-generation refactor gated on byte-identical output, then EXPAND (one hull tile per click, growth-only), then polish. Transit, pairing, walk choreography, and the #62 chain math change zero at every stage.

**The unit-size ruling: the tile is 6×6 m, and today's room is exactly 2×2 tiles.** Tile `(i,j)` spans world `x∈[6i, 6i+6]`, `z∈[6j, 6j+6]`; the default plan is `{(-1,-1),(0,-1),(-1,0),(0,0)}`, whose boundary is precisely today's wall centerlines at ±6 (`world.ts:437,477-495`). Line B proposed 2.0 m tiles; 6 m wins (resolution #1): **(i)** the large door is ~3.0 m of straight wall — 2.4 opening + posts (`docking.ts:144-155`) — so a one-tile bump-out under any tile ≤3 m could never carry it; **(ii)** B's wall convention (centerline = tile edge + 1.0 m outward) offsets the polyomino outline and tangles at concave corners, while the 6 m convention puts wall centerlines *on* the boundary edges — the boundary walk emits walls directly; **(iii)** a 6 m bay is a meaningful purchase (hosts a real furniture grouping; matches the "hull tile is a serious EVA part" fiction and part-cost gating), where 2 m clicks are noise; **(iv)** 6 = 12 path cells (`CELL_SIZE 0.5`, `pathfinding.ts:21`) = 6 furniture-grid units — no lattice changes anywhere; **(v)** the default room being 2×2 (not 1×1) means the polyomino code path is exercised from day one. Exact legacy mapping: walkable inset 1.0 m from boundary (reproduces ±5.0, `pathfinding.ts:55`), clamp inset 0.8 (reproduces BOUND 5.2, `player.ts:123`), hull overhang 0.175 (reproduces 12.35), wood-texture repeat 3.5/12 m → per-tile UV offset `(1.75·i, 1.75·j) mod 1` keeps the herringbone seamless.

### 1.1 Ground truth today (verified by the assumption-map pass)

1. **The room is one web of hardcoded numbers, but it has few chokepoints.** `platformSize = 12` drives floor, click plane, and edit grid (`world.ts:247,250,328,340`); walls sit at ±6; the walkable boundary is `|w| > 5.0` in exactly two places (`pathfinding.ts:55,240`); placement bounds are ±5 in exactly two places (`editMode.ts:149-150,156`); the manual-move clamp is one constant (`player.ts:123`). A* itself, overlap checks, and flood-fill connectivity are already shape-agnostic.
2. **The walk choreography is already pure data.** `player.ts:1196-1330` reads only `DoorTarget {front, through, faceAngle}`; move the record and the choreography follows for free. And `DOORS` is already mutated at runtime (`north.enabled`, `world.ts:635`) — the "const" is really state, which licenses the derived-registry refactor.
3. **Edit mode already owns the validity engine this feature needs.** `computeReachable` + `requiredReachable` over all door fronts (`editMode.ts:886`) is exactly the machinery door-moves and future tile-removal require — reuse, don't rebuild.
4. **Door placements cannot live in `DoorRecord`** — door records are pairing lifecycle and are *deleted on unpair* (`doorsDoc.ts:163-168`), which would erase a placement. (Both B and C converged here independently.)
5. **Old-client degradation is render-not-corrupt by existing accident of discipline:** `reconcileFurniture` shape-checks but never bounds-checks (`world.ts:654-682`), so furniture beyond a client's walls applies, renders, and is simply unreachable on their grid. The same posture extends to floor plans.
6. **The fireplace unblock is the pattern seed:** the north door enables/disables per-frame-of-change from furniture in an approach zone (`world.ts:619-636`) — generalized, this is the universal door-blocking rule (§6.2).

### 1.2 The invariants (say them every time)

- **Rooms stay cardinal; the connector takes the turn** — generalized: *every wall run of an axis-aligned tile set faces a cardinal, and a door's id IS its facing.* `DoorId` stays the 4-value union (~160 references untouched); camera detents and the facing-fade dot products (`docking.ts:74-79`) hold at every stage.
- **Empty `floorPlan` ⇒ today's room, bit-identical.** The unseeded-map semantics of `furnitureDoc` (`world.ts:639`), applied to structure. Existing docs never grow until their owner edits.
- **The base 2×2 is eternal.** The four default tiles are never removable and are required by the resolver — so the spawn/beam-in point (0, 1.5) (`player.ts:208`, `world.ts:1685`) is interior forever, and the legacy fallback is always well-defined.
- **Store the plan, derive the geometry.** Walls, the `DOORS` table, obstacles, the walkable grid, camera framing — all recomputed deterministically from the tile set + placements on every client. Nothing derived is ever written.
- **Wire changes are additive-only; validate on read, deterministically.** Legacy `DoorRecord` fields always written; new fields optional with sanitize-or-drop guards; junk in `floorPlan` degrades every client identically to the legacy room — never a crash, never divergence.
- **Owner-writes, one doc at a time.** Structure edits are owner-gated UI on the write side; enforcement is read-side validation, exactly the `furnitureDoc`/`doorsDoc` discipline.

### 1.3 The recommendation

Ship **door-slide first** (S1) — it delivers visible #66 value on the smallest surface while forcing the one refactor everything later needs — then the **zero-diff generation refactor** (S2), then **EXPAND one tile** (S3), then polish (S4). Tile *removal*, undo, cross-facing door moves, and >4 doors are consciously deferred to a v2 (§7). Full ordering and the first-slice argument in Part 7.

### 1.4 Where the three research lines disagreed — resolutions

| # | Disagreement | Resolution (and where it's argued) |
|---|---|---|
| 1 | **Tile size.** B: 2.0 m (base = 5×5). C: 6.0 m (base = 2×2). | **6.0 m** — large-door fit is a hard constraint; plus corner cleanliness, part economy, day-one polyomino coverage (§1 exec summary). B's schema/guard/resolver discipline survives intact under the new constants. |
| 2 | **Wall convention.** B: centerline = tile edge + 1.0 m outward. C: boundary edge *is* the centerline; walkable inset 1.0. | **C** (§5.1) — corollary of #1; B's outward offset self-intersects at concave corners of an L. Both reproduce ±6 for the base square. |
| 3 | **Door placement value.** B: hosting tile `{tx,tz}`, door at edge midpoint. C: 0.5 m-lattice offset along the facing run. | **Merged** (§3.2): B's key scheme (`door:${DoorId}`) and guard discipline, C's granularity — value is the opening centre `{x,z}` on the 0.5 m lattice, validated against a same-facing exterior run. Bonus: B's accepted 0.5 m shift of the seeded E/W doors (legacy centres at z≈−0.5, `doors.ts:33-34`) disappears — the lattice reproduces legacy positions exactly. |
| 4 | **Refactor order.** A: pure RoomPlan seam refactor (Stage 0) before any feature. C: door-slide first, generation refactor second. | **C's order** (§7) — smallest blast radius per PR, ships value first. A is not discarded: its ~12-consumer hardcode checklist becomes S2's acceptance checklist, under A's own byte-identical gate. |
| 5 | **Rectangle intermediate stage.** A staged rect N×M resize before polyominoes. B, C: go straight to polyominoes. | **Dropped** (§2) — the rect stage existed to postpone A's feared `DoorId` migration; resolution #6 dissolves that migration, so the rectangle stage buys nothing. |
| 6 | **Door identity at polyominoes.** A: "an L has two south walls ⇒ `DoorId` → string ids, the one true structural migration." B, C: keep the 4 slots; id = facing. | **Keep the 4 slots, permanently within #66 scope** (§3.3). The placement names *which* run and *where*; the id names the facing. Cost: ≤1 door per facing. >4 doors is a clean future extension via new slot ids — `readAllDoors` iterates only known ids (`doorsDoc.ts:134`), so old clients never see unknown slots. |
| 7 | **Shrink.** B: full shrink policy (commit gates + read-side eviction). C: v1 growth-only, no removal. | **Both, split by side** (§3.4): the write UI is growth-only (no removal gates to build), but the *resolver keeps B's full shrink tolerance* — hostile or racing deletes must degrade deterministically regardless of what our UI allows. Owner-facing removal ships in v2 with B's commit-gate battery. |
| 8 | **Undo.** B: `Y.UndoManager`, local-origin, session-scoped. C: silent on undo. | **Deferred to v2, bundled with removal** — undoing a tile add *is* a tile removal (plus a part refund), so it needs the shrink gates; shipping it earlier would smuggle removal in untested. S3 uses a two-click confirm on the ghost tile instead (§6.3). |
| 9 | **Grid & envelope.** A: per-room grid dims. B: bbox-derived dims, coord cap ±8 tiles. C: static `GRID_SIZE` 64, build envelope ±15 m "5 tiles across". | **Static grid, resized once** (§5.4): C's static-now/dynamic-later call wins (local-only, wire-free), but C's numbers don't survive the 6 m tile — a 5-across envelope can't be symmetric about a 2×2 base. Adopted: envelope = tile indices `i,j ∈ [−3..2]` (6×6 tiles, walls within ±18 m, `MAX_TILES = 36`), `GRID_SIZE` 22 → **80** (±20 m). Caps enforced on read (B's caps-as-guards), bounding camera and projection against hostile writes. |
| 10 | **Furniture at a door's target slot.** C: drop requires front/through cells clear. B: furniture proximity is never a placement error — doors block *dynamically*. | **B** (§6.2) — the shipped fireplace pattern generalized is the universal rule; geometric gates (run fit, corner/door overlap) stay hard, furniture proximity renders the slot amber and the door disabled-until-cleared. Safe because paired doors can't move at all (C's rule, kept). |
| 11 | **Required core.** B: single anchor tile, never removable. C: plan must contain the default 2×2. | **The base 2×2 is the anchor set** (§3.2) — resolver BFS from (0,0); if any base tile fails to resolve, the whole plan falls back to legacy. Guarantees the spawn point and makes the fallback total. |

---

## 2. The assumption map, distilled — what breaks at which slice

Line A's full inventory is ~30 assumptions across 12 files; distilled here by fate. The headline: **almost everything is mechanical once one seam exists**, and the two things A rated "genuinely structural" — monolithic walls and the `DoorId` identity — are handled by the boundary-walk builder (§5.1) and resolution #6 respectively. The rectangle-only stage A proposed is dropped (resolution #5).

| Subsystem | Today | Fate |
|---|---|---|
| `DOORS` table: front ±4.5, through ±7.0, faceAngle (`doors.ts:30-35`) | Const, 4 cardinal records | **S1** — becomes a derived registry (`rebuildDoors()`), same shape as SEATS/DEVICES. Precedent: it's already runtime-mutated (`world.ts:635`). Choreography (`player.ts:1196-1330`) reads only the record — follows free. |
| Port/keypad build (`docking.ts:124-129,263-279`), vestibule/chain anchor (`adapter.ts:133-138,502-507`), projection pose tables `DOOR_POS`/`DOOR_YAW` (`adapter.ts:415-420`) | Positions hardcoded at wall centres ±6 | **S1** — all become lookups of the derived registry. #62's fold math (`foldChainEnd`) is chain-local: the chain's wall-face *origin* moves with the door; nothing else changes. |
| Walkable boundary `|w| > 5.0` ×2 (`pathfinding.ts:55,240`); placement bounds ±5 ×2 (`editMode.ts:149-156`) | Square containment, 4 call sites | **S2** — all four collapse into one shared `isInsidePlan(wx, wz)` tile-membership test. This is THE chokepoint where plan shape enters path/placement, and both already re-bake on every furniture change (`world.ts:693-694`) — tile edits ride the existing pipeline free. |
| Wall/roof/hull meshes (`world.ts:367-495`), click plane (`world.ts:328`), floor, grid helper, edge/corner cosmetics | Monolithic boxes at ±6; single 12×12 planes | **S2** — boundary-walk generators (§5.1), zero-diff gated. The one genuinely structural mesh change, paid once, behind a parity gate. |
| Manual-move clamp `BOUND = 5.2` (`player.ts:123`) | Square clamp — cannot express an L | **S2** — walls become obstacle AABBs (§5.1), which contain any shape through the existing collision path; BOUND survives as a coarse bbox-derived outer clamp only. |
| Grid dims `GRID_SIZE = 22` (`pathfinding.ts:21-25`; imported by `editMode.ts:210`, `npc.ts`) | ±5.5 m fixed | **S3** — one static bump to 80 (±20 m, 6.4 KB, resolution #9); accessors replace the exported consts. |
| Camera: `lookAt(0,0,0)` ×3 (`renderer.ts:70`, `cameraRig.ts:184`, `zoom.ts:641-669`), `VIEW_SIZE = 14` (`renderer.ts:11`, dup `zoom.ts:633`) | Centroid = origin; frustum sized to one room | **S3** — `planExtents()` (bbox + centre, accessor lands in S2) feeds a settable look-target and per-level frustum scaled by `max(halfX, halfZ)/6`. Framing by bbox, not tile centroid, so an L doesn't off-centre its long arm. |
| Facing fade `DOOR_NORMALS` + 45° detents (`docking.ts:74-79,957-987`) | One cardinal normal per door | **Untouched at every stage** — axis-aligned runs guarantee cardinal normals (invariant §1.2). A rated this fragile; it survives to arbitrary polyominoes. |
| `resolveArrivalDoor` opposite-cardinal map (`world.ts:1637-1651`) | Assumes 2 opposite pairs | **Untouched** — #62 already demoted it to fallback behind `farDoor`; facings persist, so the fallback stays meaningful even on an L. |
| Far-room projection box 11.8 + `ROOM_HALF = 5.9` (`docking.ts:1013`; `adapter.ts:407-411,453-454`) | Neighbor assumed default-size | **S4** — additive `farExtents`/`farDoorPos` on `DoorRecord` (§4). Until then a grown neighbor projects as the legacy box: cosmetic. |
| Doors doc keyspace, `farDoor` enum, pairing maps, transit id plumbing (`doorsDoc.ts:40-45`, `world.ts:100,595-609`, `main.ts:1142-1177`) | Keyspace = the 4 slot ids | **Untouched at every stage** (resolution #6) — the wire format survives #66 in full. |
| Spawn/beam (0, 1.5), room-terminal wireframe (`devices.ts:260-341`), particles/edge dressing (`world.ts:876-978`) | Assume default interior/bounds | Spawn: guaranteed by the eternal base 2×2. Wireframe + cosmetics: **S4**, derived from bounds. |

---

## 3. The `floorPlan` model

### 3.1 Schema — new module `floorPlanDoc.ts`

One new root map `doc.getMap('floorPlan')`, plain-JSON values, bind/subscribe/`docAlive`/notify copied verbatim from the `furnitureDoc.ts` skeleton, rebound at the main.ts T0 seam alongside players/games/roomInfo/furniture/doors.

```ts
// ── Constants (6 m ruling; legacy numbers reproduced exactly) ────────────────
export const TILE_SIZE   = 6.0;           // metres; 12×12 path cells per tile
export const BASE_TILES  = [[-1,-1],[0,-1],[-1,0],[0,0]] as const;  // eternal
export const TILE_MIN    = -3, TILE_MAX = 2;   // build envelope: 6×6 tiles, walls ≤ ±18
export const MAX_TILES   = 36;            // read-side BFS cap (= full envelope)
export const WALK_INSET  = 1.0;           // boundary → walkable  (6−1 = ±5)
export const CLAMP_INSET = 0.8;           // boundary → BOUND     (6−0.8 = 5.2)
export const FRONT_INSET = 1.5;           // wall → door front    (6−1.5 = 4.5)
export const THROUGH_OUT = 1.0;           // wall → door through  (6+1 = 7.0)
export const DOOR_LATTICE = 0.5;          // door-slide snap along the run

// ── Map keys ────────────────────────────────────────────────────────────────
// 'meta'           → { v: 1 }
// `t:${i},${j}`    → TileRecord      (one key per tile — CRDT-mergeable, LWW per key)
// `door:${DoorId}` → DoorPlacement   (one per logical slot)

export interface TileRecord { /* reserved additive: skin?: string */ }
export interface DoorPlacement { x: number; z: number }  // opening centre ON the
  // wall centerline, 0.5 m lattice. Guard: finite, 2·value integral, |·| ≤ 18.
```

Writers (owner-only in practice — edit mode is owner-gated; writes are unguarded functions, the furniture discipline): `writeTile`, `writeDoorPlacement`, and `seedFloorPlan()` — idempotent (no-op if any `t:*` key exists), one transact: 4 base tiles + `meta {v:1}` + the four **legacy** door placements verbatim — north `(0,−6)`, south `(0,6)`, east `(6,−0.5)`, west `(−6,−0.5)` (carried from `doors.ts:31-35`). Seeding happens lazily at the first structure-mode commit, never on claim — existing docs never grow. One `doc.transact` per gesture (the `commitCarry` discipline), never per-frame.

### 3.2 `resolveFloorPlan()` — one deterministic pure function, identical on every client

Input: raw map snapshot. Output: `{ legacy, tiles: Set<"i,j">, doors: Record<DoorId, DoorPlacement>, bbox }`.

1. Collect tile keys passing the key regex + coord bounds (`TILE_MIN..TILE_MAX`) → raw set. Empty → **`{legacy: true}`**: today's room, `DOORS` const verbatim, bit-identical.
2. **BFS from (0,0)**, FIFO, fixed neighbor order N/E/S/W, stop enqueuing at `MAX_TILES`. One pass enforces edge-connectivity and the size cap deterministically (same input set ⇒ same output on every client, regardless of key iteration order). Unreached tiles are *ignored, not deleted* — only the owner's editor garbage-collects with real deletes.
3. If any `BASE_TILES` member is absent from the BFS result → **`{legacy: true}`** + console warn (resolution #11). A hostile peer deleting a base tile cannot brick the room; it deterministically reverts everyone to the fixed layout.
4. **Doors:** for each of the 4 slots, accept `door:{id}` iff the guard passes AND the point lies on an exterior boundary run whose outward normal matches the slot's cardinal, with the full opening (width + posts: small ≈2.0 m, large ≈3.0 m) fitting inside the run clear of corners and other doors. Otherwise the **deterministic fallback**: (a) the legacy `DOORS` position if it is valid on the resolved plan; else (b) among same-facing exterior runs — outermost first (max z for south, min z for north, max x for east, min x for west), then min |cross-axis centre| — the run centre snapped to the lattice. When a wall grows outward past a door, the fallback *follows the wall* until the owner re-places it.

### 3.3 Door identity — the migration that isn't

*(Resolution #6 — this deletes line A's "one true structural migration.")* `DoorId ∈ {north, south, east, west}` is kept permanently within #66's scope: the id names the facing, the placement names the run and offset. Everything A inventoried as keyspace-fragile — `doorsDoc` keys, `farDoor`, pairing lifecycle maps, transit id plumbing, the keypad pane, mirror-pairing writes — changes **zero**, at every stage including arbitrary polyominoes. The costs, stated plainly: at most one door per facing (an L with two south runs hosts its one south door on one of them), and **cross-facing moves are out of scope** — v1 is slide-along-same-facing only, so "the north door" remains *the door that faces north* and every #62 record stays valid without versioning. Both limits lift later without migration: cross-facing would version the pairing records (additively extensible), and a fifth door is a new slot id that old clients simply never iterate.

### 3.4 Validity — prevent on write, repair on read

**Write-side (owner edit UI; verdicts mirror `validatePlacement`'s `{ok, reason}`):**

| Op | Gates |
|---|---|
| Add tile | 4-adjacent to the resolved set; within the envelope; `|T| < MAX_TILES`; costs 1 HULL TILE part (§6.3) |
| Move door | target run has matching facing and geometric fit (opening + posts inside the run, no corner/door overlap); door not paired ("unpair first"); **furniture proximity is NOT a gate** — see §6.2 |
| Remove tile | **v2** — ships with B's full gate battery: not a base tile, connectivity re-check, no furniture footprint on the tile, no player/seat occupant, no hosted door, `requiredReachable` re-verified on a scratch grid (all existing machinery: `computeReachable`, `editMode.ts:886`) |

**Read-side (hostile/racing writes — degrades, never crashes, identical everywhere):** kept in full from line B even though the v1 UI is growth-only (resolution #7):

- Furniture whose footprint falls off the resolved floor **renders and goes inert** — off-floor cells are non-walkable, so no path ⇒ no approach; `rebuildSeats`/`rebuildDevices` skip stand-points off-floor. Don't hide people's stuff; owner UI surfaces "N items off-floor" (S4).
- Local player standing on floor that vanishes under them (remote shrink race): on plan reconcile, evict to the nearest floor cell by deterministic BFS — the `evictAndDefocusForItem` discipline (`world.ts:714+`) applied to the floor itself; stand seated players up first.
- Remote avatars are tick-positioned and unvalidated — they render where their tick says (unchanged).

### 3.5 Compatibility — honest v0.30.x degradation

v0.30.x never calls `getMap('floorPlan')`; Yjs syncs unread root types harmlessly. In a grown room an old client: **renders the fixed 11.8 room**; furniture beyond ±5 applies anyway (`reconcileFurniture` never bounds-checks, `world.ts:654-682`) and renders poking through their walls — unreachable, not broken (their grid covers ±5.5; seat/device clicks no-op). **Remote avatars glide through their walls** — cosmetic. **Doors and transit keep working**: legacy `DoorRecord` fields are always written, room swap is by seed, and each side walks its *own* idea of the door position — a moved door means a v0.31 avatar appears to walk into a wall and vanish. Cosmetic, functional. **Worst actor: an old-client owner** — they can't corrupt `floorPlan` (never write it), but their `validatePlacement` clamps to ±5, so they can drag off-plan furniture inward and never back: split-brain layout fights. Non-corrupting; annoying.

**Flag verdict:** a hard "vNext-only" gate **cannot work** — v0.30.x predates any key it would have to read. So: no hard gate for v1 (the degradation above is cosmetic and non-corrupting), but S1 starts the convention: write `floorPlan.meta = {v: 1}` and `roomInfo.minClient = '0.31.0'` — v0.31+ clients check it and warn, giving every *future* breaking change a real enforcement point (precedent: #62 reserved `meta.schemaVersion` in its §3.5). Intra-v0.31 skew gets the same posture: an S1-era client in an S3-grown room resolves the doors, ignores the tiles it can't render, and clamps door placements to the base runs — degraded-but-functional, advisory via `minClient`.

---

## 4. #62 interplay — all additive, invariant audit at the end

**`DoorRecord` gains two optional fields** (schema fixed now, written from S4 — resolution #8; until any room actually differs from 11.8 there is nothing to write):

```ts
interface DoorRecord {
  connectedRoomAddress: string;   // legacy — always written
  paired: boolean;                // legacy — always written
  segments?: ConnSegment[];       // #62
  farDoor?: DoorId;               // #62 — still a SLOT id; unchanged semantics
  farYawDeg?: number;             // #62
  /** #66: far room's plan bbox in ITS local frame. Absent ⇒ legacy 11.8 box. */
  farExtents?: { x0: number; z0: number; x1: number; z1: number };
  /** #66: far door's face centre in far-room local frame (projection alignment). */
  farDoorPos?: { x: number; z: number };
}
```

Sanitizer additions in the `sanitizeDoorGeometry` style: extents finite, `x0 < x1`, `z0 < z1`, `|·| ≤ 19`; `farDoorPos` finite and on the extents' boundary; any violation drops **both** fields (legacy projection), never the whole record. v0.30.x readers ignore extras — the exact mechanism already verified for #62 P2 (`doorsDoc.ts:28-31`). Writer: whoever docks writes their own plan's bbox + door face position (they know their own plan; no cross-doc peeking).

- **Near side (chain anchor):** `foldChainEnd` is chain-local and untouched. `DOOR_POS`/`DOOR_YAW` (`adapter.ts:415-420`) and the vestibule placement switch become derived-registry lookups (S1) — the chain's wall-face origin moves with the door; identity, pairing records, `resolveArrivalDoor`, and transit choreography change zero.
- **Far side (projection):** with `farExtents` + `farDoorPos`, the gray box takes the extents' size, positioned so `farDoorPos` (rotated per `farDoor`/`farYawDeg`) lands on the chain exit; absent ⇒ legacy `ROOM_HALF = 5.9` constants, bit-identical.
- **Octagon worked numbers (#62 §4.4):** `R = 23.41`, `ΣL = 6.81` remain valid **for base-plan rooms only** — the presets assume h = 5.9 and on-axis doors. The planned #62 S2 pose solver gains two per-endpoint inputs: wall-face distance and door offset along the wall (defaults 5.9 / 0). Consciously versioned there, not here.
- **Invariant audit:** "rooms stay cardinal; the connector takes the turn" — **preserved by construction**: a slot may only sit on an exterior run facing its own cardinal, so every door normal stays cardinal; bends stay in the connector. The *secondary, previously implicit* assumption — "door at the axis midpoint of a ±5.9 wall" — is consciously demoted from constant to per-door data, versioned additively via the registry (near) and the two new fields (far).

---

## 5. Generation + rendering

### 5.1 Derivation pipeline (pure functions, mirrors `buildObstacleList`/`buildSeatList`)

1. **Boundary walk:** for each tile, each side with no neighbor is an exterior edge; merge collinear same-facing edges into **runs**. Every run has a cardinal outward normal — this is how the invariant generalizes mechanically.
2. **Walls per run:** subtract each door's span (opening + posts) from its run → wall pieces: interior brick mesh (texture repeat scaled by piece length, `world.ts:415`), outer-hull mesh (zoom ≥3 skin), 1 m header strip over openings, **and one obstacle AABB per piece pushed into `OBSTACLES`**. This is the key unification: boundary walls stop being implicit (the ±5.0 grid test + the BOUND clamp) and become first-class obstacles, so player collision, A*, and `validatePlacement` all get walls for free through the existing `rebuildObstacles → rebakeWalkableGrid` pipe. `BOUND` survives only as a coarse outer clamp = plan bbox half-extent − 0.8 (for the base plan: 5.2, bit-exact). Note the zero-diff property: wall AABBs occupy cells the region test already blocks, so adding them changes no bake output.
3. **Doors:** `DOORS` becomes a derived registry with `rebuildDoors()` — face = placement on the centerline; `front = face − 1.5·outward`; `through = face + 1.0·outward`; `faceAngle` = the slot's cardinal. Legacy plan short-circuits to the existing const.
4. **Floor / click plane / grid:** per-tile 6×6 floor planes with the UV offset from §1; click plane = one merged `ShapeGeometry` of the boundary polygon, so `getClickPlane()` still returns a single mesh — `editMode.ts:601` and the main.ts raycasts (`main.ts:3327-3405`) unchanged; grid helper per tile (6 divisions).
5. **Roof / hull / fade:** roof = extruded boundary-polygon cap at 4.14 with 0.175 overhang; the facing fade extends per wall piece via the same `DOOR_NORMALS` cardinal-dot test — axis-aligned runs guarantee it.

### 5.2 Rebuild pipeline — `reconcileFloorPlan(records)`

A sibling of `reconcileFurniture` (`world.ts:638`), subscribed once in the World constructor, no-op until the platform exists, self-echo finds an empty diff. Onto the existing commitCarry/reconcile order:

| Stage | New/changed | Existing anchor |
|---|---|---|
| 0. diff tiles + placements; defer one frame if `activeDoorId` is a moved door | new | the `updatePairedVestibules` deferral (`world.ts:1581-1597`) |
| 1. `rebuildRoomStructure()` — dispose + rebuild wall pieces, floor tiles, click plane, roof, grid, edge lights; `dockingSystem.rebuildPorts()` **preserving `doorState`** (pairings survive; only groups move) | new | `removeFurnitureVisuals` disposal discipline |
| 2. `rebuildDoors()` | new | derived-registry idiom (seats/devices) |
| 3. `rebuildObstacles()` — furniture + wall pieces | changed | `obstacles.ts:21` |
| 4. `rebakeWalkableGrid()` — region test = `isInsidePlan` | changed | `pathfinding.ts:41` |
| 5. `rebuildSeats(); rebuildDevices()` | unchanged | commitCarry order (`editMode.ts:660-664`) |
| 6. `player.onObstaclesChanged(id)` per moved door (cancels in-flight approaches); growth adds floor, so no eviction on the happy path; the §3.4 evict rule covers hostile shrink | unchanged | `world.ts:702-704` |
| 7. `updateRoomFraming()` — camera focus/frustum from `planExtents()`; projections/vestibules re-anchor (extend the `segmentsKey` rebuild-on-diff with an anchor key, `world.ts:1495`) | new | rebuild-on-diff pattern |
| 8. live edit session re-index (`roomEdit.forceExit(); enter()`) | unchanged | `world.ts:708-711` |

Not rebuilt: furniture groups, remote avatars, particles (spawn volume reads plan extents lazily).

### 5.3 The zero-diff gate (S2 acceptance)

Regenerate the default 2×2 plan through the full pipeline and require **byte-identical output**: byte-compare the walkable grid, screenshot-diff the room, before/after. The four cardinal legacy cases pinned #62 P1's sign convention; the default plan pins this refactor. Line A's Stage-0 consumer checklist (§2 rows: boundary tests ×4, BOUND, platformSize/click plane, camera targets, cosmetics) is the S2 completion checklist.

### 5.4 Pathfinding + camera numbers

Grid: `GRID_SIZE` 22 → **80** (±20 m at 0.5 m cells; 6.4 KB; A*'s linear open-set min-scan is fine at 6400 cells for click-to-move — 1.5× the count line C already argued acceptable). Envelope `i,j ∈ [−3..2]` puts walls within ±18, walkable within ±17; through points at ±19 are inside the grid, and hold points (±20.2 worst-case) don't need it — scripted door walks bypass pathing and the clamp (`player.ts:1194`). `GRID_SIZE`/`GRID_HALF` are exported consts imported by `editMode.ts` and `npc.ts` — refactor to accessors in the same PR. Nothing in the wire format bakes the grid in, so dynamic-origin grids remain a local-only future change if the envelope ever widens. Camera: §2's `planExtents()`-driven framing; the 45° detents and facing fade need nothing.

---

## 6. Build UX

### 6.1 Where it lives — edit mode, not the keypad

The keypad/terminal owns *connections between rooms* (#62); #66 is the room's own structure — and edit mode already has the owner gate, click-routing precedence (`main.ts:3317-3322`), the 1 m grid, the green/red validity idiom, and force-exit discipline. Add a **FURNITURE | STRUCTURE** toggle row next to ✓ DONE EDITING. The first structure-mode commit calls `seedFloorPlan()`.

### 6.2 Door move (S1)

Doors join the structure-mode raycast index: click selects, second click picks up (the `beginCarry` idiom); valid drop slots highlight along exterior runs of the **same facing** — 0.5 m lattice positions with geometric fit (opening + posts inside the run, clear of corners and other doors). Drop → one-transact `writeDoorPlacement` → local rebuild → doc write (the commit-then-write self-echo discipline, `editMode.ts:669`). Rules that keep #62 intact: **(a)** same-facing only (§3.3); **(b)** a **paired** door cannot move — hint "unpair first" — so no live re-solving of chain geometry, ever; **(c)** a remote placement change on a door mid-walk-through defers one frame (§5.2 stage 0). **Furniture blocking is dynamic, not structural** (resolution #10): `updateNorthDoorForFireplace` (`world.ts:619-636`) generalizes to `updateDoorBlocking(plan)` over all 4 slots — approach zone derived from the placement (width ±1.4 along the run; depth `face + 0.2·outward` to `front − 0.1·outward`, which plugs in the exact legacy north zone `{±1.4, −6.2..−4.4}`); a slot whose zone holds furniture highlights amber and drops the door to disabled-until-cleared. Safe: only unpaired doors move, and disabled merely blocks initiation. Door moves cost no parts.

### 6.3 EXPAND (S3)

Ghost tiles — translucent green 6×6 slabs at every empty cell 4-adjacent to the plan, inside the envelope — join the raycast targets. Click a ghost → it arms (highlight + "CONFIRM HULL TILE" chip) → second click commits: consume **1 HULL TILE** from stationParts (new `PartKind: 'hull'`, same localStorage/dev-grant pattern, `stationParts.ts:22`), apply locally through the full §5.2 rebuild, then write the doc. Two-click confirm instead of undo (resolution #8). **Growth-only in v1**: addition of floor needs only the envelope + part + adjacency gates, never a connectivity gate — the #53 "removal needs no validity gate" argument, inverted. Robot-arm/EVA gating of hull tiles is deferred with the same honesty note as #62's flex/ext parts: dev-grant now, fiction later.

---

## 7. Dependency-ordered slices

Sized like this repo ships them: one point release each, frontend-only, on the live prototype line. **Ordering argument (resolution #4):** S1 before S2 because door-slide ships the visible #66 feature with zero wire risk on the smallest surface *and* forces the `DOORS`-as-derived-state refactor everything later needs — the only new mesh work is the wall-with-gap builder on the four fixed runs, which then *is* the per-run builder S2 generalizes; grow-first would drag grid, camera, click plane, roof, BOUND, and projection into one PR. S2 before S3 because generation must be proven byte-identical on the default plan before the first room actually changes shape.

| # | Slice | Files | Risk |
|---|---|---|---|
| S1 | **Door slide**: `floorPlanDoc.ts` (doors + seed + resolver), `DOORS` → derived registry, port/adapter anchors from registry, wall-gap builder on the four fixed runs, STRUCTURE mode + door carry UX, `updateDoorBlocking` generalization, `meta.v` + `roomInfo.minClient` | `floorPlanDoc.ts` (new), `doors.ts`, `docking.ts`, `adapter.ts`, `editMode.ts`, `world.ts`, `main.ts` (T0 bind) | Medium — touches the ~160-ref door coupling, but geometry, grid, camera, click plane untouched. Acceptance, two-tab: slide the east door 2 m; peer follows; pair + transit land; a v0.30.6 tab shows the default position but transit resolves. |
| S2 | **Zero-diff generation refactor**: boundary-walk generators (walls/floor/roof/click plane/hull), `isInsidePlan` seam ×4, walls → `OBSTACLES`, BOUND derivation, `planExtents()` accessor, placement containment | `world.ts`, `pathfinding.ts`, `obstacles.ts`, `player.ts`, `editMode.ts` | Medium — largest diff, zero behavior change; the §5.3 parity gate is the whole review. Line A's consumer checklist is the completion checklist. |
| S3 | **EXPAND one tile**: ghost tiles + confirm UX, HULL TILE part, tile write path + growth-only reconcile, `GRID_SIZE` 80 + accessor refactor, camera reframing | `editMode.ts`, `stationParts.ts`, `floorPlanDoc.ts`, `pathfinding.ts`, `npc.ts`, `cameraRig.ts`, `zoom.ts`, `world.ts` | Medium — first release where rooms actually differ; multi-tab per the testing recipe, plus a v0.30.6 tab for the §3.5 degradation script. |
| S4 | **Polish**: `farExtents`/`farDoorPos` + sanitizer + posed projection sizing, terminal wireframe from plan (`devices.ts:260-341`), cosmetics on generated boundaries (corner markers, edge lights, particles), off-floor-furniture owner surfacing, non-rect framing tuning | `doorsDoc.ts`, `docking.ts`, `adapter.ts`, `devices.ts`, `world.ts` | Low — additive wire fields (the verified #62 P2 mechanism) + cosmetics. |
| v2 | **Deferred, together**: tile removal + undo (the §3.4 gate battery — undo-of-add *is* a remove), cross-facing door moves (versions pairing records), >4 door slots, dynamic grid origin, dims-aware #62 solver inputs | — | Consciously out of #66. Nothing in S1–S4 forecloses any of it. |

S1 alone delivers "doors are furniture now"; S1–S3 deliver #66's full ask for growth; S4 makes grown rooms honest to neighbors.

---

## 8. Known unknowns

Decision-forcing, not blocking. S1–S3 hold regardless of how these resolve.

1. **Concave-corner wall visuals.** Inner corners of an L need a post/junction treatment and texture-seam handling the current 4-wall room never exercises — estimate, not designed; check in S2 with a hand-built L behind a dev flag before S3 ships the UI.
2. **Framing at large plans.** A 6×6-tile plan is ±18 m; the L2 frustum scaled to that may read too small for play. Grow-the-frustum vs add-panning is unresolved (line A flagged it; C's bbox scaling is the v1 answer). Decide when someone builds big — S3's envelope makes it reachable.
3. **Default-fallback door jump.** If a valid placement record turns invalid (e.g. hostile tile churn), the §3.2 fallback can move the door a run away; every client agrees, but the visual jump is unstudied. Likely fine (same class as #62's wrong-arrival-door cosmetics).
4. **A\* at 6400 cells.** The linear open-set min-scan at `GRID_SIZE` 80 is argued fine, not measured — profile in S3 with a worst-case full-envelope plan.
5. **Old-owner split-brain.** The §3.5 worst actor (v0.30.x owner dragging furniture inward, never back) is tolerated for v1; if it bites, the fix is the `minClient` advisory hardening into a refuse-to-edit gate — a policy call, not a design change.
6. **Hull-tile economy.** Part cost, sourcing fiction (robot-arm/EVA install), and whether door *moves* should ever cost anything — deferred with the same honesty note as #62's parts (dev-grant now).
7. **Grown rooms in the octagon.** #62's presets and worked numbers hold for base-plan rooms only; a grown room joining a ring needs the dims-aware solver (#62 S2, which now has its two extra inputs specified — §4). Decide there, not here.
8. **Texture continuity.** The per-tile herringbone UV offset is computed, not eyeballed — verify in S2's screenshot gate.

---

*Provenance note: all file/line citations are carried from the three research passes (A: fixed-geometry assumption map; B: data model/sync/compat; C: generation/rendering/build UX), which read the current 0.30.6 files in-source this session; they will drift with edits. The 6 m tile ruling and its derived constants (§1, §3.1, §5.4) were resolved in this synthesis — B's schema and guard discipline were re-based onto them, and B's 2 m-derived numbers (TILE_COORD_MAX 8, MAX_TILES 128, the seeded-door 0.5 m deviation) are superseded. Conflict resolutions are tabulated in §1.4 and argued inline. This document is design synthesis, not shipped behavior.*