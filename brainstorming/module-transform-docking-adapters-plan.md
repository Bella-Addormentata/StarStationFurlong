# Implementation Plan — Issue #30 "Module transformation and docking adapters"

Target: `prototypes/0.22.0-core-loop-demo`. All anchors verified at source on `main` and the open PR branches (#26 fix/22, #29 feat/23, #31 feat/20, #32 feat/25-E1).

## 0. Verified ground truth

- **PR #29 door machine**: `DoorPhase = 'NONE'|'APPROACH'|'FINE'|'WAIT_OPEN'|'THROUGH'|'PEEK'|'RETURN'` (player.ts:76), driven by `_updateDoorPhase` (~657). The `THROUGH` case (~724) reaches `door.through`, fires `hooks.onThrough()`, then always enters PEEK→RETURN. `World.requestDoorWalkthrough` prints "Docked room detected at X — transit coming soon." when paired. That is the exact seam adapter transit replaces. doors.ts DOORS: north `enabled:false` (fireplace), south/west/east enabled, each with front/through (±4.5/±7.0) + faceAngle.
- **Docking state is per-tab memory; pairing is local-only.** `DockingState` (docking.ts:23-30) carries `connectedRoomAddress` (a `?seed=` URL). `completePairing` mutates only the local doorState Map + draws the gray-box projection. `receiveInboundPairingRequest` exists but nothing calls it over the network — **pairing does NOT pair the other side's door**; reciprocity must be built (T3).
- **Room rejoin without reload exists**: "Use link" (main.ts:904-923) does `networkProvider.disconnect()` → `bootstrapNetworking()` with `pendingBootstrapOverride`. But not re-entrant-clean: `bootstrapNetworking` re-runs `setupSpacePhoneOverlay()` (duplicate Tab listener) and never `stop()`s the old YjsSync (leaked doc; stop() exists at YjsSync.ts:86-94). `NetworkProvider.connect` no-ops if already active — disconnect-first is mandatory.
- **The node hosts multiple rooms concurrently** — `HubState.rooms: Mutex<HashMap<String, Room>>` (ssf-p2p-node/src/main.rs:66), created on demand (`Doc::new()`, main.rs:583-590). **Each WT connection's `chosen_room` binds exactly once** (main.rs:579-592) — switching rooms on one connection is impossible; a fresh WT session per room is the v1 mechanism. The node is the yrs sync authority per room, so **room A's doc (chat/roomInfo) survives your departure while the node runs**.
- **Node never cleans up dead connections** — no `local_connections.remove` anywhere; stale entries leak per departed tab.
- **PR #26 tick identity**: lane id = blake3(node_id ‖ remote_addr) per WT connection → new session ⇒ new lane id. Client adds a 10 s ghost reaper + `clearRemotePlayers()` on re-bootstrap.
- **Cross-node join dials the LOCAL node**: `resolveBridgeBootstrap` (main.ts:687-712) keeps local wtUrl and merges the imported seed's roomId/roomKey/memberHints; the node bridges outward via iroh, reporting `bridge` status envelopes (dialing/connected/failed) already surfaced at main.ts:263-279.
- **Roof reality**: `capsuleRoof` visibility is overwritten every frame at interior zoom (world.ts:1041-1047), and the roof doesn't cover the vestibule gap — the issue's "roof fade" needs rework (see T1 choreography decision). The `#welcome` overlay fade (main.ts:1217-1220) is the full-screen-fade precedent.
- **#25 plan horizon notes**: ship = room whose registry furniture carries function metadata; station building = editing the graph of rooms + connectedRoomAddress. PR #32's `FurnitureDef` is the substrate. phone-apps-breakdown S8 already specifies "tap a room name → swap bootstrap → rejoin" — the adapter is the diegetic body for the same plumbing.

## 1. Architecture principle: module = room = ship

1. **Module id = roomId.** A module IS a Yjs doc keyed by roomId, addressed by a bootstrap seed. "Buying a new module" = minting a fresh roomId + roomKey against your own node. There is never a Ship class or Station class distinct from a room.
2. **Module capabilities = function-tagged furniture.** Extend `FurnitureDef` with `functions?: ModuleFunction[]` (`'engine' | 'pilotSeat' | 'dockingAdapter' | 'attitudeControl' | …`). A module containing `engine` + `pilotSeat` furniture is drivable; the pilot seat is an ordinary SeatTemplate whose sit action hands input to a flight controller. Equipping a module IS E3 furniture placement, synced by E4 — the only transformation mechanism.
3. **Station-shared systems = a station doc, not gossip.** A dedicated doc with roomId `station:<uuid>`, referenced from each member module's roomInfo. The node already keys arbitrary rooms by string, so a station doc costs zero node work; the alternative (mirroring shared state into N module docs) is an N-way merge with no authority. Client cost: a second WT session (one connection = one room) — cheap against the local node. Holds the station graph (module list, door pairings, adapter angles) and shared systems (altitude/orientation budgets aggregated from members' function-tagged furniture). Deferred: the T-slices need only a per-module `doorPairings` map — the degenerate two-module station graph — which migrates into the station doc later.
4. **Flying = mutating a module's pose in a shared frame.** A `pose` entry — in the station doc while docked, in the module's own doc while free-flying — rendered at zoom levels 3/4 and on the solar map. The space-sim is out of scope for every slice here; this names its home.

Consequence: **adapter transit must not special-case "ship" vs "room" anywhere.** It moves a player between two roomIds; whether either module can fly is invisible to it.

## 2. Adapter transit slices

Dependency edges: PR-A → (nothing); T0 → #26, #31 merged; T1 → T0, #29, PR-A (+#27 recommended); T2 → T1; T3 → T2; T4+ deferred.

### PR-A — Vestibule module + this design doc (conflict-free, buildable NOW)
- New `src/adapter.ts`: procedural train-gangway vestibule — concertina ring segments, floor plate, handrails, two portal frames — same canvas-texture/material idioms as world.ts. Export `buildVestibule(doorId: DoorId): THREE.Group` positioned in the 6→12 gap outside the given wall (the space the gray-box projection uses), plus `setVestibuleLightState('idle'|'cycling'|'fault')` for the airlock read.
- Optional 2-line dev hook: `?vestibule=east` renders it for visual iteration.
- Acceptance: builds clean; no gameplay change; vestibule visible under the dev flag at zoom ≤2 and hidden ≥3 (reuse world.ts:986-995 pattern).

### T0 — Room-session lifecycle refactor (main.ts)
Extract from `bootstrapNetworking` (main.ts:215-375): `joinRoom(boot): Promise<RoomSession>` (connect, ysync channel, YjsSync, roomInfo + chat observers, onTick/onEnvelope, clear reaper state + remote players) and `leaveRoom()` (`await yjsSync?.stop()` — fixes today's leak — then `networkProvider.disconnect()`). One-time UI init moves out of the join path (fixes the duplicated Tab listener). Re-route "Use link" and retry through leave/join.
Acceptance: join a seed twice — Tab still single-fires; no orphaned Y.Doc; remote players cleared; chat rebinds; behavior otherwise identical. **Sequenced after #26 and #31 merge** (both rewrite these regions).

### T1 — Adapter interior + choreography; same-node two-room transit
- **Player** (extends #29's machine): new phases `ADAPTER_OUT` (scripted walk from `through` to vestibule midpoint), `ADAPTER_HOLD` (idle while the swap runs; timer-capped), `ARRIVE` (spawn at arrival door's `through` in room B, door opens, walk to `front`, door closes, MANUAL). Branch point in the THROUGH case (~player.ts:724): new hook `hooks.beginTransit?: () => boolean` — true when a pairing exists, else fall through to PEEK exactly as today. New public `enterFromDoor(door, hooks)` for the arrival leg. WASD during ADAPTER_* swallowed.
- **Choreography decision**: the issue's roof-fade is **rejected for v1** — (a) roof visibility is overwritten every frame by zoom logic; (b) the roof doesn't cover the vestibule gap; (c) v1 rooms are identical lobbies, so there's little to hide. Replaced by a ~400 ms full-screen DOM fade at the swap midpoint (pattern: #welcome overlay). The vestibule provides the diegetic in-between; a roof/gangway polish slice can revisit.
- **The swap** (`transitTo(seed, departureDoor)` on T0): decode seed → resolveBridgeBootstrap → fade in → leaveRoom() → joinRoom(target) → reposition player at arrival door → fade out → enterFromDoor. Same-node: same wtUrl, different roomId; node registers room B on first envelope. Ticks route only after the first envelope binds chosen_room — joinRoom must await yjsSync.start() before declaring arrival.
- **Arrival door convention**: pairing records `targetDoorId`; default = opposite cardinal; target must be `enabled` (north is disabled — reject at pairing time with a hint; promote east↔west as the canonical pair for identical-lobby v1).
- **World state (v1)**: every room renders the same lobby — only network/doc state, remote players, and player position change. E4's furniture observer later applies room B's real layout on the same seam.
- **"Buy a module" v0**: "PROVISION NEW MODULE" button in the docking pane — mints a fresh seed against your own node (`mintBootstrapLink` variant with a `module-<rand>` roomId) and fills the address input. Issue #30's "buy a new module and dock it," without an economy.
- **Node fix (in-slice)**: remove the connection from `room.local_connections` when `handle_wt_connection` exits — prevents stale-entry buildup across transits.
- Acceptance: pair A.east to a provisioned module; click east door → approach → open → through → vestibule → ≤1 s fade → emerge from B's west door facing inward; HUD room name = B; chat = B's doc; transit back restores A including chat history; a second player in A sees your avatar freeze then despawn ≤10 s; no duplicate Tab listeners after 5 round trips.

### T2 — Cross-node transit via the pairing seed
- Same transitTo path; the seed's memberHints make it cross-node automatically (node dials outward via iroh).
- **Honest success signal**: SyncStep2 is meaningless cross-node (the local node instantly creates an EMPTY room-B replica). Declare arrival only on: bridge `connected` envelope OR remote content arriving on the new doc. Timeout 6 s.
- **Failure path**: still in vestibule (ADAPTER_HOLD, light `'fault'`) → fade → rejoin room A (local, fast) → scripted return into A → hint "Dock seal failed — remote module unreachable." Known cosmetic cost: a phantom empty room B exists on the local node — documented, harmless.
- Acceptance: two LAN nodes; pair A.east↔B.west; transit both directions; kill node B → attempt holds ≤6 s, walks back, room A intact. The vestibule hold diegetically absorbs 1–10 s hole-punch time — the "data loading point" is real, not theater.

### T3 — Return trip, spawn correctness, pairing symmetry
- **`doorPairings` Yjs map** per module doc: `doorId → {seedB64, targetRoomId, targetDoorId, pairedAt}`. Docking system hydrates from/writes to it — all room members see pairings; they survive tab reloads while the node runs.
- **Reciprocity**: on first successful arrival in B, if B's doc lacks the reciprocal entry, write `{arrivalDoor → seed(A), targetDoorId: departureDoor}` — making pairing two-sided for the first time.
- **Spawn correctness**: arrive at targetDoor.through → walk to front, facing faceAngle+π snapped 8-way.
- Acceptance: A→B→A lands at correct doors facing inward; a second player in B sees the LED go green via the doc observer; B reloaded mid-session still shows the pairing.

### T4+ — Deferred
- **Variable-angle adapters / circular stations**: meaningless until >1 real module renders in a shared frame (today: one platformGroup + gray boxes). Needs the station doc graph + a zoom-3/4 multi-module renderer. After T3 + station doc.
- **Module transformation / equipment**: `FurnitureDef.functions` tags need E2/E3 (place equipment) + E4 (sync). Flight controller comes after the station doc defines the pose frame.
- **Station-shared systems doc**: after T3 migrates doorPairings into it.

### Station flight-control authority (owner ruling, 2026-07-13 — design for the station-doc slice)
When multiple connected modules are flight-capable, **exactly one holds station flight control** at a time:

- **Default: the oldest module connected to the station.** The station doc's member map records `connectedAt` per module; the controller field defaults to the member with the smallest `connectedAt` (deterministic across replicas; ties broken by module id).
- **Handover is explicit and tree-shaped.** The controlling module can hand flight control to any *connected* module (adjacent in the docking graph or reachable through it). Handovers form a delegation tree rooted at the current controller: `station.controlTree = { controllerId, delegations: parentId → childId[] }`. Only the current controller (or a delegator above the target in the tree) can re-assign control below itself.
- **Break-off.** Any module (with its subtree of docked modules) can *break off*: it undocks as an independent flight group, becoming a new station doc whose controller defaults to the oldest module **within the departing subtree**. The remaining station keeps its controller; if the controller itself departs, control reverts to the oldest remaining member (the default rule re-applies — no orphaned control).
- **Enforcement posture:** same as room ownership (S2 precedent) — v1 is honest-client UI gating on the station doc's controller field; signed-op enforcement arrives with RoomLog (Phase 2). Pilot-seat input is simply ignored unless your module holds control.
- **Where it lives:** the station doc (§1.3). Not implementable before the station-doc slice — recorded here so the T4 design starts from these rules.

## 3. Risks and unknowns — honest answers
1. **Tick identity across switch**: new connection ⇒ new lane id; in room A your ghost lingers ≤10 s (reaper). **A→B→A round trips under 10 s produce a brief self-doppelganger.** Accepted for v1; real fix = node-side leave signal on disconnect (pairs with the local_connections cleanup).
2. **Doc/chat lifecycle**: client Y.Doc replaced wholesale per join; T0 adds the missing stop(). Node docs are memory-only — room state survives transits but not node restarts. E4's per-room IndexeddbPersistence composes cleanly.
3. **What room A sees when you leave**: freeze then despawn ≤10 s. No leave message exists ('awareness' declared, unimplemented). Defer proper join/leave to phone-plan S2/S3 — don't invent a bespoke leave lane here.
4. **Loading budget**: walk-in ~1 s + fade 0.4 s + swap + fade 0.4 s + walk-out ~1 s ≈ 2.5–4 s of cover. Same-node swap ~100–300 ms; cross-node 1–10 s absorbed by ADAPTER_HOLD up to the 6 s timeout.
5. **bootstrapNetworking re-entrancy** (duplicate listeners, leaked YjsSync) — why T0 exists and precedes T1.
6. **Cross-node success ambiguity** (empty local replica ≠ reached neighbor) — gate on bridge status/remote content, not sync completion.
7. **North door asymmetry**: opposite-cardinal defaulting breaks south↔north (north disabled) — handled by targetDoorId + enabled-validation.
8. **Stale node connections**: today a slow leak; grows per transit — fixed in T1's node change.

## 4. PR-collision statement
- **Must merge first**: #29 (the DoorPhase/hooks surface T1 extends) and #26 (addressed ticks + reaper + clearRemotePlayers; rewrites the onTick region T0 refactors). #31 precedes T0 (rewrites setupSpacePhoneOverlay — exactly T0's territory). #27 recommended before T1 wiring.
- **#32/E1**: no overlap with T-slices. E2/E3 will be concurrent with T1's player.ts phases — coordinate: E3's onObstaclesChanged cancellation must also cancel ADAPTER_* phases (one line, flag in whichever lands second). E4's observer plugs into T0's per-join rebinding with zero transit changes.
- **Conflict-free today**: PR-A (new adapter.ts + this doc + dev hook).

## 5. First PR
**PR-A**: this doc + `src/adapter.ts` vestibule behind a `?vestibule=` dev flag. T0 the moment #26+#31 merge, then T1.
