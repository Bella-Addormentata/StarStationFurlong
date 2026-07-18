<!-- Produced 2026-07-18 by a 4-agent planning workflow (design distillation, live-line code survey, flight-model exploration, synthesis). Owner greenlit parts-first. -->

# Module → Spaceship Conversion — Sliced Plan (#30)

*Star Station Furlong — a module becomes a drivable spaceship by fitting fuel tanks, engines, and a helm. Design synthesis over three research passes, not code.*

Repo root for prototype paths: `prototypes/0.29.0-core-loop-demo/src/` (the RELEASE_FRONTEND live line, v0.31.x). Line numbers are carried from this session's in-source research passes against the current files; rulings quoted from `module-transform-docking-adapters-plan.md` target the 0.22.0-era tree — the architecture is current, the anchors are not, so **re-verify every plan-doc line number in source; live-line citations below are current**. This document synthesizes **(A)** the decision distillation from the brainstorming docs, **(B)** the code-seam survey of the live line, and **(C)** the flight-model exploration, and resolves their disagreements inline (§1.4).

> **Companions:** [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (module = room = Yjs doc; "capabilities = function-tagged furniture"; the 2026-07-13 flight-control-authority ruling) · [floorplan-grid-plan.md](floorplan-grid-plan.md) (#66 — hull shape = tile set; additive wire discipline this plan copies) · [greenhouse-farming-plan.md](greenhouse-farming-plan.md) (§6 F6 — ship provisioning, "sad meals, not danger") · shipped #67 (`doorsDoc.ts` transient berths, `doorPolicy.ts`) · shipped #68 (`ventures.ts` any-share-is-owner).

---

## 1. Executive summary

**What #30 asks:** modules transform into drivable spaceships when equipped — fuel tanks, engines, a cockpit — dock at stations, and travel away into deep space. **The owner greenlit starting with the parts.** Travel/undocking semantics are unsettled; this plan settles the v1 shape and sequences the rest.

**The approach in one paragraph:** nothing new becomes a "ship." A ship is the module's own room doc, and *ship-ness is a derived predicate*: the room is flight-capable when its furniture doc contains items whose `FurnitureDef.functions` tags cover `fuelTank` + `engine` + `helm` — equipping IS furniture placement, the mechanism the #30 plan pre-built (`furniture.ts:112-113`, already carried by the shipped `roomTerminal` tag at `furniture.ts:1017`). The hull dress (engine bells, saddle tanks) is *derived* from those same furniture records inside the zoom-3 exterior builder — the solar-panel precedent (`exteriorView.ts:102-128`) with the furniture doc as source instead of a new exterior kind. The helm is one more focusable device (`devices.ts` pattern) whose v1 face is a **pre-flight checklist, not a cockpit**: FITTINGS / FUEL / BERTHS — replacing the shipped "FUEL — NO SENSOR" honesty stubs (`furniture.ts:467-469`, `devices.ts:465-466`) the moment a real tank is fitted. Flight, when it comes (SH3), is **a record, not a simulation**: one `flight` entry in the ship's own doc, `docked → in-transit → arrived`, progress interpolated from timestamps — because the ship IS the room doc, everyone aboard travels together with zero networking work and zero contact with the fragile join/leave transit seam. Live pose piloting, multi-module flight groups, and the control tree are all explicitly sequenced after the station doc, per the plan's own rulings. Five slices, one point release each, frontend-only until SH5.

### 1.1 Ground truth (verified on the live line)

1. **The transformation mechanism already exists.** `FurnitureDef.functions` (`furniture.ts:112-113`) is commented against #30 §1.2; new `FurnitureKind`s become syncable automatically because `isFurnitureRecord` validates via `hasOwnProperty(FURNITURE_DEFS, r.kind)` (`furnitureDoc.ts:78-89`). Registry entry + builder = placed, synced, spawnable part.
2. **Every UI/render seam the parts need is shipped:** device-focus (`devices.ts:106-124`, `world.ts:1869-1935`, free click routing via `furniture.ts:1404-1411` → `main.ts:3981-3990`); live canvas screens (`buildWallComputer`, `furniture.ts:405-506`); exterior hull dress rebuilt-on-change (`exteriorView.ts:64-218`, `refreshExteriorView` at `390-401`, subscription at `main.ts:742`); parts dev-grant economy (`stationParts.ts`, `devMenu.ts:634-636`).
3. **Undock semantics are half-shipped:** #67 D2 transient berths already let *either side* cast off with no ceremony (`doorsDoc.ts:43-46`, `docking.ts:717-718`), and re-docking is the shipped berthing flow — the hardest-looking step of a round trip costs zero code.
4. **The plan-doc rulings that bind us:** module = room = doc, never a Ship class (§1.1); "adapter transit must not special-case 'ship' vs 'room' anywhere" (§1); flight-control authority is "not implementable before the station-doc slice" (2026-07-13 ruling); "Flying = mutating a module's pose in a shared frame… out of scope for every slice here" (§1.4).
5. **What does not exist:** the station doc, any pose frame, any multi-module shared-frame renderer, any fuel economy, and any per-frame exterior update loop (the exterior is dispose-and-rebuild, `exteriorView.ts:220-229`).

### 1.2 The invariants (say them every time)

- **Module = room = doc.** There is never a Ship class. "Ship" is an adjective on a room.
- **Capabilities = function-tagged furniture; equipping IS furniture placement** — the only transformation mechanism. No parallel equipment registry, ever.
- **Store the fittings, derive the ship.** Flight-capable, fuel capacity, and hull dress are all recomputed from furniture records on every client. Nothing derived is ever written. (The floorplan invariant, applied to ship-ness.)
- **Adapter transit never special-cases ship vs room.** It moves a player between two roomIds; flight-capability is invisible to it.
- **Flight is a record, not a simulation.** A state machine over writer timestamps in the ship's own doc; zero per-frame sync; flight NEVER touches `leaveRoom`/`joinRoom`.
- **A chained module cannot fly, by construction.** Depart only when door pairings are empty or transient-only; permanent connector chains are station structure — unpair first (parts refund included).
- **Fuel is doc truth; parts are local dev currency.** `stationParts` is per-install localStorage, "not shared room truth" (`stationParts.ts:8-11`) — the mounted fitting and the fuel level live in synced docs or two players see different tanks.
- **Sad meals, never danger.** Provisions are a checklist line beside fuel, display-only; running out is a story beat, not a fail state (greenhouse §6).
- **Wire changes are additive-only; old clients degrade render-not-corrupt.** Unknown kinds/records drop silently on read (`furnitureDoc.ts:99-107`); write `roomInfo.minClient` advisory per floorplan §3.5.
- **Owner-writes, honest-client.** UI gating on the write side, shape-check + clamp on read; signed enforcement is a named later slice, not an assumption.

### 1.3 The recommendation

Ship **SH1 — the parts** first (fittings + exterior dress + helm status readout, **no flight**), exactly as the owner asked: it delivers the visible transformation fantasy (your module grows engine bells at zoom 3) on seams that all exist today, commits nothing about travel, and makes "is this a ship?" a real, readable predicate. Then SH2 (ship doc: fuel truth), SH3 (state-based first flight), SH4 (passengers/provisions/polish), SH5 (the first node-touching slice: signed flight ops). Ordering argued in Part 7.

### 1.4 Where the research lines disagreed — resolutions

| # | Disagreement | Resolution |
|---|---|---|
| 1 | **Where mounted parts live.** C proposed extending `ExteriorKind` (`'solar'` → `+ 'engine' \| 'fuelTank'`, `exteriorDoc.ts:13`) so equipping writes exterior slots. A's distillation of the #30 ruling: capabilities = function-tagged *furniture*, "the only transformation mechanism." | **Furniture wins; the exterior derives.** Fittings are interior `FurnitureKind`s placed in edit mode and synced by `furnitureDoc` (zero new sync code); `exteriorView.buildGroup` reads `readAllFurniture()` and dresses the hull from `functions` tags. One source of truth, honors the ruling verbatim, and `exteriorDoc` stays a solar-only module. `EXTERIOR_SLOTS` remain for hull-only dress that has no interior existence. |
| 2 | **Cockpit: pilot seat or console?** Plan §1.2 sketches `pilotSeat` (a SeatTemplate handing input to a flight controller). | **v1 helm is a standing console device, tag `helm`.** There is no flight controller to hand input to until live piloting (post-station-doc); a seat with nothing to control is worse than a console with a checklist. `pilotSeat` stays reserved in the union and arrives with live piloting. |
| 3 | **Fuel-tank tag.** The plan's `ModuleFunction` union has no fuel-tank member (the `…` leaves room). | **Additive union definition now** (§3.1): `'fuelTank' \| 'engine' \| 'helm'` join the sketched members. Unknown tags are ignored on read — the shape-guard discipline makes the union free to grow. |
| 4 | **Flight as simulation vs state.** Inspiration docs gesture at a space-sim; the plan names pose-mutation as flying's eventual home. | **State-based v1** (C's recommendation, adopted whole): `flight` record + clock interpolation. No cross-doc sync exists (`ventures.ts:36-40`), no shared frame exists, no server clock exists — a state machine over timestamps is the only flight every client can agree on. Live pose piloting is v3, after the station doc. |
| 5 | **Fuel burn model.** Continuous burn vs per-trip debit. | **Flat per-trip debit at departure.** Continuous burn needs a clock authority nobody has. Destination pricing reuses the `fuelCostMultiplier` ladder already sitting in `ZOOM_LEVELS` (`zoom.ts:37,63-104`) as flavor only — camera zoom and travel scale must not be conflated. |

---

## 2. The ship model — what a ship IS in doc terms

A ship is the module's room doc plus one new root map, bound at the T0 seam in `main.ts` `joinRoom` alongside the eight existing binds (`main.ts:660-690`): `bindShipDoc(sync.doc)` → `doc.getMap('ship')`. New module `shipDoc.ts`, copied from the `furnitureDoc.ts` skeleton (header discipline at `furnitureDoc.ts:1-20`): rebind per join, owner-gated write functions, shape-checked untrusted reads, `docAlive()` guards, per-listener try/catch notify, one `doc.transact` per gesture, idempotent seeding.

```ts
// shipDoc.ts — doc.getMap('ship'); plain-JSON values, additive-only
// 'meta'   → { v: 1 }
// 'fuel'   → { level: number }        // units aboard; CAPACITY IS DERIVED, never stored
// 'flight' → FlightRecord

export type FlightStatus = 'docked' | 'in-transit' | 'arrived';
export interface FlightRecord {
  status: FlightStatus;
  locationId: string;        // where we are (docked/arrived): key into DESTINATIONS
  destinationId?: string;    // set only while in-transit
  departedAt?: number;       // writer-clock epoch ms
  etaAt?: number;            // writer-clock epoch ms; guard: etaAt > departedAt
}
```

**Read-side resolution, deterministic on every client** (`resolveShipState()`, the `resolveFloorPlan` idiom):

1. **Fittings** — scan the furniture array for defs whose `functions` include ship tags. Derived: `tanks`, `engines`, `helms` counts; `flightCapable = tanks>0 && engines>0 && helms>0`.
2. **Fuel** — `capacity = tanks × TANK_CAPACITY` (constant, e.g. 100/tank); `level` clamped to `[0, capacity]`, non-finite → 0. Removing a tank strands overflow fuel? No: clamp on read means level silently caps at the new capacity — deterministic everywhere.
3. **Flight** — missing/invalid record ⇒ `{status:'docked', locationId:'furlong-station'}`. **Empty `ship` map ⇒ today's module, bit-identical** (the floorplan empty-map invariant). Unknown `status` string ⇒ docked. `etaAt` passed ⇒ render as arrived regardless of status (clock-skew posture: clamp progress to [0,1], eta-passed is arrived).
4. **Location** — `locationId`/`destinationId` resolve against a static in-client `DESTINATIONS` table (§5.2); unknown ids render as home.

Trust posture: all of this is peer-writable room-doc state under honest-client rules — same trust level as furniture and doors today (`doorPolicy.ts:22-24`). Shape-check and clamp on read, owner-gate the write UI, accept until SH5.

---

## 3. The fittings

### 3.1 Three new furniture kinds + the tag union

Extend `FurnitureKind` (`furniture.ts:37-54`) and `FURNITURE_DEFS` (`furniture.ts:990-1079`):

| Kind | `functions` | Form | Builder precedent |
|---|---|---|---|
| `fuel-tank` | `['fuelTank']` | Fat wall-standing cylinder, 2×1 footprint, pressure-band paint | static build; materials at opacity 0 for morph fade-in (`BuildCtx`, `furniture.ts:91-103`) |
| `engine-block` | `['engine']` | Reactor housing against a wall, warm idle glow strip | `buildStorageTrunk` sub-group idiom (`furniture.ts:609-744`) for a later gimbal/throttle tween |
| `helm` | `['helm']`, `device: {…}` | Standing console with angled live screen | `buildWallComputer` canvas screen (`furniture.ts:405-506`) |

Define the tag union where the plan left the `…`: `type ModuleFunction = 'engine' | 'pilotSeat' | 'dockingAdapter' | 'attitudeControl' | 'fuelTank' | 'helm' | 'roomTerminal'`. Additive forever; readers ignore unknown tags.

Nothing else is needed for sync or spawning: `isFurnitureRecord` accepts any registry kind (`furnitureDoc.ts:78-89`); every kind outside `NON_SPAWNABLE` (`devMenu.ts:88-90`) gets a dev-menu `+` button automatically (`devMenu.ts:569-573` → `commitSpawn` at `332-372`), and peers apply via `reconcileFurniture` (`world.ts:661-735`) with the full rebake pipeline. Placement hygiene: dev-assert defaults with `assertPlacementClear` (`furniture.ts:1166-1183`) — large footprints near obstacles can create grid-walkable-but-impassable wedges (`furniture.ts:1111-1122`).

### 3.2 Exterior dress — the hull transforms

Inside `exteriorView.buildGroup` (`exteriorView.ts:64-218`), after the solar-panel and collar blocks: read `readAllFurniture()`, filter by `functions`, and add:

- **Engine bells** — one bell per `engine` item, mounted on the exterior face of the hull wall nearest the item, at the item's along-wall coordinate; items with no adjacent exterior run take a deterministic aft (south) fallback. On grown floorplans the "nearest exterior run" comes from the resolved tile boundary, so bells track hull growth for free.
- **Saddle tanks** — external bulge per `fuel-tank` item, same nearest-wall rule.
- Tag groups `userData.isEngineBell` etc. for the exterior click-editor path (`onClickCapture`, `exteriorView.ts:295-347`) — not used in SH1, free hook later.

Rebuild triggers are already wired: the furniture doc feeds `reconcileFurniture`; add one `subscribeFurniture(() => refreshExteriorView())` beside the existing exterior/door-policy/floor-plan subscriptions (`main.ts:717-742`). **No thrust animation in SH1–SH3** — the exterior has no update loop; animated glow is SH4's one renderer addition (a small per-frame tick over collected bell handles, NOT rebuild-per-frame, which would churn `disposeGroup`).

### 3.3 Parts economy

Extend `PartKind` (`stationParts.ts:22`) with `'tank' | 'engine' | 'helm'` — **touch `loadParts`/`saveParts` both** (`stationParts.ts:44-62` hardcode the key list; missing this silently zeroes stored counts). Dev-grant buttons follow `devMenu.ts:634-636` (`add-tank +2`, `add-engine +2`, `add-helm +1`). Spawning a fitting consumes a part, wrapping `commitSpawn` the way `consumeForSegments` gates preset prefill (`stationParts.ts:89-98`); deleting refunds (`stationParts.ts:75-104`). Same honesty note as flex/ext/hull parts: dev-grant now, fiction later.

### 3.4 In-world visuals discipline

The helm screen canvas and engine idle glow are drive handles: stow in `userData` (the `furniture.ts:505/743/961` pattern), collect in `registerFurnitureGroup` (`world.ts:546-570`), drive in `World.update` beside the wall screens (`world.ts:1207-1216`, 1 Hz), and **add the inverse delete in `removeFurnitureVisuals`** (`world.ts:773-783`) — the documented #45 F1 regression rule, warned in-source at `world.ts:539-540`.

### 3.5 Compatibility

A v0.31.x peer in the room drops the unknown kinds on read (`furnitureDoc.ts:99-107`) — the fittings are simply invisible to them; render-not-corrupt, nobody diverges. Start the advisory convention: write `roomInfo.minClient` when the first fitting lands (floorplan §3.5 posture).

---

## 4. The HELM console

Four shipped steps, all precedented:

1. `'helm'` joins `DeviceKind` (`devices.ts:56`).
2. The `helm` def carries a `DeviceTemplate {front, faceAngle, eye, anchor}` (`devices.ts:106-116`; in-registry examples at `furniture.ts:1013-1078`).
3. `createHelmUI` returns `DeviceUI {mount, unmount, update}` (`devices.ts:119-124`), modeled on `createRoomTerminalUI` (`devices.ts:282-505`): gold-on-dark panel, stopPropagation click capture, 4 Hz refresh.
4. A `helm` branch in `World.requestDeviceFocus` (`world.ts:1869-1935`; the trunk branch at `1899-1918` shows per-item handle binding + prepare/onRelease choreography). Click→focus routing is free (`furniture.ts:1404-1411`, `main.ts:3981-3990`).

**The v1 face is a pre-flight checklist — deliberately no LAUNCH button in SH1/SH2** (a launch control would commit unsettled travel semantics; the greenhouse doc sanctions exactly a checklist console):

```
  SHIP STATUS — [module name]
  ENGINE ........ FITTED (1)        ✓
  FUEL TANK ..... FITTED (2)        ✓
  HELM .......... ONLINE            ✓
  FUEL .......... ███████░░░  140 / 200
  PROVISIONS .... 12 meals · ~6 days     (SH4; display-only)
  BERTHS ........ 1 CHAINED — cannot depart   (SH2)
  STATUS ........ DOCKED — FURLONG STATION
```

Status plumbing: extend `WallComputerStatus` (`devices.ts:128-132`) with the derived ship fields, fed from `readLiveRoomStatus` (`devices.ts:224-230`), which World already drives at 1 Hz (`world.ts:1207-1216`). This same extension **replaces the honesty stubs**: the wall computer's "FUEL — NO SENSOR" line (`furniture.ts:467-469`) and the room terminal's hatched gauge (`devices.ts:465-466`) render the real gauge when a tank is fitted, and keep the NO SENSOR state when not — the stubs were written for this moment.

SH3 adds the console's only verbs: DESTINATION picker + DEPART (owner-gated), and REFUEL (SH2, dev-free). Flight *controls* — throttle, attitude — never appear on this console; they belong to the pilot seat in the live-piloting era.

---

## 5. The v1 flight loop — state-based travel

### 5.1 Departure (UNDOCK)

Precondition, checked same-doc: `flightCapable && fuel ≥ cost && pairings are empty or transient-only`. Permanent connector-chain pairings are station structure — the console shows "1 CHAINED — cannot depart"; the owner unpairs via the existing flow (parts refund included). This makes "what about docked neighbors" answer itself: **a chained module cannot leave, by construction.**

Occupied transient guest berths ARE the ship's problem and the ship's power: their `DoorRecord`s live in the ship's own doors map (`docking.ts:546-556`), and either-side detach is already legal (`docking.ts:717-718`) — the DEPART flow lists occupied berths and detaches them with same-doc writes. The one cross-doc casualty: the *station-side* record pointing at the departed ship goes stale (the pilot can't write the station's doc — one doc at a time). **Accepted**: station members clear it with the shipped ⏏ DETACH row (`docking.ts:774-779`); this is the plan's "phantom empty room" cosmetic cost, and it means departures are witnessed from aboard, not from the dock.

DEPART then, in one transact: debit fuel (flat cost from the destination table), write `flight = {status:'in-transit', locationId, destinationId, departedAt: now, etaAt: now + travelMs}`. Travel time 60–120 s. **No `leaveRoom`, no `joinRoom`, no tick changes — everyone aboard just watches the view change.**

### 5.2 Destinations

Static in-client table, three entries: `furlong-station` (home; planet backdrop as today), `high-orbit` (×1 fuel), `l4-anchorage` (×2 fuel — pricing flavor from the `fuelCostMultiplier` ladder, `zoom.ts:37,63-104`). "Nothing to do there yet" is fine — the journey and the shared cabin are the content. Destination *content* is deferred by name (§8).

### 5.3 The exterior scene branch

`buildGroup` gains a `flight.status` branch (~1 file):

- **docked** — today's build verbatim: planet + atmosphere (`exteriorView.ts:203-215`), paired-chain neighbor groups (`worldRef().getPairedVestibuleGroups`, `world.ts:1363-1367`), ENTER ROOM collar targets.
- **in-transit** — swap the planet block for a `THREE.Points` starfield with slow drift; suppress collar targets and neighbor chains (an unpaired ship has none anyway); progress text from clock interpolation, clamped.
- **arrived** — per-destination backdrop from the table (planet color/position tuple).

Rebuild-on-change via `subscribeShip(() => refreshExteriorView())` beside `main.ts:742`. Interior (zoom 1/2) is untouched in v1; windows/skybox deferred.

### 5.4 Passengers, arrival, return

Passengers are room members; the doc travels with them — chess (`gamesDoc`), chat, furniture editing all continue mid-flight *because they are the same doc*. Two rules: the berthing UI refuses new transient berths while `status === 'in-transit'` (same-doc read); and network reachability stays orthogonal to fictional location — anyone with the seed/pass can join a ship "in deep space." **Embrace it silently in v1** (shuttle fiction if anyone asks).

Arrival is passive: `etaAt` passes, every client independently renders arrived. Return: fly home the same way (`status:'docked', locationId:'furlong-station'`), and **physical re-docking to a station module is the shipped #67 D2 berthing flow** — walk in via pass, INITIATE at an adapter door. Zero new code for the hardest-looking step.

---

## 6. Authority — who flies

**v1 rule, plain language: *if you could rearrange the furniture, you can fly the ship.*** Flight verbs (REFUEL, DEPART) sit behind the existing single owner gate — and via #68, holding *any* venture share is owner-equivalent (`ventures.ts:9-13`), so any shareholder flies a venture-owned ship exactly as they may edit it. Zero new roles code. Enforcement is honest-client UI gating (`doorPolicy.ts:22-24` posture); passengers need no authority at all — they are room members.

**Flagged, not built:** a pilot *role* is the first place the any-share rule wants a carve-out (a 1-share holder can fly the venture yacht away — consistent with today's owner rule, but it must not slip past v2 once ships can strand a cabin full of people fictionally far from home). **Deferred by ruling:** the multi-module control tree — oldest-module default controller, explicit tree-shaped handover, break-off subtrees (owner ruling 2026-07-13) — is recorded, binding, and "not implementable before the station-doc slice." Nothing in SH1–SH5 touches it; the station-doc slice starts from those rules.

---

## 7. The slices

Dependency-ordered, one point release each, frontend-first. **SH1–SH4 need zero node work; SH5 is the first slice that touches the Rust node.**

### SH1 — The parts (fittings + hull dress + helm status readout; **no flight**)

The owner's ask, verbatim. Scope: three `FurnitureKind`s + `functions` union (§3.1); builders with morph-fade materials and drive-handle discipline incl. the `removeFurnitureVisuals` inverses (§3.4); `PartKind` extension + dev-grants + consume/refund spawn gating (§3.3); exterior dress derived from furniture records + furniture-doc rebuild subscription (§3.2); `'helm'` DeviceKind + `createHelmUI` checklist showing FITTINGS lines and the fuel gauge in its honest no-fuel state (capacity derived, level 0 — no ship doc yet); NO SENSOR stubs replaced (§4); `roomInfo.minClient` advisory. **Acceptance:** fit tank+engine+helm in edit mode; zoom to 3 and see bells and saddle tanks on the hull; a second client sees the same; click the helm and read ENGINE ✓ / FUEL TANK ✓ / HELM ✓; remove a part, watch dress and checklist revert, part refunds; a v0.31.x peer degrades to invisible fittings, nothing breaks.

### SH2 — The ship doc (fuel truth + readiness)

`shipDoc.ts` + `bindShipDoc` at the T0 seam (§2); `resolveShipState()` with clamps; REFUEL verb at the helm (owner-gated, dev-free); live fuel gauge everywhere the status flows; BERTHS readiness line (pairings empty / transient-only / chained, read from the doors doc); `flight` record schema lands, written only as `docked`. The checklist is now a complete, truthful pre-flight checklist with nothing to launch. **Acceptance:** refuel on one client, gauge moves on the other; hostile `fuel.level = 9999` clamps to derived capacity on every reader.

### SH3 — First flight

DESTINATION picker + DEPART verb with the §5.1 gate (transient-berth detach ceremony included); fuel debit; in-transit starfield + arrived backdrops (§5.3); ETA interpolation with clamp/eta-passed-is-arrived; refuse-new-berths-in-transit; return home; re-dock via shipped #67 flow. **Acceptance:** two clients aboard depart together, watch the same starfield, arrive together within clock skew; a third client joins mid-flight and sees in-transit; ship with a chained pairing cannot depart; station side clears the stale berth with existing DETACH.

### SH4 — Cabin life (passengers, provisions, polish)

PROVISIONS display line from a doc record (greenhouse F6 hook — "12 meals · ~6 days"; zero = grumble copy only, **never danger**); engine-glow/thrust tick for the exterior (the one renderer addition — collected bell handles, per-frame drive, not rebuild); departure/arrival console copy; destination backdrop art pass; station-side stale-berth UX copy. **Acceptance:** provisions hit zero mid-flight and nothing bad happens, visibly.

### SH5 — Signed flight ops (first node work)

The named end of the honest-client era for flight: flight/fuel writes become signed records the node validates (the #67 D3 / RoomLog Phase 2 trajectory). Everything before this ships against honest clients on purpose. Not scoped further here — it inherits whatever RoomLog lands as.

**Explicitly NOT in any SH slice** (sequenced after the station doc, per the plan's own rulings): live pose piloting and the shared-frame renderer; multi-module flight groups + the control tree; `pilotSeat`; variable-angle adapters at grown hulls (#62 dims-aware solver).

---

## 8. Known unknowns

1. **The pose frame.** "Flying = mutating a module's pose in a shared frame" — the frame is undefined until the station-doc slice defines it. Nothing in SH1–SH5 constrains it.
2. **Deep-space content.** Destinations are flavor entries; mining/encounters/markets unscoped. Refuel economy likely rides #68 offer slips.
3. **Reachability vs fiction.** Seed-holders can join a ship "in deep space." Embraced silently in v1; a deliberate fiction (shuttle, ansible) may be wanted later.
4. **Pilot role carve-out** for any-share ventures — flagged §6, must not slip past v2.
5. **Departure witnessed from the dock.** The stale station-side berth means the dock never sees the ship leave in real time. Later: visitation-gossip auto-clear, or a departure animation on DETACH.
6. **Interior windows/skybox in transit** — the cabin currently looks identical mid-flight at zoom 1/2. Cosmetic, unscheduled.
7. **Grown hulls docking** (floorplan known-unknown #7): big ships at the octagon need the dims-aware #62 solver.
8. **Provisions beyond the display line** — pantry stocking, farm-rack sustain rules — ships with greenhouse F6, ordering open.
9. **Clock skew posture is a choice, not a solution:** writer-clock timestamps + clamp is accepted; if skew ever exceeds tens of seconds, arrival moments visibly diverge. Revisit at SH5 when the node can timestamp.
10. **Ship identity/registry** — whether a ship wants a name, transponder, or chia-published location is untouched; today it is `roomInfo.name` and nothing else.
