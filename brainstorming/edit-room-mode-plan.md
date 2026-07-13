# Implementation Plan — Issue #25 "Edit room mode" (room-edit phases only)

Target: `prototypes/0.22.0-core-loop-demo`, implemented on top of open PRs #26/#27/#29 (except E1, which is conflict-free and can land first).

## 0. Verified ground truth

- **Furniture is procedural and positional-only.** `world.ts` `addLobbyFurniture()` (lines 401–708) uses a local `place(geo, mat, x, y, z, ry)` helper (421–428) that adds each mesh to `platformGroup` and pushes it into `furnitureMeshes` (drives morph fade-in at 959–963 and zoom-level ≥3 hide at 986–995). A second local `place()` exists in `addAtmosphereEffects()` (719–727) — sofa cushions placed there at hardcoded world coords (779–786), not relative to sofas.
- **Three divergent obstacle sources**: `obstacles.ts` OBSTACLES (real; consumed by pathfinding.ts:16 and player.ts:28); `pathfinding.ts` bakes `walkable` once in a module-load IIFE (35–55), no mutation API; `npc.ts` carries its own STALE obstacles copy but is dead code (not imported anywhere). Existing drift: front-right lamp table obstacle x[4,5] z[4,5] but visual at (4.5, 3.5); cherry trees have no collision at all.
- **Seats**: seats.ts hand-authors 13 Seat entries (26–81) with clickBox/front/sit/faceAngle; front-sofa seats approach from the sides because the coffee table blocks the front.
- **Ownership is fake**: every client writes roomInfo.owner = 'Local-Clone' (main.ts:283–289); room-name edit gate compares against that literal (main.ts:763–764). Real identity = S2 in brainstorming/phone-apps-breakdown.md.
- **Sync/persistence**: node's yrs doc is Doc::new() in an in-memory HashMap (ssf-p2p-node/src/main.rs:60/455/586/856). Nothing on disk — room doc dies with the node process. Client declares y-indexeddb@^9.0.12 but never imports it.
- **Open-PR overlap** (verified hunk-by-hunk): #26/#27/#29 do NOT touch world.ts 401–708 (furniture builder region). #29 rewrites onCanvasClick + grows player.ts ~400 lines; #27 replaces the remotePlayers sphere system; #26 adds despawn methods in the same region.

## 1. Ownership decision

Ship v1 with a permissive owner check + TODO; do not gate on identity landing:

```ts
function canEditRoom(): boolean {
  // TODO(#20-S2): replace with playersMap identity check once stable playerIds land.
  if (!yjsSync) return true;                       // offline: your room
  return (yjsSync.doc.getMap('roomInfo').get('owner') ?? 'Local-Clone') === 'Local-Clone';
}
```

Precedent: the room-NAME edit gate already does this (main.ts:763–770). After #26/#27 merge, the node's stable 8-byte lane id becomes a candidate owner value — note in the TODO.

## 2. Data-driven furniture registry (`src/furniture.ts`, new)

```ts
export type Rot = 0 | 1 | 2 | 3;                       // quarter turns CCW about +y

export interface FurnitureItem {
  id: string;                                          // 'armchair-left-0', 'sofa-back', 'rug-fireplace', …
  kind: FurnitureKind;
  pos: { x: number; z: number };
  rot: Rot;
  movable: boolean;                                    // false: fireplace wall, bar corner (v1)
  footprintOverride?: Box | null;                      // E1 parity escape hatch
}

export interface FurnitureDef {
  kind: FurnitureKind;
  build(ctx: BuildCtx): THREE.Group;                   // meshes RELATIVE TO ORIGIN; ctx = m()/flat()/addLight()
  footprint: { w: number; d: number } | null;          // null ⇒ decorative/rug: never an obstacle
  seats?: SeatTemplate[];                              // sit offset, faceAngle, preferred front offset
}

export const FURNITURE: FurnitureItem[] = [ /* today's exact layout */ ];

export function itemAabb(item: FurnitureItem): Box | null;
export function buildObstacleList(items: FurnitureItem[]): Box[];
export function buildSeatList(items: FurnitureItem[]): Seat[];
```

Key decisions:
1. One THREE.Group per item, built at origin; mirrored variants via rot (geometry is symmetric). Fireplace wall (world.ts:444–532) and bar corner (645–707) become composite movable:false items. Cushions move INTO the sofa builders as children (offsets chosen to reproduce today's exact world positions).
2. World keeps existing fade/zoom machinery: traverse each group, push child meshes into furnitureMeshes and lights into furnitureLights — zero changes to 959–995. Add `furnitureGroups: Map<string, THREE.Group>` for selection/movement.
3. obstacles.ts becomes derived, keeps export shape: OBSTACLES stays an exported array; `rebuildObstacles()` clears in place (`OBSTACLES.length = 0; OBSTACLES.push(...)`) so consumers see updates with no import changes. Room-boundary walls stay implicit.
4. pathfinding.ts gains `rebakeWalkableGrid()` (replaces IIFE 35–55, refills `walkable` rows in place; call at module load + on obstacle change). Also export a flood-fill/reachability helper reusing the 8-dir + corner-cut rule (163–171) for E3 validity.
5. seats.ts becomes derived: `rebuildSeats()` from templates. Front points COMPUTED, not authored: preferred front offset; if blocked in the baked grid, search adjacent walkable cells around the footprint (generalizes the hand-tuned side approaches). Seat ids `${item.id}:${templateIndex}`.
6. Grid snapping: 1.0 m tile system, snap in 0.5 m steps with per-axis parity (odd tile-width ⇒ center at n+0.5, even ⇒ n). Reproduces every existing position.
7. E1 parity escape hatch: footprintOverride reproduces the lamp-table mismatch + bar/stool strip; cherry trees keep footprint:null. Cleanup is a later follow-up, deliberately NOT in E1.

## 3. Phased slices (each one PR)

### E1 — Registry refactor, zero behavior change ← FIRST PR (safe to land before #26/#27/#29 merge)
Files: new src/furniture.ts; world.ts (addLobbyFurniture shrinks to registry loop; cushions out of addAtmosphereEffects), obstacles.ts (derived + rebuildObstacles), pathfinding.ts (IIFE → rebakeWalkableGrid), seats.ts (derived + rebuildSeats).
Acceptance: pixel-identical room (zoom levels 1–4 + during morph); all 13 seats sittable with identical approach; sliding collision identical; OBSTACLES contents byte-identical to current list (dev assert); build clean; no new UI.

### E2 — Edit-mode shell: pencil toggle, owner gate, hover/selection highlight
Files: index.html (#room-edit-btn beside #solarmap-toggle-btn line 18), main.ts (canEditRoom(); pencil visible once hasEntered && isPlayerActive(); route edit clicks BEFORE keypad intercept ~1243 and #29's door-body intercept ~1261), new src/editMode.ts (RoomEditController: enter/exit, raycast movable furnitureGroups, emissive hover tint, ESC exits), world.ts (setEditMode(on): platformGrid.visible — grid helper exists unused at 242–246; expose furnitureGroups).
Force-exit edit mode when zoom leaves ≤2 or solar map opens.
Acceptance: pencil only when canEditRoom(); grid + hover highlight; floor clicks don't navigate while editing; keypad/door clicks inert while editing; WASD still works; non-owner path tested by setting roomInfo.owner via console.

### E3 — Move furniture: click-carry-place + validity + rebake
Files: editMode.ts (core), world.ts, player.ts, furniture.ts, pathfinding.ts.
Click movable item → carry (group follows click-plane raycast, snapped; original obstacle stays in OBSTACLES until commit — no transient walk-through hole); green/red validity tint; click commits (update item.pos/rot → rebuildObstacles → rebakeWalkableGrid → rebuildSeats); ESC/right-click cancels. R rotates while carrying (cut to follow-up if slice grows).
Validity (pure function, reused by E4 remote-apply): footprint within [−5,5]²; no AABB overlap with other footprints; no overlap with local/remote player positions inflated by PLAYER_R=0.38; connectivity: scratch-grid rebake + flood-fill from player's cell — reject if any currently-reachable seat front or enabled door front (DOORS from #29's doors.ts) becomes unreachable.
Player interactions: commit clears/replans active waypointPath (add Player.onObstaclesChanged() — replan WAYPOINT dest, cancel door/seat approaches whose target moved); picking up the item the local player sits on triggers stand-up first (public evictFromSeat() wrapping _beginStandUp, player.ts:416–420).
Acceptance: move armchair across room → A* routes around, sitting works there; red tint + rejected drop on item/player/out-of-bounds/sealing the fireplace pit; ESC restores; reload resets layout (documented — sync is E4).

### E4 — Sync via Yjs `furniture` map (+ persistence honesty)
Files: main.ts (bind next to roomInfo binding 283–310, observer pattern like chat 313–338), editMode.ts, world.ts.
Doc shape: Yjs map `furniture`: itemId → {x, z, rot, updatedAt} — SPARSE overrides over registry defaults (empty map = default room; avoids first-writer init races). Transacted on commit; rides ysync channel.
Observer: ignore unknown ids (version skew); skip item local user is carrying (LWW resolves on drop); else set group position + same rebuild pipeline + Player.onObstaclesChanged(). Seated-on-moved: if local sitTarget seat belongs to moved item, evict (stand-up to OLD front point, fallback nearest walkable).
Persistence honesty: node room docs are memory-only — layout survives reloads only while a node holds the doc; node restart resets. Cheap mitigation in-slice: IndexeddbPersistence(roomId, yjsSync.doc) from the already-declared y-indexeddb dep, so clients re-seed after restarts. Durable persistence = RoomLog/Phase-2; say so in PR, don't promise.
Acceptance: A moves sofa → appears in B <1 s, B's pathfinding respects it; B seated on it stands cleanly; conflicting moves converge; full restart → layout restored from IndexedDB re-seed.

### E5 — Rugs (and future decals)
The two 3-layer rug stacks (world.ts:437–442) become kind:'rug' items, footprint:null. Skip obstacle/grid/seat rebuilds + connectivity (bounds-clamp only); droppable under furniture; raycast prefers non-rug items; per-item y-epsilon avoids z-fighting (today's layers stagger 0.009/0.011/0.013). Sync rides E4 unchanged.

### E-door — deferral (explicit)
"Move/add/remove doors" collides with the fixed 4-port docking architecture on every layer (docking.ts per-door pairing state; #29's doors.ts hardcoded front/through; solid capsule walls world.ts:358–395; pairing protocol keyed by 'north'|'south'|'east'|'west'). Door editing is station-topology editing → belongs with the station-building phase. Cheap honest step now (E1/E3): derive DoorTarget.enabled from an obstacle-overlap test against the door's front cell instead of hardcoded enabled:false for north; E3's connectivity check already prevents furniture blocking enabled doors.

### Horizon notes
- Spaceship components: registry is the reuse point — new FurnitureDefs with function metadata (engine/pilotSeat/…), placed in a ship-shaped room whose bounds come from a hull definition; pilot's chair = Seat template whose sit action hands input to a flight controller. E1–E5 must not hardcode "lobby" beyond the default FURNITURE array.
- Station building / module movement: editing the GRAPH of rooms + docking connectedRoomAddress values + a zoom-4 arrangement editor; inherits S2 identity and Phase-2 persistence. Plan after door pairing survives real multi-node use.

## 4. Edge cases (design answers)
1. Drop onto local/remote player: rejected by inflated-AABB check (PLAYER_R 0.38). npc.ts needs nothing (dead code).
2. Seat furniture being sat on: SEATS derived per item → moving a sofa moves its seats automatically after E1. Local editor seated → auto stand-up before carry; remote seated (E4) → evict to pre-move front point. Mid-approach toward a moved seat → cancel via onObstaclesChanged() (sit machine player.ts:339–453 + #29's door phases need the same cancellation).
3. Pathfinding islands: flood-fill gate (reachability of currently-reachable seat fronts + enabled door fronts from player's cell). Remote moves pre-validated by same pure fn; invalid inbound state applied anyway (CRDT convergence wins) but logged.
4. North fireplace: movable:false; north door disabled (better: derived from overlap per E-door note); connectivity gate uses only enabled doors.
5. Mid-carry disruptions: zoom ≥3, map open, morph restart force-cancel carry (restore origin); original obstacle never left OBSTACLES → no transient hole.
6. Parity oddities preserved in E1 (documented, not fixed): lamp-table mismatch, stool strip in bar box, collision-free cherry trees — via footprintOverride/footprint:null.
7. Rug layering per E5; rug clicks yield to furniture.
8. Unknown ids in furniture map (version skew): ignored gracefully.

## 5. PR-collision statement
Implement E2–E5 only after #26/#27/#29 merge (E2 edits onCanvasClick which #29 rewrites; E3/E4 hook player.ts which #29 grows ~400 lines; E3/E4 must read remote positions through a World accessor because #27 replaces the sphere system). **E1 is safe immediately** — world.ts 401–708 untouched by all three PRs; only trivial import-line conflicts possible.

**First PR: E1.**
