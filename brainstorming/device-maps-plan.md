# In-device maps — the staged plan (#33)

> **Ruling (owner):** the game is limited to **first person + third-person
> isometric**. Every representation of the world outside those two views —
> station overview, solar system, galaxy, universe, and any operator "God view"
> — must render **in or on an in-game device**, never as a fullscreen HUD
> canvas that ignores the character. This plan is how we get there without
> ever deleting the only path to a feature before the replacement ships.

Target line: `prototypes/0.29.0-core-loop-demo`. Live baseline verified against
this branch's source at commit `dc46460`.

## 0. Verified ground state (2026-08-20)

- **Two ruling-compliant camera modes today.** `zoom.ts` runs an 8-level
  `MultiScaleZoomView`; level 1 is first-person free-look and level 2 is the
  locked isometric room camera. Both are diegetic. Levels 3–8 are the fullscreen
  canvas overlay that the ruling deprecates, and they are already **clamped to
  `?devzoom=1`** — public builds cannot reach them (`zoom.ts` M-dep note; the
  `?devzoom` gate lives in the `zoomOut` path).
- **Space view exists in world as level 3 exterior.** `exteriorView.ts` renders
  the CURRENT module plus every OTHER known module posed via the station atlas
  (`atlasLayout`, `stationAtlas.ts`), with the paired connector chains drawn
  between them. This is where the "zoom out to space" beat lives now and it is
  first-class 3D that the room camera glides into — it survives even after the
  device-maps overhaul (see §5 below).
- **The wall computer exists (#33 M1).** `wall-computer` is a wall-mounted,
  never-an-obstacle furniture item with a `roomTerminal` device template and a
  live in-world `CanvasTexture` screen (idle status frame at 1 Hz; "TERMINAL IN
  USE" while a player is focused). Its focused DOM UI (`devices.ts
  createRoomTerminalUI`) shows: room name / peer count / node & P2P dots; a
  wireframe TOP-DOWN of the room with furniture footprints derived live from
  `FURNITURE` and door ports coloured by live `DockingState`; an EDIT ROOM /
  EDIT HULL row; a striped FUEL band labelled `FUEL — NO SENSOR FITTED`; a
  paired-neighbours line labelled `NO ADJACENT MODULE DATA` when unpaired.
- **The map table exists (#33 M4).** `map-table` is a 2×2 obstacle with a
  `mapTable` device template. Its focused UI (`createMapTableUI`) mounts the
  full `SolarSystemMap` inside the device-focus overlay — pan/zoom/select/travel
  all container-local, the sim tick gated to the open table. The fullscreen `m`
  overlay and the HUD `#solarmap-toggle-btn` are already retired (M-dep in
  `main.ts`).
- **Storage trunk exists (#35 TR2).** `storage-trunk` → `storageTrunk` device
  with the lid animation choreographed against focus. This is the pattern every
  other diegetic device UI copies — walk to `front`, camera eases to `eye`,
  `prepare` hook plays, DOM overlay mounts, exit reverses.
- **Device focus is one mechanism.** `deviceFocus.ts` runs a single controller
  (IDLE → WALKING → FOCUSING → FOCUSED → RELEASING) that swaps the
  `window.gameRenderer.camera` to a per-device PerspectiveCamera (never uses
  `zoom` level 1), hides the local player mesh, mounts one `DeviceUI`, and
  restores the ortho camera on release. WASD / click-away / Esc all release.
- **The station atlas is already shared.** `stationAtlas.ts` maintains a
  local-per-install localStorage graph AND a `Y.Map('atlas')` on the room doc
  that gossips geometry-and-names (not seeds) two-way. A ship joining any room
  of a small station receives the whole layout during the initial doc sync.
- **The phone is a personal overlay, not a map.** It stays a full-screen UI
  (Tab hotkey, index.html `#space-phone-overlay`) — the ruling is about
  world-map surfaces; personal HUDs like the phone are not in scope.

Anything the ruling deprecates that is still visible in a build must have a
replacement in-world before it is removed. That is why levels 3–8 stayed behind
a URL flag while M4 shipped, and it is the guiderail for the stages below.

## 1. End state — one sentence per surface

- **Room overview / edit** → **wall computer** in the room.
- **Docked station's outside (small stations)** → **wall computer** overview
  page (first slice below), then the map table's STATION page for larger
  stations.
- **Solar system / travel plot** → **map table** (already there).
- **Ship helm status / fuel** → **helm console** (already tagged; the helm
  panel already gates on real `functions` counts).
- **Higher scales (system / galaxy / universe)** → **holograph table** in a
  later slice: same map-table device kind, extra `page`s.
- **Zoom levels 3–8 canvas overlay** → **retired**. The wall computer covers
  the station wireframe (small stations), the map table covers the solar map,
  and the exterior-view space camera (`exteriorView.ts`) covers the "step
  outside" beat as an in-world third-person view — see §5.

At the end of the plan the game exposes exactly two camera modes to the
player: **first person** (level 1) and **isometric room** (level 2, and the
level-3 exterior beat which is the room camera pulled back to render the
station in world). Every "map" is a texture / DOM overlay owned by a piece of
in-game furniture.

## 2. Stages (dependency-ordered)

Each stage is deliberately small enough to ship on its own and leaves the game
in a consistent state — the ruling is honoured stage by stage, not just at
completion.

### Stage A — Wall computer: **small-station overview** (THIS PR's implementation slice)

Adds the second wireframe pane to the wall computer's focused DOM UI: a
top-down view of **every known module** — the current room at the origin
(true dims where known) and every atlas neighbour posed by `atlasLayout`,
composed by walking the shared connection graph the exterior already renders
from. Small stations only, per the issue: capped at `SMALL_STATION_MAX`
modules (currently 12 — enough for two rings of the octagon + a few extras),
otherwise the pane shows `LARGER STATION — USE MAP TABLE` and refers the
player to the M4 device.

- Renders the whole set via a `fitPointsToCanvas` viewport transform so a
  crooked or off-centre layout still lands centred with equal aspect ratio.
- Draws each module as an oriented outline (uses the atlas pose's `rotY`, in
  the same rotation convention as `atlasLayout` and Three.js `rotation.y` so
  the pane and the exterior view agree on which end is which) with a small
  dot at the module centre, its display name below, and hop count from the
  current room next to it.
- Colours the CURRENT module with the same gold as the EDIT ROOM button so
  "you are here" reads at a glance; neighbours get the same cool cyan every
  wireframe surface uses.
- **Doors stay on the room wireframe only.** The room-only pane above already
  paints this module's doors from `readAllDoorLayout` + `physicalDoorPose`;
  the station overview deliberately shows footprint + centre + name + hop
  badge only — door markers on the inset would read as noise at station scale
  and there is no gossiped door geometry for neighbours worth drawing until
  the map table's STATION page (Stage C) picks up connector chains too.
- **Honest dims envelope.** The pane treats a neighbour's `dims` as unknown
  unless it passes the same integer range the room contract enforces (1..5
  tiles each axis, per `floorPlanDoc.ROOM_TILE_MIN/MAX`), so hostile or older
  localStorage entries fall back to the dashed uniform outline rather than
  collapsing or blowing out the fit.
- **No new network traffic.** Uses the already-populated atlas — the same
  data the exterior renders and the docking-pane keypad's KNOWN MODULES list
  already reads.
- **Traversal depth pinned to `SMALL_STATION_MAX`.** The BFS runs at least as
  far as the small-station cap so a straight 12-module chain reads as small
  and the first over-cap module can still trigger `USE MAP TABLE` — a
  shallower cap silently truncated the last modules of long chains and
  advertised a partial map as the whole overview.

The station overview is derived by **pure helpers** in `wallComputerMap.ts`
(the module the tests target):

```ts
export interface StationModulePlacement {
  roomId: string;
  name: string;
  x: number;         // world-space centre of the module
  z: number;
  rotY: number;      // module orientation (atlasLayout / Three.js convention)
  halfX: number;     // module footprint half-extent along its local X
  halfZ: number;     // …and along its local Z
  isCurrent: boolean;
  hops: number;      // 0 for the current room
  dimsUnknown: boolean; // true when the module was rendered at the fallback size
}

// Compose the current room + atlas poses into one placement list. The
// currentName is inserted between the id and the dims so the pane can label
// the "you are here" cell with the room's display name (the room-status
// read that owns that name lives in the DOM adapter, not this pure helper).
// currentDims may be null / undefined — the placement then reads with
// dimsUnknown = true and the fallback outline is drawn.
export function stationPlacements(
  currentRoomId: string,
  currentName: string,
  currentDims: RoomDims | null | undefined,
  poses: AtlasPose[],
): StationModulePlacement[];

// Rotate + translate a module's oriented rectangle into world-space corners.
// Uses the atlas / Three.js `rotation.y` convention:
//   x' = x·cos + z·sin
//   z' = -x·sin + z·cos
// so the projected footprint agrees with the exterior view for the same pose.
export function projectModuleFootprintCorners(
  placement: PlacementPose,
): Array<{ x: number; z: number }>;

// Fit a set of world-space points into a square canvas with padding, keeping
// the aspect ratio (equal x/z scale) and bounding the scale within [min,max].
// Both bounds are optional; the wall computer passes only `maxScale`, letting
// the fit decide the lower end so an ~200 m 12-module chain still lands
// inside the padded canvas.
export interface Viewport { scale: number; offsetX: number; offsetZ: number; }
export function fitPointsToCanvas(
  points: Array<{ x: number; z: number }>,
  canvasSize: number,
  padding: number,
  bounds?: { minScale?: number; maxScale?: number },
): Viewport;

export const SMALL_STATION_MAX = 12;
export function isSmallStation(count: number): boolean;
// Whether a RoomDims value passes the room contract envelope (integer axes
// in ROOM_TILE_MIN..ROOM_TILE_MAX = 1..5). Every unvalidated read of dims
// (atlas gossip, localStorage) must go through this before being drawn.
export function areDimsRoomValid(dims: RoomDims | null | undefined): boolean;
export function moduleHalfExtents(
  dims: RoomDims | null | undefined,
): { halfX: number; halfZ: number; usedFallback: boolean };
```

The DOM UI walks the placements, calls `projectModuleFootprintCorners` for
each, and paints an oriented outline onto the second `<canvas>`. All coordinate
math lives in pure functions with tests; the UI code is a thin adapter.

### Stage B — Desk computer [SHIPPED]

Shipped as the follow-up to Stage A. New `desk-computer` furniture: 2×1 floor
obstacle carrying a monitor + keyboard on a slab top, `deskTerminal` capability
tag, `deskComputer` device kind. Placed by default at world `(2, -3.5)` rot 0
between the map-table nook and the sofa cluster — the front-point at `(2, -2)`
lands in the open aisle and the west edge is EDGE-FLUSH with the map-table
(same wedge-trap-safe-by-construction rule the bunk bed uses).

The focused DOM UI (`devices.ts createDeskComputerUI`) is a **two-column**
gold-frame panel: the LEFT column mirrors the wall computer's read surface
verbatim (room name / peer count / node & P2P dots; the top-down module
wireframe; the small-station overview from Stage A; EDIT ROOM / EDIT HULL;
`FUEL — NO SENSOR FITTED`; adjacent-module line), and the RIGHT column adds
the **room-management writes** the issue calls for:

- **Rename** — 24-char cap (same cap the network panel enforces via
  `input.maxLength = 24`), owner-gated at write time, pure sanitiser
  (`deskComputerManagement.sanitizeRoomName`) shared with the provider.
- **Invite mint / copy** — button calls the same `mintBootstrapLink` helper
  the network panel and Copy Invite already use; the returned link runs
  through the pure `isValidInviteLink` guard (accepts `ssf://room?seed=…`
  and `http(s)://…?seed=…`; rejects `javascript:` / `data:` / `file:` and
  any URL lacking a non-empty `seed`) before it is echoed / copied.
- **Access mode selector** — PUBLIC / PASS / KEYED radios, LWW-normalised
  through `deskComputerManagement.normalizeAccessMode` (any unknown value
  collapses to `pass`, matching `main.ts §5476 getRoomAccessMode`), and the
  description text word-for-word matches the ACCESS app's `ACCESS_MODE_COPY`.
- **Peer roster** — three-column table (PEER · ROLE · KEY) painted from a
  pure `orderedRoster` helper: sorted by `joinedAt` ascending (matches the
  phone's CLONES SEEN grain), OWNER pill on the row whose id matches
  `roomInfo.owner`, `(you)` suffix on the local row, `🔑` badge on rows
  that publish a name↔key self-cert. Malformed peer entries render as
  `? MALFORMED` — honest partial-knowledge label rather than a silent drop.

Discipline (same as Stage A):

- **Pure math in `deskComputerManagement.ts`** with 30 vitest cases (name
  sanitisation, access-mode normalisation, ACCESS_MODES ordering, roster
  ordering including malformed / joinedAt-missing / owner-tie / stable-sort
  cases, invite-link guard including `javascript:` / missing-seed rejection,
  ownership-label decoration). No DOM / no globals / no `window` / no
  `localStorage` — the module is exercised without a browser.
- **DOM adapter is a thin painter.** `devices.ts createDeskComputerUI`
  composes provider data with pure helpers and paints; every write echoes
  the provider's `{ok} | {ok:false, reason}` verdict inline.
- **Provider seam.** `deskComputerProvider.ts` exports a module-scoped
  slot (`setRoomManagementProvider` / `getRoomManagementProvider`) — the
  same setter-once idiom `editMode.setRoomEditPermission` uses. `main.ts`
  registers the live implementation at init (reading owner / roomInfo /
  players from `yjsSync.doc`, delegating mint to `mintBootstrapLink`);
  `world.ts` consumes the provider when building the desk-computer's
  deps. A missing provider (minimal test harness, early boot) ⇒ the
  management column HIDES and the desk terminal degrades to the wall
  computer's read view.
- **No new network traffic.** The desk pane reads live doc state; writes
  land through the same `yjsSync.doc.transact` seams the network panel
  uses. The mint path reuses the existing fingerprint / WebTransport
  bootstrap flow — same code path the ACCESS app relies on today.

Anti-scope (as originally called): no operator diagnostics move here. The HUD
network panel keeps its diagnostics drawer — that is a developer tool that
lives on the frame, not in the world; the ruling is about the game's fiction,
not devtools.

### Stage C — Map table: **STATION** page

Second page on the map table (currently the solar plot only). STATION renders
the full station-atlas layout at the correct world scale (same
`atlasLayout` + hull-shell composition the exterior already does), with
selection → module details, module-labelled edges (connector chain lengths),
and a hologram breathe animation that keeps it reading as a map, not a
screenshot. Small stations render on the wall computer; larger ones are the
map table's job.

### Stage D — Retire zoom levels 3, 4 (and any surviving 5–8)

Delete the fullscreen canvas overlay renderer (`zoom.ts` levels 3–8) once (a)
Stage A ships the small-station overview and (b) Stage C ships the map-table
STATION page. The `exteriorView.ts` **in-world** space camera stays — it is
already a first-class 3D view that the room camera glides into (level 3 in
world). That beat continues to exist; only the canvas overlay is deleted.

The `?devzoom=1` flag is dropped in the same PR — no path to the fiction
overlay survives. `zoomIn/zoomOut` become 1↔2 and 2↔3 (the exterior beat)
only.

### Stage E — Holograph table

Optional larger prop with `mapTable` kind but a `page` menu covering STATION
/ SYSTEM / GALAXY / UNIVERSE. Only the pages that have real data render —
UNIVERSE renders `NO CATALOGUE` until there is one to display. The point is
one physical prop for every world-scale rather than eight zoom keys.

### Stage F — Helm status wall panel

Not strictly a map, but the same pattern: fuel and system readouts currently
labelled `FUEL — NO SENSOR FITTED` on the wall computer graduate to a real
panel on the helm console once the ship-systems slice lands (see the M345
build plan). The wall computer's copy then reflects real numbers rather than
saying no sensor is fitted.

## 3. What lives on which surface — cross-reference

| Surface                | Wall computer | Desk computer | Map table (SOL) | Map table (STATION) | Helm | Exterior (level 3) |
|------------------------|:-------------:|:-------------:|:----------------:|:--------------------:|:----:|:-------------------:|
| Room name / peers      | ✓             | ✓             |                  |                      |      |                     |
| Room wireframe         | ✓             | ✓             |                  |                      |      |                     |
| Small-station overview | **A** (this PR)| ✓            |                  |                      |      | ✓ (real 3D)         |
| Large-station overview |               |                |                  | **C**                |      | ✓ (real 3D)         |
| System / travel plot   |               |                | ✓                |                      |      |                     |
| Galaxy / universe      |               |                |                  |                      |      | **E** (holograph)   |
| Edit room / hull       | ✓             | ✓             |                  |                      |      |                     |
| Fuel / ship systems    |               |                |                  |                      | **F**|                     |
| Manage room / peers    |               | ✓ (Stage B)     |                  |                      |      |                     |

Bold cells name the stage that lands each surface. Every non-bold cell is
either already shipped or a graceful redundancy (e.g. the desk computer will
mirror the wall computer's small-station overview so both the walk-up glance
and the sit-down-and-work seat carry it — the pane is the SAME helper, just a
larger canvas on the desk).

## 4. Edit-mode entry point — verdict

The wall computer **already carries** the EDIT ROOM / EDIT HULL row (world.ts
`requestDeviceFocus(roomTerminal)` wires `deviceFocus.releaseThen(→
roomEdit.enter)`). The plan already retired the HUD pencil — nothing new to
do for the M2 requirement. **This PR keeps the button exactly where it is.**

Justification for keeping it on the wall computer rather than relocating:
1. **Walk-up affordance vs. sit-down chore.** Editing the room is the kind of
   short interaction you do standing at a wall panel; the desk computer's
   longer sessions are room-management writes (Stage B). Two different
   ergonomic seats.
2. **One button, one owner check.** The button already runs
   `deviceFocus.releaseThen(→ roomEdit.enter)` — the release-with-continuation
   idiom the plan D0.3 specifies. Duplicating it on the desk computer risks
   two racing entry points. If Stage B wants a copy of the button it will call
   the same request handler.
3. **The wall computer is the one device every room is guaranteed to have.**
   A room without a desk (a small storage module, a cargo hold) still needs
   edit access, and the fixed `movable: false` wall computer is the immutable
   entry point that guarantees the game never traps the owner without a way
   into edit mode.

## 5. Fate of the current zoom-out space view

- **Level 1 (first-person) stays** — ruling-compliant.
- **Level 2 (isometric room) stays** — ruling-compliant.
- **Level 3 (exterior) stays** — this is the third-person shot of the module
  from outside; `exteriorView.ts` renders it as real 3D that the atlas
  populates. It is not a canvas overlay; the room camera itself pulls back and
  composes the neighbours around the current hull. The ruling only forbids
  non-diegetic "God view" — a wide third-person camera onto the world model
  is still an isometric render.
- **Levels 4–8 (fullscreen canvas overlay) retire in Stage D.** Their
  fictional data (sectors, orbits, galaxy arms) moves to the map / holograph
  table pages as real data exists. Deletion is gated on Stages A + C shipping
  their replacements first — see the ruling on `?devzoom` for the transition.

## 6. Dependencies + risks

- Stage A depends on nothing not already in the build. The atlas is populated
  by the same code the exterior renders from.
- Stage B depends on the existing `desk-computer` slot in the furniture
  registry (already reserved by the plan; the build function is what's owed).
- Stage C reuses `exteriorView.ts` composition helpers — no new geometry.
- Stage D is a deletion PR whose gate is A + C landing.
- Stage E depends on Stage C.
- Stage F depends on the ship-systems slice from
  `brainstorming/spaceship-conversion-plan.md`.

Nothing here changes the network protocol, the room doc shape, or the
persistence layer. Every stage is a UI slice over data the room doc already
carries.

## 7. Honest limits

- **The wall computer's small-station cap is a heuristic.** 12 modules fits
  the octagon plus a few overflow docks; beyond that the overview reads as
  noise on a phone-sized inset. Owners with larger stations use the map
  table's STATION page (Stage C).
- **The overview does not draw connector chains.** The map table's STATION
  page (Stage C) will; the wall computer draws module footprints and mode
  labels only, which reads cleanly on a small screen.
- **`atlasLayout` shows the CLIENT-KNOWN atlas.** A visitor who has only
  joined one module of a station sees only what that room's doc has gossiped
  about the rest. This is the ruling on privacy — no forced discovery — and
  the wall computer inherits it. The pane says `NO OTHER MODULES YET · JOIN
  ANOTHER ROOM TO POPULATE THIS MAP` when the atlas has no neighbours.
- **The room wireframe stays exactly the wireframe it was before this PR.**
  Stage A adds a SECOND pane below it, not a replacement.
