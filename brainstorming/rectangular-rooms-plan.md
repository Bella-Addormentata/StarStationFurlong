# Rectangular Rooms on the 6 m Grid — Design Amendment to #66

*Star Station Furlong — rooms of arbitrary W×H (multiples of a 6 m tile), up to a limit. Amendment to [floorplan-grid-plan.md](floorplan-grid-plan.md), grounded in the LIVE code at v0.32.35. Owner direction 2026-07-20: "rooms of different sized rectangles (4×4, 4×8, 12×12, 12×10 … any rectangle up to a limit); we can keep the 6 m increments if that makes it easier."*

> **Companions:** [floorplan-grid-plan.md](floorplan-grid-plan.md) (#66 — the full movable-doors + growable-floor plan this amends), [angled-vestibules-octagon-plan.md](angled-vestibules-octagon-plan.md) (#62 — "rooms stay cardinal; the connector takes the turn"). Shipped precursor: **S1 door-slide + the `floorPlan` doc map, v0.32.1** (`floorPlanDoc.ts`).

---

## 1. What changes vs the parent plan

The parent plan (§1.4 resolution #5) **dropped** a rectangle-intermediate stage and went straight to **6 m polyomino tiles** (arbitrary L-shapes). The owner's direction reprioritizes the rectangle as the *primary* goal and accepts the 6 m grid. That is a strict **simplification** of the parent plan:

| Parent plan (polyomino) | This amendment (rectangle) |
|---|---|
| Tile *set* → **boundary walk** to find wall runs, concave-corner handling | Rectangle → **exactly 4 walls**, one per cardinal. No boundary walk, no concave corners. |
| "Two south walls" → door-identity questions (resolved to keep 4 slots) | One wall per cardinal → `DoorId` stays the 4-value union trivially. |
| `floorPlan` carries a tile **set** (`t:i,j` keys) + BFS resolver | `floorPlan` carries **two integers** (`cols`, `rows`). No BFS. |
| EXPAND = add one tile at a time | SET SIZE = choose W×H (cols×rows) from a picker |

**Everything else the parent plan established still holds and is reused verbatim:** the 6 m tile ruling (today's room = **2×2 tiles**, its ±6 walls are exactly the 2×2 boundary), *store the plan / derive the geometry*, empty-plan ⇒ bit-identical legacy, additive-wire-only, owner-writes + read-side validation, and the S1 delta machinery for door *slide* (which is orthogonal — a door slides *along* a wall; the wall itself now moves *with* the room size).

**The dimensions snap to the 6 m grid.** The owner's examples map to: 4×4→**6×6** (1×1), 12×12→**12×12** (2×2, today), 4×8→**6×12** (1×2), 12×10→**12×12** (2×2). Sizes are `cols·6 × rows·6` metres, `cols,rows ∈ [1 … LIMIT]`, centred on the origin (half-extents `halfX = cols·3`, `halfZ = rows·3`).

---

## 2. The invariants (kept from the parent, restated for rectangles)

- **Rooms stay cardinal.** A rectangle's four walls each face exactly one cardinal; every door normal stays cardinal; `DoorId` stays `{north,south,east,west}` (~160 refs untouched); #62 transit/pairing/chain math is untouched. The connector still takes any turn.
- **Rooms stay centred on the origin.** Floor spans `[−halfX, +halfX] × [−halfZ, +halfZ]`. This is load-bearing across the whole spatial stack — the ortho frustum bounds, `lookAt(0,0,0)` in 5 sites, the pathfinding grid, and every `±half` wall are symmetric about the origin. Off-centre rooms would multiply the change surface; we do **not** do that.
- **Default = 2×2 ⇒ bit-identical.** `cols=rows=2` ⇒ `halfX=halfZ=6`, reproducing today's geometry byte-for-byte. Absent dims ⇒ default. This is the S2 "zero-diff" gate, adapted.
- **Store the plan, derive the geometry.** Walls, floor, click plane, grid, the `DOORS` registry, obstacles, the walkable grid, camera framing, `BOUND` clamp — all recomputed from `(halfX, halfZ)`. Nothing derived is written.
- **Additive wire, validate on read.** `floorPlan` gains a `dims` record; `DoorRecord` gains optional far-extents (parent §4). Junk degrades every client identically to legacy; never a crash, never divergence.
- **Preserve the inset nesting.** Today three half-extents nest inside the walls: **grid ±5.5 ⊋ clamp ±5.2 ⊋ walkable/placement ±5.0 ⊂ walls ±6.0** (insets from the wall: 0.5 / 0.8 / 1.0). Every derived bound keeps its inset *from the wall*, per axis — `walkable = half − 1.0`, `clamp = half − 0.8`, grid covers `half + 0.5`. Collapsing these makes paths hug/clip walls.

---

## 3. Data model — extend `floorPlanDoc.ts`

Add ONE record to the existing `floorPlan` map (the module S1 already binds at the T0 seam):

```ts
// floorPlan map key 'dims' → RoomDims. Absent ⇒ default 2×2 (today's room).
export interface RoomDims { cols: number; rows: number }   // tile counts, 6 m each
export const TILE_SIZE = 6;
export const ROOM_TILE_MIN = 1;
export const ROOM_TILE_MAX = 4;   // envelope: up to 4×4 tiles = 24×24 m (tune)

/** Cached room half-extents in metres, read cheaply everywhere (per-cell in the
 *  walkable bake). Refreshed on bindFloorPlan + every floorPlan change. */
export function roomHalfExtents(): { halfX: number; halfZ: number };  // default {6,6}
export function readRoomDims(): RoomDims;      // sanitized: ints, clamped to [MIN,MAX]
export function writeRoomDims(cols, rows): void;   // owner-gated at the call site
```

- **Sanitize on read** (parent §3.4 discipline): non-integer / out-of-range / absent ⇒ default `{2,2}`. A hostile `dims` can never exceed the envelope or crash geometry — it clamps.
- **Cache, don't re-read per cell.** `rebakeWalkableGrid` calls the boundary test thousands of times; `roomHalfExtents()` returns a module-cached `{halfX,halfZ}` recomputed only when the `floorPlan` map changes (the existing `subscribeFloorPlan` / `notify` path). Cheap everywhere.
- **Fix the S1 seed migration gap:** `seedFloorPlan()` early-returns if any `t:` key exists (v0.32.1 docs already have them), so a naïve dims-in-seed never runs for existing rooms. Seed `dims` **outside** the tile guard (or lazily on first resize), defaulting to `{2,2}` so existing squares are the exact zero case. Bump `meta.v → 2` and `roomInfo.minClient → '0.32.36'` (the parent §3.5 convention) so a pre-amendment client that would misread a rectangle as a square is warned.

The dormant `t:i,j` tiles stay dormant — a rectangle is fully described by `{cols,rows}`; we do not populate a tile set (that was for polyominoes). The `t:` seed keys remain only as the existing "already-seeded" sentinel.

---

## 4. Derivation — the single seam every fixed number reads from

**The core work is mechanical:** replace every hardcoded `±6 / 12 / 5.0 / 5.2 / 5.5 / 14 / 11.8` room-dimension literal with a value derived from `(halfX, halfZ)`. The current-code inventory (verified at v0.32.35):

| Subsystem | Current literal(s) | Derived form |
|---|---|---|
| **Walkable test** ×2 — `pathfinding.ts:55,240` | `\|w\|>5.0` | `\|wx\|>halfX−1.0 \|\| \|wz\|>halfZ−1.0` |
| **Placement bounds** ×4 — `editMode.ts:163,170`; `devMenu.ts:233,272` | `±5` / `±5.5` | per-axis `half−1.0` (`half−0.5` for the probe) |
| **Player clamp** — `player.ts:124` `BOUND=5.2` + 4 sites (1048,1049,1149,1154) | one scalar | `boundX=halfX−0.8`, `boundZ=halfZ−0.8`; clamp X vs boundX, Z vs boundZ |
| **Floor / click / grid** — `world.ts:302,305,385,397` `platformSize=12`, `12` divisions | 12×12 | `2·halfX × 2·halfZ`; grid divisions `2·halfX / 1`, `2·halfZ / 1` |
| **Walls (SPLIT!)** — `addSideWalls` (`world.ts:443` builds only the LEFT wall) + `addCapsuleOuterStructure` (`world.ts:530` front/back/left/right/roof) | ±6 positions, `12`/`12.35` lengths | walls at `±halfX,±halfZ`; lengths `2·half` (+0.35 hull overhang); roof `2·halfX × 2·halfZ` |
| **Grid** — `pathfinding.ts:23` `GRID_SIZE=22` (imported by editMode/devMenu/devices/seats) | 22 (±5.5) | static bump to cover the envelope (parent §5.4: **80**, ±20 m, keep the grid **square** at `max(halfX,halfZ)` so `GRID_HALF`-as-origin-offset stays valid on both axes) |
| **Camera** — `renderer.ts:11` `VIEW_SIZE=14` + `zoom.ts:656` dup | 14 | `≈ max(halfX,halfZ)·scale`; **consolidate the two copies + the 3 orbit-offset copies** (`renderer:69`, `cameraRig:54`, `zoom:28`) to one exported source first |
| **Wall-cover / aperture** — `world.ts:724-725` (`±5`), `world.ts:2212` (`5.15`) | ±5 | `±(halfX−1)` / `halfX−0.85` — these mean "just inside the wall", scale with `half` |
| **Textures** — brick repeat `world.ts:485` (12,4); floor repeat (3.5,3.5) | fixed | scale repeat by `2·half / 12` so tiles don't stretch |
| **Doors** — `doors.ts` DOORS front/through; `docking.ts` port build; `adapter.ts` DOOR_POS/ROOM_HALF; `floorPlanDoc.ts` LEGACY_PLACEMENTS + DOOR_LATERAL_LIMIT | ±6 wall coord, ±4.0 lateral | wall coord = `±halfZ` (n/s) / `±halfX` (e/w); lateral limit per-wall run |

**The S1 `readDoorPlacement` wall-equality check (`floorPlanDoc.ts:120`) is THE blocker.** It hard-rejects any door whose wall coord ≠ the constant `±6` and silently returns legacy — so the instant walls move with size, every slid door reverts with no error. It must validate against the *derived* wall coord `(halfX/halfZ)`, and the lateral clamp (`DOOR_LATERAL_LIMIT`, one scalar today) must become per-wall (the run length is `2·halfX` for n/s doors, `2·halfZ` for e/w).

**Door positioning has a two-stage subtlety** (`docking.ts` `buildPorts` builds at the legacy wall, `repositionDoorGroups` applies the slide delta *absolutely* assuming legacy lateral 0): if we bake `half` into `buildPorts`, the reposition must stay "position = delta from the derived base", not double-count. This is the one non-mechanical door change.

---

## 5. Slices (dependency-ordered, one point release each)

| # | Slice | What ships | Gate |
|---|---|---|---|
| **R0** ✅ | **Dims model + accessor** (shipped, inert) | `floorPlan.dims` + `roomHalfExtents()` cached accessor + sanitizer, default 2×2; `readRoomDims`/`writeRoomDims`; envelope `ROOM_TILE_MAX=5` (owner ruling — 30×30 m). No consumers. | Zero behavior change (nothing reads it). |
| **R1** ✅ | **Generation refactor, byte-identical** | Every ENVELOPE site derives from `roomHalfExtents()` — see the R1 scope box below. Static grid bump (`GRID_SIZE=64`, ±16 m, covers the 5×5 envelope). | **Byte-identical for the default 2×2** — verified live: `roomHalfExtents()`={6,6}, walls ±6, floor 12×12, all four door walk-targets exactly legacy, walkable grid identical by construction (`halfX−1.0`=5.0), clean boot. |
| **R2** | **Bigger rooms actually render** | Widen `subscribeFloorPlan` to rebuild room geometry (walls/floor/grid/doors/camera) on a `dims` change; verify a 1×2 and 3×2 room render, walk, and place furniture correctly. | Two-tab: a 3×2 room syncs + is walkable; a v0.32.35 tab shows the default square (degrade). |
| **R3** | **Set-size UX + limit** | Owner picks W×H (edit-mode STRUCTURE toggle or a dims picker on the room terminal); enforce the tile limit; re-derive doors. Paired doors + resize interaction (a resize is stronger than a slide — guard or unpair). | Owner sets 6×12; persists; doors sit on the new walls. |
| **R4** | **Neighbor projection + polish** | `DoorRecord.farExtents`/`farDoorPos` (+ sanitizer) so a docked neighbor's grey projection box is *its* size, not 11.8³; the exterior/station atlas carries per-room W×D so the octagon shows real footprints; corner markers / edge lights / hull from bounds. | A small room docked to a big one projects without overlap/gap. |

R0–R1 are foundation (no visible change); R2 is the first release where rooms differ; R3 is the owner-facing feature; R4 makes grown rooms honest to neighbors and the station map.

### R1 shipped scope (2026-07-20)

**Derived now (the ENVELOPE the player physically touches)** — all in files that derive from `roomHalfExtents()`:
- `pathfinding.ts` — walkable bounds `half−1.0` per axis; `GRID_SIZE` derived from `ROOM_TILE_MAX` (=64), grid stays square, world↔cell math unchanged; `computeReachable` matches.
- `world.ts` — floor/click plane `2·half`; grid helper; wood + brick texture repeats (scale with the plane/wall so tiles never stretch); the built-in left side wall + coping; the 4 capsule outer-hull walls + roof (`+0.35` overhang); corner markers (`half−0.5`); platform edge lights; `updateSideWallCoverage` threshold (`half−1`); the north-door fireplace zone (`−halfZ`); the per-wall door aperture threshold (`(n/s?halfZ:halfX)−0.85`).
- `player.ts` + `npc.ts` — movement clamp `half−0.8` per axis.
- `editMode.ts` + `devMenu.ts` — placement bounds `half−1`, spawn probe bound `half−0.5` + probe range `2·half`.
- `doors.ts` — walk-target base points (stand-point `half−1.5` in, through `half+1.0` out).
- `docking.ts` — `buildPorts` door group positions (`±half`); `chainBoxesFor` FACE; the jetbridge-fit **our**Face.
- `adapter.ts` — `DOOR_POS`/`doorPositions()` (our doors); vestibule + connector-chain wall placement.
- `floorPlanDoc.ts` — **the S1 blocker fixed**: `readDoorPlacement` now validates against the DERIVED wall coord (`doorWallCoord`), `writeDoorPlacement` writes it, and both fall back to `defaultPlacement` (this room's wall) not the old ±6. The lateral-delta machinery stays orthogonal to room size. **`doorLateralLimit(doorId)`** derives the along-wall slide clamp from the sliding wall's run (`min(4.0, half−2.0)` — 4.0 at default, shrinks on a ≤1-tile axis so a door can never slide off-wall); found by the R1 adversarial review.

**Deliberately deferred (correct at the default; a later slice owns each):**
- **Camera framing → R2.** `renderer.ts` `VIEW_SIZE=14`, `cameraRig.ts` `LEVEL_OFFSETS`, `zoom.ts` dups. Only needs to scale when a room actually renders bigger; R2 consolidates the copies to one source and derives from `max(halfX,halfZ)`. `DOOR_LATERAL_LIMIT` also stays the 4.0 scalar → per-wall run at R3.
- **Exterior hull → R4.** `hull.ts` exterior-mount lattice, `exteriorView.ts` `11.8` hull boxes.
- **Neighbour projection → R4.** `docking.ts` `doorFaceLocal` ±6 (the matched neighbour's frame) + `roomGeo` 11.8; `adapter.ts` `ROOM_HALF=5.9` + `LEGACY_PROJECTION_OFFSET=15.2` (all neighbour-sized — need per-neighbour `farExtents`).
- **Diegetic map wireframe → R4.** `devices.ts` `PORT_VIEW` ±6 (self-contained top-down map with its own world→canvas projection).
- **Pool/outdoor décor → R4.** `world.ts` pool lights/sign; `furniture.ts` pool geometry + default furniture spawn positions.

---

## 6. Compatibility & risks

- **Old clients (v0.32.35 and earlier):** never read `floorPlan.dims` → render the default 12×12 square. Furniture beyond ±5 applies anyway (`reconcileFurniture` never bounds-checks) — renders through their walls, unreachable, not broken. Remote avatars glide through their walls (cosmetic). Doors + transit keep working (legacy `DoorRecord` fields always written; each side walks its own idea of the wall). Non-corrupting, cosmetic. `minClient` advisory warns v0.32.36+ readers.
- **Paired-door + resize:** paired doors are slide-locked so #62 chain math never re-solves live. A *resize* is a stronger geometry change than a slide — R3 must either refuse resize while any door is paired ("unpair first", mirroring the slide rule) or re-solve on resize. **Decision needed at R3** (lean: refuse-while-paired, cheapest + safest).
- **Grid stays square at `max(halfX,halfZ)`** to keep `GRID_HALF`-as-origin-offset and the square key math (`r·GRID_SIZE+c`) valid on both axes — a non-square grid touches world↔cell math in 4 importer modules. Per-axis grid is a deferred optimization.
- **`CELL_SIZE=0.5` is duplicated** as a bare literal in `furniture.ts:2743` (comment-synced only) — don't touch `CELL_SIZE`; we only change `GRID_SIZE`.
- **A\* at the bigger grid** (up to 6400 cells) — argued fine by the parent (§8.4), profile at R2 with a worst-case room.
- **Known unknowns** carried from the parent §8: framing at large plans (frustum scale vs pan — decide at R2), texture continuity on resized floors (screenshot gate at R1), hull-tile / size economy (dev-grant now, fiction later).

---

*Provenance: file/line citations verified in-source at v0.32.35 (a 4-reader study, 2026-07-20) — they drift with edits. This amends floorplan-grid-plan.md's tile-shape scope from polyomino to rectangle per owner direction; every other resolution in that plan stands. Design synthesis, not shipped behavior.*
