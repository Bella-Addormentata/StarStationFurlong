# Combined Implementation Plan — Issues #33 "Re-think maps" + #35 "Storage Trunk"

Target: `prototypes/0.22.0-core-loop-demo` (live line). Anchors verified on `main` and the open PR branches (#26 fix/22, #27 feat/21, #29 feat/23, #31 feat/20, #32 feat/25-E1, #34 feat/30-PR-A).

## 0. Verified ground truth

- **Zoom today** (zoom.ts): 8 levels (zoom.ts:31–96). Level 1 first-person swaps `window.gameRenderer.camera` to a lazily-created PerspectiveCamera(65°) (:366–381), re-positions from the player every frame (:432, 621–624), free mouse-look via module-global yaw/pitch (:98–101, 237–253), **pointer lock on any mousedown** (:256–260). The 2→1 transition starts the perspective camera at `playerPos + (22,26,22)` — the exact iso offset (:318–325; renderer.ts:67) — then flies a Bezier to the eye (:400–416) while fading the avatar (:418–430). Exit restores ortho + opacity (:443–466). Levels 3–8 are a full-screen 2D canvas overlay of hardcoded fiction (`sectorBodies` :142–149; drawings :738–868) intercepting pointer events at ≥3 (:521–544). world.ts keys interior visibility off `getLevel()` (world.ts:983–1048). input.ts rebinds WASD camera-relative at level 1 (input.ts:39–63).
- **Ruling impact**: levels 3–8 + the 'm' solar overlay (map.ts full-screen mount :139–258, toggle main.ts:1108–1158) are the non-diegetic views #33 deprecates. Level 2 isometric and level 1 free-roam first-person survive. Level 1's camera-swap idiom is reusable; its controller is not (see D0.1).
- **Walk-then-act**: seats (SitPhase player.ts:60, handlers :339–452, WASD override :184–196, pending-resume :441–450); PR #29 doors (DoorPhase :76, navigateToDoor+hooks :245–298, doorSeq token :121, DoorSequenceHooks doors.ts:47–61, World.requestDoorWalkthrough wiring). Mirror this decoupling.
- **Registry (PR #32)**: FurnitureItem/FurnitureDef/SeatTemplate/BuildCtx (furniture.ts ~33–100), derivations itemAabb/buildObstacleList/buildSeatList + computeFront, buildItemGroup (opacity-0 fade materials + userData.targetIntensity lights). #30 plan §1.2 rules capabilities = function-tagged furniture — devices slot in.
- **Edit-room plan**: E2 specced a HUD pencil beside #solarmap-toggle-btn — NOT built yet, so the M2 amendment is paper-only.
- **Screen precedent**: CanvasTextures exist but are generate-once (wood/brick/star windows, world.ts:158–215/274–320/736–760). No live in-world screen. Docking pane = centered DOM overlay w/ stopPropagation (docking.ts:133–196, 209), opened from raycast intercept (main.ts:1243–1262).
- **Wardrobe reality**: no wardrobe; PAL module const (voxelCharacter.ts:52–73) baked into materials; #27 proves safe whole-rig recolor (dedupe Set, skip exported OUTLINE_MAT, absolute setHex not cumulative offsets). Outfit SYNC gates on phone-plan S2 identity.
- **Inventory reality**: no item model anywhere. Doc maps in use: roomInfo, chat; E4 plans sparse `furniture`. Node docs memory-only; y-indexeddb declared but unused (package.json:22).

## 1. D0 — Device-focus foundation

One mechanic for trunk, wall computer, desk computer, map table: click device → walk to front → camera eases to first-person framing on the device → UI active → exit returns to isometric.

### D0.1 Camera: dedicated focus camera (NOT zoom level 1)
Level 1 is a free-look follow camera (per-frame player-derived position, mouselook, pointer lock) — a device screen needs a fixed pose + free cursor. input.ts also rebinds WASD at level 1 (want: WASD = exit), and world.ts keys visibility off the level (must stay 2). Touching zoom.ts collides with #31.
Reuse only: the camera-swap idiom (`window.gameRenderer.camera = cam`, restore ortho on exit) and the iso-offset continuity trick (start perspective at `front + (22,26,22)`, ease to eye). New `src/deviceFocus.ts` owns its own PerspectiveCamera (FOV ~50), never pointer-locks, hides the local player mesh during FOCUSED (pattern zoom.ts:387–391/452–466). ~450 ms smoothstep ease each way. `deviceSeq` re-entrancy token (mirror doorSeq).

### D0.2 State machine
**Player side** (additive, mirrors doors): `DevicePhase = 'NONE'|'APPROACH'|'FINE'|'TURN'|'ENGAGED'`; `navigateToDevice(device, hooks)`, `releaseDevice()`. APPROACH = A* to device.front (empty path falls through); FINE = generalized _updateFineApproach; TURN = snap to device.faceAngle (**toward** the device — opposite of seats' back-to-chair convention; document); ENGAGED = idle, fire hooks.onArrived() once, swallow movement; WASD/clicks while ENGAGED → hooks.requestRelease(). Pending-resume symmetric with seats/doors both directions.

**Hooks** (new `src/devices.ts`):
```ts
export interface DeviceFocusHooks { onArrived(): void; requestRelease(): void; }
export interface DeviceTarget {
  id: string; kind: 'roomTerminal'|'deskComputer'|'mapTable'|'storageTrunk';
  front: { x: number; z: number }; faceAngle: number;   // toward device
  eye: THREE.Vector3; anchor: THREE.Vector3;            // focus cam pose
}
```
**Controller** (`src/deviceFocus.ts`): IDLE → WALKING → FOCUSING → FOCUSED → RELEASING → IDLE. On onArrived: swap camera, ease to eye/anchor, mount `DeviceUI { mount(host), unmount(), update(dt) }`. Exit: unmount, ease back, restore ortho, `player.releaseDevice()`. Module singleton with `isActive()`.

**Registry derivation**: FurnitureDef gains `functions?: string[]` and `device?: DeviceTemplate` (local front/faceAngle/eye/anchor); `buildDeviceList(items, isWalkable)` mirrors buildSeatList (same rotXZ + computeFront). Device meshes tagged `userData.isDevice/deviceId`.

**Click routing** (main.ts onCanvasClick + #29's rewrite): priority keypad → door body → **device** (new) → floor. On hit: `world.requestDeviceFocus(deviceId)` (mirrors requestDoorWalkthrough). v1: device clicks routed at zoom level 2 only (level-1 perspective raycast deferred; one guard line).

### D0.3 Input capture while FOCUSED
- Pointer: device UI host stops propagation; clicks reaching the canvas = release.
- WASD: swallowed; first press → requestRelease(); movement resumes after RELEASING.
- Esc precedence: (1) input inside device UI focused → blur only; (2) phone open → #31 owns it; (3) else release. Guard on e.target (per #31's lesson).
- +/-/m: suppressed while focused — one guard in zoom.ts keydown (stacked under #31's phone guard) + one in setupSolarMap's m handler (until M-dep removes it).
- Tab/phone: stays live (higher z-index personal overlay; no conflict).
- Edit mode (M2): the on-screen pencil RELEASES focus first, then activates RoomEditController (edit is an isometric activity). Release-with-continuation, not nesting.
- Door/adapter phases: whichever of D0/T1 lands second adds the other's phases to WASD-swallow/cancellation lists (one line each — same coordination #30 plan flags for E3).
- Morph restart / room swap (T1 transitTo): force-release instantly (mirror #25 plan §4.5).

### D0.4 Screens: hybrid (recommended)
Monitor mesh carries a small CanvasTexture (~256×192, NearestFilter) redrawn ~1 Hz with idle status (room name, peer dot, node LED). On focus, DOM overlay mounts the full UI (docking-pane precedent); texture dims to "TERMINAL IN USE". All-canvas interactive UI = raycast/UV hit-testing + hand-rolled widgets + canvas text input — a project with no precedent; all-DOM leaves the prop dark in isometric, failing #33's premise. Hybrid also gives remote players a live screen later.

## 2. #33 slices

### M1 — Wall computer: prop + focus + status screen v1
- Registry item `wall-computer`: footprint null (wall-mounted, never an obstacle), functions ['roomTerminal'], device template. Placement per issue: near a door — south wall beside the south door (~(1.8, 5.97) facing −z; flush-mount idiom like the bar back-panel world.ts:661; south door front (0,4.5)). Dark slate body + bezel + screen plane w/ idle CanvasTexture; amber accents (0xD4A84B — adapter/keypad palette).
- Focus UI v1 (DOM), honest data only: room name (roomInfo binding pattern main.ts:291–310), peer count (seenPeers.size — main.ts:1334's source), node/P2P status (main.ts:1082–1096 values), **wireframe room view** — 2D canvas: room bounds, four door ports w/ pairing LED colors (dockingSystem.doorState), every FURNITURE item's itemAabb as top-down wireframe (derived live → E3/E4 moves show up free). Fuel gauge rendered but labeled `FUEL — NO SENSOR FITTED` (no fuel system exists; zoom.ts fuelCostMultiplier is display fiction). Multi-module wireframe needs T3's doorPairings — v1 shows this module + port pairing status, `NO ADJACENT MODULE DATA` when unpaired.
- Acceptance: click monitor → walk → face → ease in → live UI → Esc/WASD/click-away ease out; seated player stands first; mid-walkthrough defers; phone toggles fine; world.ts observes no zoom change.

### M2 — Edit-room entry moves to the wall computer (E2 amendment)
- REPLACED: E2's HUD `#room-edit-btn` — never ships. Entry = `EDIT ROOM` button in the wall computer's focused UI, gated by canEditRoom(), shown disabled w/ owner name otherwise.
- SURVIVES: RoomEditController internals, owner gate, highlight, grid, ESC exits, force-exit rules, E3/E4/E5. E2's click-routing precedence gains "…before keypad → door → device".
- NEW: on-screen pencil releases focus, then enters edit mode; exiting edit returns to plain isometric.
- Sequencing: E2 unbuilt → doc amendment + build E2 after M1.

### M3 — Desk computer
- Registry item `desk-computer` (footprint 2×1 real obstacle) + monitor + keyboard; functions ['deskTerminal']. v1 stand-to-focus (sit-at-desk = seat+device composition, deferred).
- Adds over M1: room-management WRITES — room rename (move inline-edit flow from network panel main.ts:739–791; same owner gate), invite mint/copy (mintBootstrapLink main.ts:572–616), peer list (ids now, S2 names later), M1 status page. Network diagnostics drawer stays in the HUD (operator tooling, not diegetic).

### M4 — Map table / holograph table
- Registry item `map-table` (2×2), functions ['mapTable']; holographic disc (emissive plane + slow-spin ring). Place one in the demo lobby so the feature is reachable.
- Focus UI = migrated map.ts: SolarSystemMap.mount(parentEl) already takes a parent — re-parameterize the 100vw/100vh container CSS (map.ts:143–157) and canvas sizing (:168–171, 312–317) to fill the focus host. Pan/zoom/select/travel (:260–459) are container-local — untouched. Gate tick() to mounted (currently unconditional at main.ts:1309–1311).
- Zoom 6–8 universe/galaxy fiction does NOT migrate; larger scales become future map-table pages when real data exists.

### M-dep — Deprecating zoom 3–8 and the 'm' overlay
Recommendation: **clamp behind a dev flag for one release line, then delete the overlay renderer; keep the world-side exterior shell.**
- zoomOut() clamps at 2 unless `?devzoom=1` (pattern: #34's ?vestibule=). Levels 1↔2 keep working (both ruling-compliant), incl. the blink.
- 'm' handler + #solarmap-toggle-btn + map zoom buttons removed WHEN M4 LANDS, not before — never delete the only path to a feature before its replacement ships.
- world.ts:983–1048 (capsule show-hide) stays — seed of the future exterior renderer (#30 T4 multi-module frame). map.ts stays (M4 consumes it). input.ts level-1 branch stays.
- On losing the zoom-out reveal: levels 3–8 deliver static canvas fiction, not the station you built. The reveal beat survives as the entry morph, and the map table can later animate a diegetic zoom-out inside its hologram — exactly the representation the ruling permits. Dev flag keeps the old overlay demoable during transition; deletion is a follow-up.

## 3. #35 slices

### TR1 — Trunk prop + open animation (conflict-free NOW)
- Registry-shaped item `storage-trunk` (1×1, movable, functions ['storageTrunk']). Concept-art-faithful: light-gray ribbed body, orange corner latches + lid trim, `ISS-ST04` stencil via one-shot CanvasTexture (star-window texture world.ts:736–760 as text-decal template). Lid = sub-Group hinged at back edge; `openLid(onOpen)/closeLid()` animated from the world update() loop with completion callback (copy #29's update-driven door slides, NOT the old rAF loop).
- Ship behind `?deviceprops=1` preview (PR-A pattern). Default spot: berth corner free of obstacles, e.g. (−2.5, −5.0) against the fireplace wall's flank — dev-assert against OBSTACLES at build.

### TR2 — First-person trunk view via D0 + item grid v1 (local)
- Trunk as DeviceTarget: front one tile before the latch face; eye ≈ (front, y 1.35); anchor = trunk interior (y ≈ 0.3) — ~50° downward gaze. Choreography: onArrived → openLid → ease → UI; release reverses (unmount → ease → closeLid).
- Item model v1 (`src/items.ts`, none exists today):
  ```ts
  interface ItemDef { id: string; name: string; icon: string; kind: 'tool'|'outfit'; outfit?: OutfitDef }
  interface TrunkState { slots: (string | null)[] }   // 8 tool + 4 outfit slots
  ```
  Static ITEM_DEFS catalogue; trunk state in localStorage `ssf-trunk:<roomId>:<itemId>`, seeded with starter contents. UI: DOM overlay styled as the concept art's two trays (tools top, wardrobe beneath; tabs) over the visible opened 3D trunk. Click → inspect card; no cross-trunk transfer, no world drops. Labeled `LOCAL STOWAGE — not yet synced`.

### TR3 — Outfit equip v1 (honest)
Local rig recolor + one accessory, persisted locally, NOT synced:
1. Palette-role tagging during _build*: `userData.paletteRole: 'fur'|'underside'|'socks'|'accent'`.
2. `setOutfit(outfit)/clearOutfit()`: `OutfitDef = { paletteOverrides: Partial<Record<PaletteRole, number>>, accessory?: AccessoryId }`. Dedupe materials via Set, skip OUTLINE_MAT (#27's exact pattern; needs #27's exported OUTLINE_MAT). Store originals on first apply; use absolute setHex (offsetHSL cumulativity is #27's documented trap).
3. One attachment slot v1: head group (voxelCharacter.ts:139/188) — attachAccessory(group): cap/visor/scarf mini-builders.
- Flow: wardrobe tab → click outfit → rig setOutfit → persist `ssf-outfit` localStorage → applied on spawn.
- Sync honesty: remote peers keep #27's hue tint until S2's players map carries an outfit id; then updateRemoteAvatars applies it to remote rigs. Do NOT build a bespoke appearance lane before S2.

### TR-sync — Yjs trunks map (after E4's pattern)
- Yjs map `trunks`: `furnitureItemId → { slots, updatedAt }` — whole-value LWW per trunk (per-slot CRDT overkill; concurrent edits converge last-writer; documented). Bound beside roomInfo; observer like chat; transacted writes; localStorage becomes offline fallback.
- Persistence caveats in the PR: node docs memory-only; E4's IndexeddbPersistence re-seeds after restarts (if E4 unlanded, carry the two-line hookup and credit it). Durable multi-node persistence = RoomLog/Phase-2 — don't promise it.

## 4. Dependency / collision map

| Work | Collides with | Verdict |
|---|---|---|
| PR-P (props + this doc) | #34's init hunk (trivial adjacency) | **Conflict-free NOW** |
| D0 | #29 (player.ts + onCanvasClick — hard dep), #31 (same zoom.ts listener), #32 (furniture.ts) | After #29 + #31 + #32 |
| M1 | #32 (extends furniture.ts), #26 (read-only peer data) | After D0 |
| M2 | E2 unbuilt (paper amendment) | After M1 |
| M3 | #26 (nearby main.ts), T0 (same file, different concerns) | After #26; coordinate w/ T0 |
| M4 + M-dep | #31 (index.html/zoom.ts) | After M1; independent of trunk lane |
| TR2 | — | After D0 |
| TR3 | #27 (same file + exports needed) | After #27 |
| TR-sync | E4 (observer seam + persistence), T0 (rebind in joinRoom) | After E4 |

D0 precedes E2 (amended entry point lives in M1's UI). D0 independent of T0/T1 — disjoint phase namespaces on #29's machine; whichever lands second adds the other's phases to swallow/cancel lists.

Order: open queue as sequenced (#26→#27→#29→#31→#32→#34), PR-P any time; then D0 → M1 → M2/E2 → TR2 → TR3 → M3 → M4+M-dep → E3/E4 → TR-sync; T0/T1 interleave freely after #26/#31.

## 5. First PR
**PR-P**: this doc + `src/deviceProps.ts` (TR1 trunk incl. lid animation + M1 wall-computer prop half incl. 1 Hz idle CanvasTexture) as FurnitureDef-shaped builders (BuildCtx signature from #32) but self-contained (imports THREE only, like #34's adapter.ts), behind a `?deviceprops=1` dev flag in main.ts init(). Acceptance: builds clean; zero change without the flag; with it, trunk + wall computer render at correct scale, lid opens via console handle, screen shows live room name/peer count at 1 Hz.
