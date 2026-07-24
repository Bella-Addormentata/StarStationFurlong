# Changelog

All notable changes to StarStation Furlong releases. The packaged application lives in
[prototypes/0.29.0-core-loop-demo](prototypes/0.29.0-core-loop-demo/) and is built by the
[release workflow](.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed.
Prototype folders are named `<release-version>-<demo-name>`; superseded demos stay
frozen under their original version prefix (e.g. the pre-0.5.0 game is preserved at
[prototypes/0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/)).

## Unreleased

- The mesh increments deliberately deferred out of v0.29.0 (see that entry's scope note): **M5.5** per-tick authorship (amortized epoch-signature on the 13-byte tick lane — closes the last tick-spoof gap), **M5.4** lazy-pull graduation from opt-in (`SSF_MESH_LAZYPULL`) to on-by-default once its dropped-frame recovery is hardware-verified, and the **large-room hardening** (emit `graft`/`prune`/`px` so membership is symmetric above 8 nodes, plus the eclipse tier-diversity floor + IWANT rate limit). Also still ahead: **ChiaHub C1** chain IO (gated on spike B-7), **E4** furniture PERSISTENCE, **S3** presence (name tags + remote outfits), and the station-doc flight-control authority tree.
- **CHANGELOG backfill owed:** v0.33.0 (fox character update, parallel effort) through v0.33.5 (#79 P4 resume-at-last-location) shipped as tagged releases without prose entries here — recoverable from the git tags + merge commits if a curated backfill is wanted.

## v0.33.29 — 2026-07-24

### 🎲 Craps — the second house game (#69 G3)

Bank craps joins roulette as a fully playable, house-banked table, following the same client/operator split, physical-chips rule, and walk-up standing slots.

- **The table:** a new 3×1 `craps-table` furniture piece — eight standing positions, the middle of one long side reserved for the STICKMAN (the owner or their croupier robot), placed as the marquee table in the casino's south half.
- **The game** (`games/craps.ts`, pure + console-testable): pass line & don't pass, field, place 4/5/6/8/9/10, any-7, any-craps at true casino odds. State carries across rolls — the pass line travels with the POINT, place bets stay working until a seven-out; PLACE stacks pay on the aggregate stake (no per-chip rounding loss).
- **Integration mirrors roulette:** parallel craps accessors on the casino doc (shape-guarded so a table is one game), an auto-stickman croupier with the same deed-holder election/heartbeat, a focused board UI (tumbling dice, ON/OFF point puck, felt, chip trays), and the walk-up gather generalised to any reserved operator role.
- **Dice fairness (testnet11, dev-phase):** switchable modes — rng / commit-reveal / multiparty / block-beacon — with T1 commit/reveal records pushed through the node; `wait_for_next_coin` waits for the spent coin to leave the unspent set before reusing the wallet (multi-coin safe).
- **Release line:** version bumped to 0.33.29, all nine locations. **⚠ Node binaries CHANGED** — this release adds Rust node code (`chia_craps_fair.rs` + new deps), so the release workflow's node build is required (first node change since v0.30.6).

## v0.33.28 — 2026-07-23

### 🚪↔️ Drag a door along its wall to move it (#28 decouple, slice 6c)

The door editor learns MOVE: pick up a placed door in edit mode and slide it along its wall, exactly like moving a furniture item.

- **Click a selected door** (gold tint) to pick it up — the actual door slides live under your cursor along **its own wall** (wall-locked: cross-wall moves stay remove + re-add), snapping to the same floor grid as placement (small door on the half-tile, large on the tile) and clamped to the wall's slide range. **Green** where the drop is valid, **red** where it isn't; click on green to drop, Esc / right-click to cancel back to where it was.
- A door with a live docked module is protected — unpair it first, same as remove.
- **Split write under the hood:** the four cardinal doors ride the legacy floor-plan slide store (the same one the wall computer's slider uses, so the existing cross-client reconcile just works), while free doors update their `doorLayout` record — never both.
- **Doors now respect windows** (both placing and moving): the octagon hull's windows only checked clearance in the window→door direction; the door editor's validity check now refuses a spot that collides with a window, mirroring the window side's margin.
- **Moved free doors keep working walk-throughs:** their walk targets (front/through points) re-derive from the layout record on reconcile — previously only cardinal doors repositioned.
- **Release line:** version bumped to 0.33.28, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**
## v0.33.27 — 2026-07-22

### 📸 Photo décor — six real-photo furniture pieces (bouquets + balloons)

A new décor category: the owner's own product photos as placeable furniture.
Four flower bouquets, a floor balloon bunch, and a wall-hung balloon variant —
all spawnable from the DEV menu's FURNITURE list, movable/deletable with the
right-click context menu, decorative (footprint null, never an obstacle).

- **The set:** 😊 SMILEY BOUQUET (1.45 m) · 🌹 ROSE BOUQUET (1.45 m) ·
  💜 PURPLE BOUQUET (1.35 m) · 🪻 LAVENDER BOUQUET (1.45 m) ·
  🎈 BIRTHDAY BALLOONS (1.5 m, the tallest) · 🎈 BALLOONS (WALL-HUNG)
  (1.2 m single plane at wall height).
- **One engine, `buildPhotoStandee(ctx, spec)`:** crossed planes (the
  Minecraft-flower idiom) or a single wall plane; the white studio backdrop is
  keyed at load by a **border flood fill** — only background-CONNECTED
  near-white pixels turn transparent, so interior whites (white daisies, glass
  highlights, foil balloons) survive; +15 % brightness lift and the map doubles
  as a soft emissiveMap so photos stay vivid under dim room light; smooth
  filtering + mipmaps + max anisotropy keep fine print (balloon lettering)
  legible — NearestFilter shredded it (owner feedback "not clear").
- **Wall hanging via `zOff`:** decorative placement clamps the item ORIGIN to
  ≥1 m inside the walls, so the wall variant's plane reaches 0.95 m out of the
  origin — park the item on the lattice line nearest a wall, R-rotate, and the
  picture lands on the wall face (5 cm proud, no z-fighting).
- Adding another photo piece is now four small steps: drop a JPEG in
  `public/assets/`, one union entry, a two-line builder off the shared
  `PHOTO_DECOR` spec, one DEFS entry.
- Verified live: all six spawn, move, delete and sync; backgrounds key cleanly
  (glass vase reads as real transparency); the wall balloons hang on any of the
  four walls; missing-asset loads warn instead of failing silently; `tsc` clean.
- **Release line:** version bumped to 0.33.27, all nine locations. **Frontend-only —
  node binaries unchanged from v0.30.6.**

## v0.33.26 — 2026-07-22

### ⏏ UNDOCK a permanently docked module from the door panel

The missing inverse of PROVISION / INITIATE: the door panel can now **remove a
permanently docked module**. Until now only transient guest berths had a DETACH —
a provisioned or paired module was station-graph-permanent with no way back (the
POSITION row even said "unpair first" with no way to unpair).

- The docking panel's DOOR POLICY section gains a **🧩 DOCKED MODULE · <address>**
  row with an **⏏ UNDOCK** button whenever that door holds a live PERMANENT
  pairing. **Owner-only** — transient berths keep their own everyone-visible
  DETACH row, and the two rows are mutually exclusive by construction.
- **Two-click arm/confirm:** the first click flips the row to a red
  **⚠ REALLY UNDOCK? / ⏏ CONFIRM** state; only the second click executes. Arming
  never survives a pane re-open, and the handler re-checks the live pairing state
  before acting (a stale row click is a no-op).
- Undocking **deletes the door-pairing record** from the shared doors doc — the
  same reconcile path the transient DETACH uses (`clearRemotePairing`) tears down
  the projection and re-locks the door on every client. **The module's room doc
  survives on the node**: re-dock its address (KNOWN MODULES / MODULE LEDGER) to
  restore it, furniture intact.
- Verified live: a provisioned module's door shows the row; first click arms,
  second click detaches (projection gone, door re-locked, LED off green); the
  detached room re-docks by address; `tsc` clean.
- **Release line:** version bumped to 0.33.26, all nine locations. **Frontend-only —
  node binaries unchanged from v0.30.6.**

## v0.33.25 — 2026-07-22

### 🧭 Dev-menu guardrails — 🏠 GO HOME + a confirm on room templates

Two quality-of-life guards for the demo-phase DEV menu, both born from a live
play session that went sideways.

- **🏠 GO HOME (new NAVIGATION section):** one button that beams you back to your
  own home station — it drops the resume-at-last-location pointer AND reloads into
  a **clean URL** (query + hash stripped). The URL half matters: a lingering
  `?seed=` from an earlier link-visit outranks the home fallback in
  bootstrapNetworking (URL import → last-room → default), so a plain reload kept
  beaming a lost player right back into the foreign station they were escaping.
- **⚠ Room templates now confirm before replacing:** the one-click PLACE of a room
  template REPLACES every piece in the room, and one stray click wiped a furnished
  home. PLACE now arms for 3 s (red **⚠ REPLACE ROOM?**) and only a second click
  executes; the button restores itself on timeout.
- Verified live: GO HOME lands in the player's own home with a clean address bar;
  an armed PLACE reverts after 3 s untouched and executes on the second click;
  `tsc` clean.
- **Release line:** version bumped to 0.33.25, all nine locations. **Frontend-only —
  node binaries unchanged from v0.30.6.**

## v0.33.24 — 2026-07-22

### 🖱️ Right-click furniture — MOVE / DELETE context menu

Furniture management without the wall-computer ceremony: **right-click any movable
piece** — in the plain room view or in edit mode — and a small context menu offers
**✥ MOVE** and **🗑 DELETE**. Owner-gated like every other edit.

- **✥ MOVE** picks the piece up on the spot: from the plain view it silently enters
  edit mode, starts the standard carry (full placement validation — green/red tint,
  R rotates, click drops, Esc / right-click cancels back to the origin) and **leaves
  edit mode again once the drop lands or cancels**. From an already-open edit session
  the menu is a shortcut and the session stays open.
- **🗑 DELETE** runs the exact #53 remove-to-inventory path (despawn + deregister +
  rebake + shared-doc delete + stow in the room inventory — the DEV menu's INVENTORY
  re-places it), including the hull-stack cascade.
- **FIX: deleting a charging-dock now disposes its robot immediately.** The local
  removal self-echoes as an empty furniture-doc diff, so the observer's
  `reconcileRobots` never ran on the deleting client and a ghost robot lingered
  until the next full reconcile — the exact mirror of v0.33.21's commitSpawn dock
  fix, now applied to the remove path (cascade included).
- Boundaries: movable furniture only — doors keep their own panel/editor, fixed
  structure (wall computer) is excluded, robots follow their dock. A right-click on
  a mounted-stack base refuses MOVE with the usual unstack-first hint.
- Verified live: right-click menu opens on furniture in both views; MOVE follows the
  pointer and commits/cancels with auto exit; DELETE stows to inventory and a deleted
  dock takes its robot with it; menu dismisses on outside click / Esc; `tsc` clean.
- **Release line:** version bumped to 0.33.24, all nine locations. **Frontend-only —
  node binaries unchanged from v0.30.6.**

## v0.33.23 — 2026-07-21

### 🚪✏️ Place and remove doors in edit mode (#28 decouple, slice 6b — the door editor)

The payoff of the doors-from-docking decouple: you can now **add and remove doors** yourself, in edit mode — doors are furniture-like placeable passages at last.

- **＋ DOOR** enters a placement mode where a translucent door **ghost follows your cursor** along the nearest wall, snapping to the same floor grid furniture uses (small door on the half-tile, large on the tile). It's **green** where the spot is valid and **red** where it isn't (over furniture, or too close to a corner). Click on green to place the door — it appears for everyone and sits at the wall's edge.
- **Select a door** in edit mode (it tints gold) and **remove** it with the REMOVE button or the X / Delete key. A door with a live docked module is protected — you're asked to unpair it first, exactly like the slide control.
- Everything syncs (the room's door set rides the shared `doorLayout` map) and the four default cardinal doors are preserved when you add your first one.
- Under the hood this rests on slices 1–6a: one pose generator, the module-overlap guard (now a hard block), the door↔port seam, data-driven doors, the port-hardware/door-leaves split, and the live add/remove machinery.
- **Coming next (slice 6c):** drag an existing door along its wall to move it, reusing this same ghost.
- **Release line:** version bumped to 0.33.23, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.22 — 2026-07-21

### 🤖⏸ Park a robot with a STOP/START button (#77 follow-up)

The dock's robot console gains a big **STOP / START** toggle so you can park a robot when you don't want it active.

- **STOP** parks the robot: it walks back to its dock and stands on it, off — overriding whatever routine it's running (serve / croupier / custom). **START** releases it back to its routine.
- Parking is **independent of the routine** (a synced `parked` flag on the dock config), so it survives a routine change and syncs to everyone in the room, like the rest of the console.
- Verified live: setting a robot to parked walks it to its dock and stands it there (arrived within 0.1 m of the dock), and clearing it resumes the routine; `tsc` clean; no console errors. (The button itself sits in the dock's robot console alongside the routine buttons — owner-to-eyeball, as the console couldn't be opened in the test harness.)
- **Release line:** version bumped to 0.33.22, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.21 — 2026-07-21

### 🤖 Robots come only from placed docks (#77 follow-up)

Robots are now purely a docking-system thing — you place a **robot dock** and a robot appears on it; a room with no dock has no robot.

- **Removed the ambient robot** that every dock-less room used to show. Robots now spawn **only** from a placed charging-dock (one robot per dock). A room with no dock has no robot.
- **The dev menu now labels the dock `🤖 ROBOT DOCK`** (it was the unrecognizable `CHARGING-DOCK`) so it's findable — placing one is how you add a robot.
- **Fixed:** a dock placed from the dev menu now spawns its robot **immediately**. The furniture doc-echo reconcile no-ops on a locally-added piece, so the robot reconcile is now triggered explicitly on a local dock spawn (previously the robot only appeared after a re-entry — and was masked entirely by the ambient robot).
- Verified live: a fresh dock-less room shows no robot; the dev menu shows `🤖 ROBOT DOCK`; placing one spawns a robot on it right away (one robot per dock); no console errors.
- **Release line:** version bumped to 0.33.21, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.20 — 2026-07-21

### ⛔ Docking on top of another module is now blocked (#28 decouple, slice 6a)

The module-overlap guard graduates from a warning to a **hard stop** — the "prevent modules overlapping" system you asked for is now enforced.

- When you INITIATE a pairing whose connector chain would land the new module **on top of** an existing station module, the dock is **refused** with `Can't dock here — the module would overlap <module>. Re-route the connector chain to a clear berth.` — no pairing happens. The module you're actually connecting to (the berth at the chain's end) is still excluded, so only a genuine collision is blocked.
- It keys off the ports / atlas geometry (the same poses the exterior renders), never off doors — the decouple-clean split.
- Also hardened the earlier overlap *warning* so a future free-door keypad can't hit the cardinal-only pose helper (guarded to the 4 cardinal berths).
- Verified live: with an overlapping neighbour seeded, INITIATE shows the block alert, leaves the pairing uncommitted, and suppresses the connection callback; no false block when there's no collision; `tsc` clean; no console errors.
- **Release line:** version bumped to 0.33.20, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.19 — 2026-07-21

### 🚪➕➖ Doors can be added and removed live (#28 decouple, slice 5b)

The door count can finally **vary** — dropping a door into the synced map makes it appear for everyone; deleting it makes it disappear. This is the machinery the door editor drives next.

- **`syncDoorGroups`** reconciles the 3D door groups to the layout map on every change: builds a group for a new door, disposes the group (geometry + materials) and clears all its state for a removed one, and rebuilds one whose size changed. Wired into the door-layout reconcile after the walk-target rebuild.
- A **free door follows its own position**: a door placed on a wall at an along-wall offset renders exactly there (e.g. a door added on the east wall at lateral −3 appears off-centre on that wall) — the "module follows the door" model. Each free door gets its own docking state, so its LED / keypad / slide work like any door.
- Fixed two spots that assumed the fixed 4 cardinal doors and would have thrown on a free door (the walk-target rebuild and the slide re-derive now route a free door through its wall + position instead of the cardinal-only pose).
- Verified live: adding a free door to the map renders it at its wall + lateral with the full frame/leaves/hardware and its own state; removing it disposes the group and clears its state with no leak; the 4 cardinals stay bit-identical throughout; `tsc` clean; no console errors.
- **Next (slice 6):** the edit-mode editor — click a wall to add a door (snapped to the floor grid, like furniture), drag it along the wall, remove it — plus the overlap guard flipped to a hard BLOCK.
- **Release line:** version bumped to 0.33.19, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.18 — 2026-07-21

### 🚪 Build each door from a record — extraction for free doors (#28 decouple, slice 5a)

A behaviour-preserving refactor that makes the door-building code able to build *any* door (not just the fixed 4), setting up the add/remove of doors in the next slice.

- **`buildDoorGroup(record)`** is extracted from `buildPorts` so a single door can be built from a layout record. `buildPorts` now loops the 4 cardinal defaults and calls it — bit-identical, because the old loop variable is reconstructed so the body is unchanged.
- **`poseForDoor(id)`** centralises a door's world pose: a cardinal door routes through the legacy path exactly (preserving the east/west quirk + pairs layout); a future free door will derive from its wall + along-wall position (stashed on the group). The two per-frame / per-reconcile pose lookups (camera-facing fade, reposition) now go through it, so they won't assume a fixed cardinal.
- Each built door seeds its own docking state (so a future door's LED / keypad / slide work), and the id types are widened from the 4 cardinals to strings — all internal, no wire change.
- **Model note:** this is under the confirmed "a door is the object; docking is an add-on" model — no separate movable "port". The next slice (5b) adds the actual add/remove of doors from the synced map.
- Verified live: the app boots, all four doors render with bit-identical positions (pairs layout), the port-hardware/door-leaves split survives the extraction, every door's docking state is seeded, arrival routing + slide work, `tsc` clean, no console errors.
- **Release line:** version bumped to 0.33.18, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.17 — 2026-07-21

### 🚪🔩 Split each door into port-hardware vs door-leaves (#28 decouple, slice 4b)

Structural groundwork with **zero behaviour change**: every docking-port group is now split into two halves — the **port hardware** (keypad + status LED, one per berth) and the **door leaves** (frame, sliding panels, threshold, click box). This is the last piece before a door can be moved independently of its port.

- Both halves sit at the group origin under the unchanged top-level group, so every child's world transform — and thus render, slide, camera-facing fade, and raycast — is **bit-identical** to before. `isLarge` stays on the top group (the slide reads it non-recursively); every other accessor is recursive and finds its target through the new sub-groups.
- Why it matters next: in slice 5, a freely-placed door's *leaves* can slide/move while its *port hardware* stays anchored at the berth — now a one-line retarget instead of re-plumbing the whole group.
- Verified live: all four doors render identically (frames, lit seams, keypads, glow strips, faded camera-facing doors); the LED sits in `portHardware` and the leaves in `doorLeaves`; `leftLeaf`/`ledStatus`/`keypad`/all 5 `frameGlow` strips still resolve; opening a door slides its leaves correctly; `tsc` clean; no console errors.
- **Release line:** version bumped to 0.33.17, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.16 — 2026-07-21

### 🚪 Doors become data-driven (#28 decouple, slice 4a)

The set of doors a room has is now **synced state**, not a hardcoded constant — the foundation for adding/removing doors later. Behaviour is identical: still exactly the four cardinal doors, each over its port.

- **New `doorLayout` room-doc map** (id → `{wall, lateral, size, enabled}`), cloned from the proven furniture-sync pattern, seeded once per owned room from the current door set (idempotent, owner-gated). It's kept **deliberately separate** from the door-*pairing* map (`doorsDoc`) and the door-*position* store (`floorPlan`) — those still own docking and slide respectively and are untouched.
- **`DOORS` is reconciled from the map** instead of being a fixed literal: `rebuildDoors` mutates the door list in place as the map changes (add/remove membership), while position stays sourced from `floorPlan` and runtime `enabled` stays owned by the room (fireplace / casino). For the four-cardinal steady state this reconcile is a no-op, so nothing moves.
- **Un-migrated rooms keep the local defaults** — the reconcile early-returns on an empty map, so an old room with no `doorLayout` entry renders exactly as before. Wire format is unchanged (pairing map + atlas untouched).
- Verified: `tsc` clean; live — seeding the real doc's `doorLayout` map fires the reconcile and door behaviour (arrival routing, all four doors) stays identical, clearing it keeps the doors, the four doors render, no console errors.
- **Next (slice 4b):** make the 3D door-group build (`buildPorts`) source from the same map and split it into port-hardware vs door-leaves — the last step before doors can be freely placed.
- **Release line:** version bumped to 0.33.16, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.15 — 2026-07-21

### 🚪↔🛰️ The door→port seam + transit robustness (#28 decouple, slice 3)

Behaviour-preserving groundwork so a future free-door set can't break transit. Much of what this slice was scoped to do (splitting the module-mesh *pairing* onto the port) turned out to already be true in the codebase — the pairing lives in the synced door records + the docking state, both already keyed by the stable cardinal *port*, and the arrival router already prefers the arrival room's own back-pointing record. So this slice lands the two genuinely-missing pieces:

- **One door→port hop.** New `portForDoor(doorId)` (identity today) names the single place a door resolves to the docking **port** it serves. `getDockingState` now reads pairing/lock/transit through it, so when slice 5 makes it geometric (a free door aligning to a port), every pairing + transit read re-keys onto the correct port as a **single-function change** — no call-site churn.
- **No hardcoded cardinal in arrival routing.** The arrival resolver's last-ditch fallback no longer asserts a specific `east` door exists (it would crash once doors are freely placed). It keeps today's exact behaviour — canonical east fallback for the fireplace-blocked south departure — but degrades to *any enabled door → any door* instead of throwing when that cardinal is absent.
- Verified: `tsc` clean; live parity — arrival routing returns the same doors (opposite cardinals / east fallback), `getDockingState` resolves all four ports through the seam, a door walk-through runs with no error, no console errors.
- **Release line:** version bumped to 0.33.15, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.14 — 2026-07-21

### 🛰️ Warn before a new module docks on top of another (#28 decouple, slice 2)

The docking assembly gains the module-overlap guard you asked for — a system that detects when a new module would collide with an existing one. Advisory for now; it becomes a hard block with the door editor.

- **What it catches:** as you build a docking chain, if the module it would project lands on top of a **different** existing station module, the assembly strip shows a `⛔ would overlap <module>` warning. The module you're actually *connecting to* (the berth at the chain's end) is correctly excluded — only a genuine collision with a farther module (or the current room's own hull) warns.
- **How:** a new `moduleOverlapAt` in the station atlas composes the candidate module's footprint against every known module's pose (the same poses the exterior view renders) using an exact **Separating-Axis** test between the rotated square footprints — so the 45° ring modules judge correctly with no inflated-box false positives. It keys off the docking **ports / mesh geometry**, never off doors (a decouple-clean split).
- Verified: SAT unit test 18/18 (flush berths clear, real overlaps caught, rotation exact); an end-to-end test against the live atlas (connect-target skipped, real clash flagged, clear gap + origin-hull handled); and the warning renders correctly in the actual docking pane with no false positive in an empty room.
- **Known limit (noted for the S6 block):** modules are tested at the exterior view's uniform footprint; per-module true sizes for resized rooms would need the atlas to gossip room dimensions.
- **Release line:** version bumped to 0.33.14, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.13 — 2026-07-21

### 🚪↔🛰️ One pose generator for doors and docking ports (#28 decouple, slice 1)

Groundwork for making doors freely placeable (add/remove/move like furniture) while keeping the module-mesh intact: this splits the shared geometry into a single generator, with **zero behaviour change**.

- Today one cardinal id (`north`/`south`/`east`/`west`) is the join key for five things at once — door placement, walk geometry, 3D hardware, passage policy, **and** the module-mesh pairing. This slice extracts the pure geometry into one function, `poseFromWall(wall, centreLateral, standLateral?)`, that every door **and** docking port will derive its pose from.
- `physicalDoorPose` and the legacy/pairs layout tables are now expressed on top of that generator instead of hardcoded coordinate tables — proven **bit-for-bit identical** to the old tables by a golden test (420 comparisons across ids × layouts × slide deltas × room sizes, 0 mismatches). The legacy east/west −0.5 stand-offset quirk is preserved faithfully.
- Introduces the `PortId` type and a `physicalPortPose` alias to name the structural **docking-port** seam. Ports stay the 4 cardinal ids for now, so **no wire-format change** — later slices split the pairing/mesh (which keys off ports) from the free-door layer.
- No visible change: the exterior, room, and all four doors render exactly as before; `tsc` clean.
- **Release line:** version bumped to 0.33.13, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.12 — 2026-07-21

### 🛰️ Dev: jump into a fresh standalone room (#79 P3 groundwork)

Setting up the shared default station starts with authoring a fresh room you own — this adds the tool for that.

- **Dev menu → MODULES → 🛰️ NEW STATION · JUMP** provisions a **brand-new blank room that is NOT docked to your current one**, and beams you straight into it as its **owner** — so you can author it (drop a clone-vat, keep one door) and then **Copy Invite** to share its pass. It reuses the existing provision-a-module machinery (the room is claimed + seeded empty on entry) plus the beam-in transit, so it rides all the same proven paths.
- **Groundwork:** also lands `src/station.ts` — the (inert, unconfigured) shared-default-station identity module for #79 P3a. It's imported nowhere yet, so there is **zero behaviour change** until a station id/key/host-hint is baked in; it just documents the plan and reserves the slots.
- **Release line:** version bumped to 0.33.12, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.11 — 2026-07-21

### 🤖📝 Write your robot a custom script (#77 Phase C, slice 4 — Phase C complete)

The dock console gains a fourth routine — **Custom script** — with a little step editor, so a robot can do more than the presets: walk a route and talk.

- **A bounded step list the robot loops:** **Go to (x, z)** (it A\*-walks there), **Say "…"** (a speech bubble pops over its head), and **Wait N s**. Add / edit / remove steps in the console; up to 16 steps.
- **Synced + owner-only**, like the routine presets — the script rides the shared `robot` map, so every client's copy of the robot runs the same loop (a greeter that paces a lobby, a tour guide that stops and announces, a patroller with lines).
- **Safe:** every step is validated on read (a malformed peer write just falls back to Serve), and `say` text is escaped in the editor and rendered as plain text in the bubble.
- Verified live: a `go-to → say → wait` script walks the robot to the waypoint, pops its line, waits, and loops; the editor's add/edit/remove all persist.
- **This completes #77 Phase C** — robots are now placeable furniture (one per dock), programmable with routine presets *or* a custom script, they stow their tray off-duty, and they pathfind around the room.
- **Release line:** version bumped to 0.33.11, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.10 — 2026-07-21

### 🤖🖥️ Program the robot at its dock (#77 Phase C, slice 3)

Robots are now **programmable**. Walk up to a **charging dock** and click it to open its console — a short menu that decides what that dock's robot does:

- **Routine dropdown** — **Serve drinks** (patrol + serve + dock when idle), **Roulette croupier** (run a roulette table; wait at the dock when there's none), or **Idle at dock** (just wait). Behaviour is now *configured*, not guessed from what's in the room.
- **Owner-programmed, synced to everyone.** Only the room owner can set a routine (others see the console read-only); the choice writes to a shared `robot` map so every client runs that dock's robot identically. Change it and the robot switches behaviour live.
- **The croupier respects the program.** A dock robot set to *croupier* is preferred to run a live table; if none is set, a serving/ambient robot fills in so a default casino still has a dealer, and an *idle* robot never gets pulled to the wheel.
- **Next:** a custom-script editor (a bounded go-to / say / wait / operate step list) for robots that need more than a preset.
- **Release line:** version bumped to 0.33.10, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.9 — 2026-07-21

### 🤖🔌 Robots become furniture — one per charging dock (#77 Phase C, slice 2)

The service robot is no longer a single fixture baked into the room theme — it now belongs to a **charging dock you place**. Drop a charging dock and a robot spawns at it; place several and you get **several robots** (your "room of robot docks"); remove a dock and its robot is cleaned up.

- **One robot per placed charging dock**, each spawned at and bound to its own dock (it returns there to recharge when idle). Adding, moving, or removing a dock spawns / repositions / disposes exactly that robot, with no leaks.
- **Authored rooms keep their ambient waiter.** A room with no dock but a theme that wants a robot (lobby / pool / casino) still shows a single roaming waiter, exactly as before — so nothing regresses; docks simply give you *more* robots to place.
- **The croupier picks one robot.** When a roulette table is live, the nearest robot is elected (stickily) to run the wheel while the rest keep serving and docking — so a room can have a croupier *and* a drink waiter at the same time.
- **Groundwork for programming.** This is the lifecycle foundation for the next slices: a programming panel on the dock (choose a routine — serve / croupier / idle) and a custom-script editor.
- **Release line:** version bumped to 0.33.9, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.8 — 2026-07-21

### 🤖🧭 The robot puts its tray away and stops walking through the furniture (#77 Phase C, slice 1)

Two polish fixes to the service robot, ahead of the bigger "robots as placeable programmable furniture" work:

- **The drink tray is stowed when the robot isn't serving.** A robot standing at a roulette wheel as croupier, or parked on its charging dock, no longer holds a tray of cocktails — the tray only appears while it's patrolling/serving drinks.
- **The robot now routes around furniture.** Its walk (to a charging dock, to a roulette wheel-head, or along its patrol) follows an **A\*-pathfound route** through the room instead of a straight line, so it rounds tables and passes through door openings rather than clipping through them (closes the clip-through-tables gap flagged in the v0.33.7 review). If a target has no walkable route it falls back to a direct line, so the robot never freezes.
- **Release line:** version bumped to 0.33.8, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.7 — 2026-07-21

### 🎰🤖 The owner's robot runs the roulette table (#77 Phase B)

Drop a roulette table in your room and your service robot walks to the head of the wheel and **runs the game itself** — calling the bets, spinning, and paying out on a rhythm — so a table plays without anyone clicking a button.

- **A self-running betting cycle.** The moment the first chip lands, an **18 s "place your bets" countdown** arms (a live timer in the panel); then **"no more bets,"** the wheel spins, winners are paid, and the next round opens. A quiet table stays quiet — the clock only arms on a real bet, so nothing spins to an empty room.
- **The robot croupier is diegetic.** It leaves patrol/serving to stand at the reserved **wheel-head** slot (the one #76 keeps clear of players), faces the wheel, and speaks the calls — **"🎲 Place your bets!", "✋ No more bets!", "🎡 17 RED — winners paid!"** — as floating bubbles over its head, in sync for everyone in the room.
- **Exactly one operator, by construction.** Only the room's **deed holder** drives the timer, rolls the pocket, and credits winners — so a jointly-owned venture room can never double-pay. Venture / legacy shared rooms fall back to the **manual SPIN** control (unchanged), and a solo/offline room just works. A synced heartbeat tells every client when a live robot croupier is present (hiding the manual controls) versus not (showing them).
- **Safe teardown.** Deleting a table mid-round **refunds every outstanding stake** and clears its records — no vanished chips, no orphaned state. A stranded round (if the operator drops off mid-spin) self-heals when they return, and a returning house member can settle it manually.
- **Built on** the shared `casino` doc + the #76 stand slots + the #77 Phase A dock robot. Adversarially reviewed (7 findings, all addressed or scoped); a known cosmetic follow-up is the robot straight-lining to the wheel on room entry (it ignores collision, like the patrol/dock bots).
- **Release line:** version bumped to 0.33.7, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.33.6 — 2026-07-21

### 🎰 Walk to an open spot at a table (#76)

Clicking a gaming table now walks your avatar to an **open standing position on the table's ring** instead of always the same front — so a crowd naturally spreads around a roulette or game table rather than stacking on one square.

- **Nearest free + reachable slot.** Each table has a ring of authored standing slots (roulette: 6, one of them the reserved wheel-head; game table: its own set). A click routes you to the closest slot that is both **unoccupied** (no other avatar within 0.7 m) and **A\*-reachable** from where you stand; the operator's **wheel-head** slot is never auto-picked. You face the table on arrival.
- **Never worse than before.** If no ring slot is cleanly reachable — e.g. the table is jammed against a wall so its ring fronts fall on blocked cells — it falls back to the table's original single approach front, exactly the pre-#76 behaviour. Safe by construction.
- **Reachability judged from solid ground.** If you happen to be standing on a non-walkable cell (the clone-vat spawn cell is one), the path search now snaps its start to the nearest walkable cell first, so a genuinely reachable slot isn't spuriously dropped.
- **Completes the #76 slice** begun in v0.33.1 (the edit-mode standing-position rings — amber wheel-head + cyan open-slot markers shown while you move a table). Verified live: from walkable ground the avatar walks the ring and lands exactly on the picked slot.
- **Release line:** version bumped to 0.33.6, all nine locations. **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.43 — 2026-07-20

### 🌌 Make the indoors feel outdoors — real space through a glass ceiling

A room can now become an open-air **outdoor deck**: you look UP through real structural glass at the same space the station exterior shows, under bright warm light. Space-station-consistent — no fake Earth sky.

- **🪟 New `skylight` fixture** — a metal-framed glass ceiling panel (2×2 panes, faint transparent glazing) plus a warm flood light. Footprint-less (walk under it), spawnable, and its glass uses the morph-safe `baseOpacity` so it never snaps opaque.
- **🌌 Room `theme` system** — `applyRoomVisuals` now paints from a room's theme (`interior` / `casino` / `outdoor-deck`), resolved from `roomInfo` with a legacy fall-back so the authored rooms paint right at the first frame. An `outdoor-deck` un-hides the **real animated nebula + starfield + a new orbiting ocean-planet** and switches to warm, bright "beach daylight," via a single centralized backdrop toggle that self-cleans on leave — no space leaks into the lobby or casino.
- **🏝️ The outdoor pool room is now a space deck** — its old flat sky-blue is replaced by real space + ceiling skylights + the ocean-planet.
- **Composable** — pool templates carry skylights + the deck theme; a new **"Sky Deck"** template turns any provisioned module into an open-air terrace; provisioning stamps the theme so casino / pool / deck modules paint their FULL look (floor, walls, decor, lighting, backdrop — not a half-theme).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.43, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.42 — 2026-07-20

### 💡 A light for every room — four new ceiling fixtures, wired in

Building on the chandelier (v0.32.41), lighting-as-furniture now has a full palette, and the authored rooms carry their own hanging light.

- **Four new ceiling fixtures**, all footprint-less (walk under them) and cheap to render (they glow via emissive material, so each costs the renderer only one or two real lights):
  - **☀️ Sun-lamp** — a bright, cool-white skylight panel that floods a room with daylight-temperature light. For pools and bright venues placed in windowless modules.
  - **🎰 Neon ring** — a suspended cyan + magenta halo; casino/nightlife energy.
  - **🪔 Pendant lamp** — a modern metal dome with a warm glow; understated lounge light.
  - **🏮 Paper lantern** — a soft glowing warm globe; cozy and cheap.
- **The rooms come pre-lit now:**
  - The **Grand Lobby** gets a **chandelier** over the lounge. Existing lobbies gain it automatically via a one-time additive migration that leaves the rest of your furniture untouched — and it stays gone if you remove it.
  - The **Luxury Casino** gets a **neon ring** over the gaming floor (re-applied on entry with the rest of the casino layout).
  - The **Classic Lido pool** template carries a **sun-lamp**, so that pool reads as sunlit even in a dark module — while the live daylit outdoor pool is left exactly as it was.
- Every fixture is ordinary spawnable, movable furniture — mix and match from **DEV → FURNITURE**.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.42, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.41 — 2026-07-20

### 🕯️ Lighting you can hang — the chandelier furniture

- **A new `chandelier` furniture kind** — a two-tier gold fixture with glowing candle-bulbs and crystal drops that dangles from the ceiling and lights the room with a warm downlight. It's an ordinary placeable, movable furniture piece (spawn it from **DEV → FURNITURE → chandelier**), so a room's practical lighting becomes something you **compose and move** rather than a fixed room property — the first step toward templates that carry their own lighting.
- **Footprint-less** (you walk right under it) and cheap to render: the candle-bulbs and crystals GLOW via emissive material rather than being real lights, so the whole ornate fixture costs the renderer just **two lights** no matter how elaborate it looks.
- **Scope note:** a hanging fixture supplies the room's *practical* light; the sky/fog backdrop (day vs night) stays a scene-level concern, so a chandelier warms an interior but doesn't repaint an outdoor pool's horizon.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.41, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.40 — 2026-07-20

### 🏊 Classic Lido Pool — a second pool design (PR #70 revived)

- **A second pool template, "Classic Lido Pool" (pool-2)** — a faithful revival of the original #70 pool, rebuilt on the current code. Where the live "Infinity Pool Deck" (pool-1) centres the hot tub in the water with a bridge walk, the Classic Lido puts the **high-dive tower on the east rim**, a **standalone sculpted hot tub in the NW corner**, a red terrace bench, four green sun loungers by the south door, and red/yellow parasol cafés. Place it from the dev-menu ROOM TEMPLATES or the door-panel provisioning dropdown.
- Both pools **swim and dive correctly** — the classic pool ships its own east dive board + swim ring, and the swim "island" now tracks the live hot tub's position instead of a fixed spot, so the corner tub is handled right.
- A pool template dropped into **any** room now reveals its water (the solid floor hides wherever a pool is present, not only in the authored outdoor room).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.40, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.39 — 2026-07-20

### 🏗️ Provision a New Room From a Template (or Empty) at the Door Panel

- **When you provision a new module at the docking panel, pick what it starts as.** A dropdown now offers **Empty Room · Grand Lobby · Luxury Casino · Infinity Pool Deck** above the ➕ PROVISION NEW MODULE button. The freshly-minted room is born furnished with that template (its doors already in the matching paired layout), so a new casino or pool is one click instead of arranging every piece.
- **"Empty Room" is a real blank slate** — it seeds only the wall-computer (your in-world edit terminal), so the room is immediately editable and you build it up piece by piece with the furniture spawner. (This folds in the long-planned "new rooms start empty" idea as simply one of the choices.)
- The registry is variant-keyed (`casino-1`, `pool-1`, …), so more designs per type — a `casino-2`, a `pool-2` with the hot tub in the middle — slot in and show up in the dropdown automatically.
- Session note: the chosen template is remembered for the session; provisioning then entering the room seeds it. (Persisting the choice across a reload-before-first-entry is a small follow-up.)
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.39, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.38 — 2026-07-20

### 🏗️ Room Templates in the Dev Menu — one-click room presets

- **Place a whole designed room with one click** (dev menu → ROOM TEMPLATES). Three presets to start — **Grand Lobby**, **Luxury Casino**, and **Infinity Pool Deck** — each drops the full furniture layout AND switches the doors to the arrangement it was designed for, so the room reads correctly. The RollerCoaster-Tycoon idea: pick a ready-made room, or keep building piece-by-piece with the furniture spawner.
- **Built for variants.** The registry is keyed `casino-1`, `pool-1`, … so multiple designs per type (a `casino-2`, a `pool-2` with the hot tub in the middle of the pool, etc.) just slot in.
- **EXPORT** captures the current room's layout to the console as a paste-ready manifest — arrange a room by hand, export it, and promote it to a permanent template. That's how new variants get authored.
- Dev tool for now; the plan is to surface a **template dropdown when you provision a new room at the door panel** — where "Empty" becomes one of the choices (folding in the empty-by-default idea).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.38, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.37 — 2026-07-20

### 🧱 Room Fundamentals Derive From Size (Groundwork for Different-Sized Rooms)

- **Invisible by design — every room looks and plays exactly as before.** This rebuilds the room's spatial "fundamentals" so a room's size is no longer hardcoded to today's 12×12 square: the floor, the walls (including the lobby's new north wall), the outer hull, the walkable grid, furniture-placement limits, the player's and NPCs' movement bounds, corner markers and edge lights now all derive from the room's dimensions. Today's rooms are exactly a 2×2 block of 6-metre tiles, so every one of those reproduces the current numbers to the millimetre — verified byte-identical on a live room (walls at ±6, floor 12×12, and both the standard and the paired casino/lobby door layouts unchanged). This is the foundation for rooms of different rectangular sizes (any rectangle up to 30×30 m), tracked in #66.
- **The door system now derives its geometry from the room, in one place.** The door-layout module the casino, lobby and pool rooms already share had its poses hardcoded to a 12×12 room; they're now computed from the room size, so the same layouts — the standard four-sided one and the "paired" arrangement that groups doors on two walls — will work at any room size. Every existing room is bit-identical.
- **A latent bug fixed in passing:** a door could theoretically be slid off the end of a very short wall in a future small room; the slide limit now derives from that wall's actual length so it can't leave the wall.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.37 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.36 — 2026-07-20

### 🎰 Casino Room · 🌅 Lobby Overhaul · 🌉 Pool Rework

Three big room updates land together.

- **A new luxury casino room, connected to the lobby.** Red-and-gold decor with gold wall and door trim, four roulette tables, four game tables, two cashiers, and lounge seating you can sit in. Transparent sightline columns keep the room readable, and lush floral trellises (gold frames, layered vines, flowers and berries) run along the north and west wall tops. The room stays put across refreshes.
- **The lobby got a full overhaul, built live with the owner:**
  - **Doors paired on two walls** — the two camera-near door edges are now clear: those doors moved onto the north and west walls, grouped in pairs, so nothing blocks your sightline in. A new glassy pale-blue north wall frames them. (The outdoor pool keeps its classic four-sided doors.)
  - **A door-clear floor plan** — the old fireplace/bookcase wall, checker table and wall terminal are retired; the clone vat (your spawn tube), storage trunk, map table, bunk bed and armchairs are rearranged so nothing sits in front of any door, and the sofas gather into a face-to-face centre lounge. Existing rooms upgrade in place — older rooms that predate the clone vat get their spawn tube back.
  - **Morning light** — the lobby now wakes under a soft sunrise-blue sky and gold sun (the pool's daylight and the casino's night-lounge lighting are unchanged).
  - **Engraved wayfinding** — "POOL & HOT TUB" and "CASINO" are carved into the wall above their doors instead of floating on sticker plates.
- **Pool room rework:**
  - **Walk the bridge into the hot tub** — clicking the hot tub now walks the fox over the arched footbridge and hops it over the rim into the water, instead of the old slide that clipped through the bridge. Standing up reverses the trip, and clicking the tub actually works now (a click-priority fix stopped the pool's wade-in zones from swallowing tub and bridge clicks).
  - The **dive tower** moved to between the two north doors (board reaching south over the water), the decorative bar and east lookout tower are gone, and the parasol cafés are spread evenly along the east beach — all for a more open view.
- **🤖 A drink-service robot** now patrols both the lobby aisles and the pool deck: meet it face-to-face and it hands your fox a cocktail, lifted for a few visible sips before the empty glass vanishes.
- **Under the hood:** doors, docking, vestibules and exterior visuals route through one shared door-pose source (`doorLayout.ts`) with per-room door layouts.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.36 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.35 — 2026-07-20

### 🏊 Pool & Hot Tub Are Furniture Now

- **The pool and hot tub can be moved and removed like any other furniture** (owner request). In the outdoor Lido room's edit mode you can now select either one and pick it up, stow it, or clear it — they were locked room fixtures before. Both were already built as furniture pieces internally; this unlocks them and adds the supporting fixes so it's safe.
- **Removing the pool no longer leaves a hole in the room.** The pool's tiled deck used to double as the room's floor (the solid floor was hidden so the sunken water showed through). Now that the pool is removable, the room shows its own solid floor whenever no pool is present — take the pool out and you get a normal deck, not a void. Adding one back sinks the water in again.
- **Edits to the pool room persist.** That room used to re-stamp its whole layout from scratch on every visit, so any change reverted. It now seeds once (still migrating older casino-era rooms and fresh rooms) and then keeps your changes — a moved hot tub or a removed pool stays that way across re-entry.
- Neither piece can be accidentally mounted onto the ship's exterior hull anymore, and the pool's hand-authored water footprint is now correctly preserved (fixing a latent bug where its west-edge obstacle was silently dropped).
- **On the "adaptable to different sizes" idea:** I kept this release to the movable/removable conversion and its safety net, verified end to end. Reshaping the pool into a clean rectangular, resizable piece for future bigger rooms is a focused geometry rewrite (it touches the water, edges, swim seats, and dive tower, and wants proper visual checking) — I'd recommend it as its own next slice, ideally alongside the different-room-sizes work it serves. The pieces move and remove cleanly today; relocating the big infinity pool within its room still looks best at its home spot by design.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.35 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.34 — 2026-07-20

### 📜 Every Phone App Scrolls Now

- **Fixed: SpacePhone apps clipped their content instead of scrolling** (owner report: some VENTURES functionality was hidden below the fold with no way to reach it). Only ACCESS and CONTACTS had scrolling wired up; every other app (VENTURES, BANK, SETTINGS and its Network/Stats screens, the home grid) clipped once its content grew past the fixed phone screen. Scrolling is now enabled uniformly on the app-view layer, so a slim scrollbar appears automatically on **any** app whenever its content overflows — no app can hide functionality below the fold again, and future apps get it for free. The document apps also gained the same comfortable inset ACCESS/CONTACTS already had.
- Chat is unchanged and deliberately excepted: its message log keeps scrolling on its own while the input field stays pinned at the bottom (verified it can't be scrolled out of reach).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.34 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.33 — 2026-07-19

### 🤝 Accept an Offer Without Traveling to the Module

- **A deed offer can now be settled where the maker and receiver stand together** (owner request: an accepter may not be able to travel to the module). If you hold a deed offer for a module you can't easily reach, and you're in a room with the person who made it, the REDEEM preview shows **🤝 ASK [MAKER] TO HAND IT OVER**. The maker gets a request in their VENTURES app (**HAND-OVER REQUESTS**) and taps **HAND IT OVER** — their client reaches the module (it's their own; they use their own saved pass) and signs the deed to you, no need for either of you to be at the module. Instant-only, as chosen: if the maker doesn't keep a pass to that module in their room list, the request comes back "can't reach it from here" rather than silently waiting.
- **The deed is the ownership record** — after a co-present hand-over you own the module; ask the maker for a pass if you'd like to visit it. Personal transfers in v1 (accepting for a company still settles at the module).
- **Built and hardened carefully**, because this hands ownership across rooms. The request is **cryptographically signed** by the receiver — it proves they hold the key the deed will land on and binds the room + offer, so no one else present can redirect a hand-over or replay it elsewhere. The maker's client judges the module's **live owner from the network** (never a stale local copy) before signing it over, so a deed that already changed hands can't be handed over twice. An independent adversarial review of the first cut caught two serious holes (a third-party "confused deputy" redirect and a stale-cache double-spend); both were closed and re-reviewed clean before this shipped.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.33 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.32 — 2026-07-19

### 🚀 Accept an Offer for Your Company

- **You can now accept a deed offer on behalf of a venture you hold a stake in** (owner request). When an offer is made out openly (to you, or bearer — not already directed at a specific company), the REDEEM preview shows an **"accept as"** picker: take the module for **yourself**, or for **any venture you're a shareholder of and whose office you've visited**. Accepting for a company lands the module as that venture's property in the same step — the same one-paste result a maker-directed company offer already gave, now the *receiver's* choice too. A maker who directed the offer at a specific company still wins (their designation stands); share offers are unaffected (companies hold shares through their members).
- The gate is the same everywhere: only a shareholder who has actually seen the venture's cap table can accept for it, so a stranger can't file someone else's module under a company they don't belong to. Verified live — accept-for-company settles and writes the venture link, a non-shareholder venture is refused, and the picker's choice survives the phone's live repaints.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.32 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.31 — 2026-07-19

### 🔁 Two Tabs, One Truth — the Local Sync Gap Closes (+ dependency patch-up)

- **Fixed: a second browser tab on the same machine never received the room** (found while verifying v0.32.30's offers). The room-record exchange with the local node implemented only *half* the handshake — a tab asked the node what it was missing, but nothing ever asked the **tab** for *its* records, so after a node restart the node's copy stayed empty and every later tab's request was answered with nothing, forever. Each tab now pushes its full room records alongside the handshake (a standard, safely-mergeable update): the node's copy converges instantly, sibling tabs receive it through the existing fan-out, and the node's stay-behind serving copy (room durability) re-arms after every restart instead of only after live edits. Remote visitors were never affected — their requests are answered by the far side directly.
- **Proven with the real thing:** two tabs, two identities, one node — a transfer offer cut in one tab was pasted, verified, and redeemed in the other (deed changed hands live), then offered *back* and redeemed by the original owner. Both redemption records landed in the shared room records on both sides.
- **Dependency patch-up (Dependabot close-out):** the live line's dev tooling moved to **vite 6.4.3 / esbuild 0.25.12**, clearing a high-severity Windows dev-server path-check bypass and three medium advisories (build + dev server verified). The remaining 133 alerts were triaged and dismissed with reasons: 107 sit in frozen archived prototype folders whose dev servers are never run, and 26 are a Linux-only soundness note in the desktop shell's UI toolkit, pinned upstream until its next major migration.
- Also rides along: the transfer-offers design note joins `brainstorming/` (authored by a parallel design session).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.31 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.30 — 2026-07-19

### 📤 Transfer Offers, a Bar That Finally Moves, and Wake-Up Tanks

- **Transfer offers** (from the brainstorming design, reviewed and shipped): the current holder of a **deed or venture shares** signs a portable one-line offer — 📋 COPY it (or 💾 SAVE it as a file) and send it over any channel you like. The recipient pastes it into the VENTURES app's new **REDEEM AN OFFER** box, sees a verified preview (what, from whom, made out to whom, how long it's good), travels to the settlement spot — **the module for a deed, the registered office for shares** — and taps REDEEM. **No need to be online together, ever.** Offers are tamper-evident (any edit kills them), one-time (a redemption record at the module), made out to a chosen contact or venture by default (a leaked screenshot is useless) with an explicit ⚠ bearer option, good for 1/7/30 days at the maker's choice, and **die automatically** if the deed changes hands or the maker's shares run short — plus a ✗ REVOKE list standing at the asset. Four moves, one artifact: person→person and person→company deeds (the module lands as venture property in one paste), company→person (it leaves the company as it changes hands, with a warning when you cut such an offer), and person→person shares. All gifts in v1 — the format carries a price field, and redemption honestly says priced offers arrive with the Registry. Deed detail screens also gained a **TRANSFER HISTORY** — the module's own record of redeemed offers.
- **The bar moves now, for real** (owner report: bar, stools, and the pieces around it refused to move). The v0.32.11 "movable bar" shipped only half its migration — the doc-read override existed but the in-memory registry default stayed locked, and edit mode consults the registry. Flipped properly; the whole composite (counter, stools, bottles, shelves, pendant light) moves and stows **as one piece**, and it now carries a real 2×3 obstacle after being moved so clones can't walk through it. Its hand-authored default obstacle also survives doc round-trips now (a cross-room traveler and a fresh boot bake identical walkable floors).
- **Clone vats are placeable furniture with a purpose** (they already moved/stowed like furniture — now they DO something when clicked): walk up to a tank and its new panel offers **⭐ WAKE UP HERE** — your saved spawn point in that module, per device. And **arriving with a room pass now decants you from the room's tank** — both on a fresh pass link and on an in-session USE PASS beam — instead of materializing mid-room. Vat-less rooms keep the old mid-room arrival. (The default StarStation clone-room for brand-new players is a later slice, as discussed.)
- Hardened before release by adversarial review: hostile self-signed offers with malformed fields (a numeric venture name, a never-expires NaN date) die at verification instead of reaching the phone screens; a bad paste can't wedge the REDEEM box; share settlements move stock and burn the offer in one transaction.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.30 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.29 — 2026-07-19

### 🖱️🚪 Click the Tube, Take the Door

- **Clicking a vestibule now walks you through its door** (owner report: the small doors are fiddly click targets when clicking the floor to traverse them). The bellows tube attached to a door — and a full assembled connector chain alike — is one big click target: click anywhere on it from the room view and the player runs the *same* door walk-through the door itself triggers, one-way rules and all.
- **Floor clicks stay floor clicks.** The tubes are translucent and a near-side tube can visually overlap the room floor, so the new pass only claims clicks that land *outside* the walls — out where the tube actually lives. Verified live on the owner's real station: a tube click starts the walk-through, a mid-room floor click still walks to that exact spot, and in first person a click at a wall can't ray through it and door you by surprise (the pass is room-view only; first person keeps its free-look/point-and-click model untouched).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.29 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.28 — 2026-07-19

### 🔗 The Octagon Closes — Atlas Ring Fix (Field-Diagnosed by Visit)

- **Fixed the scattered-boxes station render** (owner report, with screenshot): the atlas walk inverted one arm of the ring — seven perfect 18.6 m hops and one **78 m chasm**, measured live. Root cause: door records written by a **manual INITIATE with the far-door dropdown left empty carry no `farDoor`**, and the pose math then falls back to "rotation = heading", flipping that arm's curvature. (Records from the 🧲 CONNECT flow always name the far door — which is why half the ring composed fine.)
- **The fix is reader-side and heals every existing station instantly**: when a record lacks `farDoor`, the atlas walk now **infers it from the far room's own record pointing back** — the graph already knows the answer. No stored data changes, no migration; every viewer of every station gets the closed ring on update.
- **Diagnosed by actually visiting**: this session joined the owner's live station **across the internet** with their pass (local node → iroh dial, connected on the first attempt), received the whole station through the v0.32.20 shared atlas as a first-time visitor, measured the broken ring on the real records, applied the fix, and re-measured: hops 18.6×7 + 19.1, orientations stepping a clean 45° — the octagon renders closed from space.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.28 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.27 — 2026-07-19

### 🚪↦ One-Way Doors — Turnstiles for the Station

- **Doors can be one-way now** (owner request): the keypad's PASSAGE setting cycles **PUBLIC (both ways) → PUBLIC · IN ONLY → PUBLIC · OUT ONLY → OWNER**. On an IN-only door, guests may only come *in* through it — their departures are refused at the door with a plain-language hint. On an OUT-only door, guests may only leave — a guest arriving through one walks in, gets the ⛔ hint, and is **walked right back out by the turnstile** (their return trip is exactly what OUT permits). **The owner passes both ways, always** — as do venture shareholders.
- Built on the existing seams: the departure gate is the same `canPass` check that walkthroughs *and* first-person auto-doors already consult (an IN-only door simply won't auto-open outward for a guest); the turnstile fires only after the arrival room's records have synced, and a one-shot guard means opposing one-way doors can bounce a traveler **at most once** — never a ping-pong.
- Verified live as a genuine non-owner: the full 4-state cycle round-trips the records, junk values are rejected by the sanitizer, and the real departure gate blocks IN-only, passes OUT-only/two-way, and blocks OWNER. The turnstile leg (cross-room arrival bounce) rides the battle-tested walkthrough machinery — give it a spin in the weekend's multi-machine tests.
- **Also in this release** (authored and 3-boot-verified by the clone-vat session; credited late — its hunks rode this commit): the 🧬 **boot ceremony's timing fix** — the vat spawn now arms by *seeing* the exterior boot view instead of betting on a fixed grace, so a slow join can never play the decant unseen behind the title; an 8s fallback keeps a clone from being held forever on boots that never reach space.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.27 in place, all nine locations). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.26 — 2026-07-19

### 📟 Stats Grow Up — Version, Disk Budget, and a Friendlier Default

- **The rotate-view arrows now truly wait for the room** (owner report: still visible pre-entry): the camera rig itself enforces the in-room gate every frame on top of the stylesheet rule, so no build or style-ordering quirk can leak them again. Verified riding a real boot end to end — never visible until ENTER ROOM.
- **Settings › Stats shows the installed version** (from a new in-app version constant that release bumps keep in step).
- **Settings › Stats shows this device's mesh storage**: live browser-store usage with a usage bar, plus a selectable **disk budget** (250 MB / 1 GB / 5 GB / Unlimited, default 1 GB). Honest scope: the number is what the browser reports for this device's room-record store, and the budget is advisory until a clean-up slice enforces it — the panel says so.
- **"Discoverable — friends may introduce me" now defaults to ON** (owner request): friend-of-friend introductions are the point of the mesh. An explicit opt-out is respected forever; only fresh installs (or never-touched toggles) change behavior.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.26 in place — including the new 9th version location, `src/version.ts`). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.25 — 2026-07-19

### 🤫 Silent Boot — No Toasts, No Buttons Until You're Home

- **The "LEVEL 3" toast no longer pops after the title fades** (owner request). The zoom indicator stays muted through the entire boot — the automatic flip to space AND the first ENTER ROOM descent — and unlocks only when you, already in the room, **manually zoom away** (out to space or into first person, where its controls hint matters). From then on it behaves as before.
- **The view-rotation arrows and degree chip wait for the room too**: hidden until your first ENTER ROOM (the same in-room marker as the phone tip), so the boot's space view shows exactly one thing — the ENTER ROOM bubble.
- Verified live: zero toast sightings sampled across the whole boot and descent; the toast fires (with the right text) only after a manual zoom-out from the room; the rotation HUD hides/shows strictly by the in-room marker.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.25 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.24 — 2026-07-19

### 🎬 First-Paint Polish — No Flash, No False Prompt

- **"👆 Click to Enter" is gone from the title screen** (owner request) — it stopped being true when the boot became automatic; a click merely skips the title dwell, and the screen no longer claims otherwise.
- **The title curtain is opaque from the very first paint.** The v0.32.22 solidifier ran from JS a few seconds after load, leaving a window where the frosted default leaked the assembling room — and the phone tip (which sits above the curtain) flashed briefly. Both gates moved into the stylesheet: the curtain ships opaque (blur removed), and **the SpacePhone tip is hidden by default**, revealed only by the first descent into the room and re-hidden whenever you return to space.
- Verified at first paint (hint hidden, curtain `rgb(2,5,16)` no-blur, tip hidden before any script ran) and through the full loop: space → hidden, first ENTER ROOM → visible on the stowed phone, zoom back to space → hidden again.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.24 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.23 — 2026-07-19

### 🧹 HUD Declutter — Space View Breathes, the Tip Knows Its Place

- **The "🛰️ EXTERIOR VIEW · click a bellows joint to bend it" bubble is gone** (owner request). The bar now appears only when it has something real to say: the owner's ☀️ ADD SOLAR PANEL button, or a transient click-to-connect message when you click a module from space (auto-clears after a few seconds).
- **The "Press TAB to activate SpacePhone" tip waits for the room**: hidden through the title screen and the whole station space view, it appears only once you ENTER ROOM — and it now sits where it belongs, **perched just above the stowed phone at the bottom of the screen** instead of floating mid-air. (It remains a one-time hint: once you've opened the phone it never returns.)
- Verified through all three boot phases live: hidden at title, hidden in the space view, visible in-room at the stowed-phone anchor (bottom 52px · right 40px); the exterior bar shows no bubble text and stays empty for non-owners.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.23 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.22 — 2026-07-19

### 🎬 Boot Polish — a Truly Solid Curtain

- **The title screen's backdrop is fully opaque now** (owner request): the frosted glass used to let the room module show through while it assembled behind the StarStation Furlong title. The curtain solidifies (same deep-space hue) the instant the auto-boot starts, so **nothing of the room is visible until the fade reveals the station from space** — the module first appears only when you ENTER ROOM from the station view.
- Verified: the backdrop samples fully opaque from the first frame through the entire boot (no translucent frame ever), and the sequence still lands on the rotating space view with the ENTER ROOM bubble.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.22 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.21 — 2026-07-19

### 🚶 First-Person Clicks — the Floor Is a Mode Toggle Now

- **In first person, clicking bare floor no longer walks you** (owner request) — WASD is how you move. Instead, a floor click **cycles you back into free look** (mouse look, cursor hidden), completing the loop: free look → click frees the cursor → point-and-click at items → click bare floor → free look again.
- Items stay fully clickable in point-and-click mode: **seats and bunks** walk-and-sit you exactly as before, **doors and keypads** keep their priority, and **clicking a device** still walks you over beside it (the in-FP device screen hand-off remains a future slice).
- Room view (zoom level 2) is untouched — click-to-walk works there as always.
- Verified live through the real click pipeline: level-2 floor click walks (regression guard); level-1 bare-floor click requests pointer lock and moves the player zero units; level-1 sofa click walked 7.4 units and seated the clone.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.21 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.20 — 2026-07-19

### 🗺️ The Station Shares Its Own Map + 🎬 A Real Opening Shot

- **🗺️ Shared station atlas** (owner request): each room's doc now carries the station's layout, two-way merged with every visitor's personal atlas — so the map every regular has walked flows into the doc, and **a first-time visitor renders the ENTIRE station from space the moment their first join syncs**, before docking anywhere. One visit to any room shows the whole octagon.
- **Layout is public, admission is not**: gossip carries geometry and names only — **passes never travel between rooms**. A room's own entry shares its pass only while a door's passage policy is public (its own doc exposes those doors anyway), and locally-earned passes are never erased by the shared map.
- **🎬 The opening is cinematic now**: no Start press. The title holds while — underneath — the station assembles and the mesh sync begins; then it fades **straight into the station seen from space**, slowly rotating (one revolution ≈ 5 minutes, driven through the camera rig so the 45° view arrows still work and re-snap on entry), with ENTER ROOM as the first click. The old flash of the interior before the space view is gone. A click during the title skips the wait — but never outruns the space view.
- Verified: full boot timeline captured (overlay holds until the exterior is live; interior never visible), drift exact through the rig (12.03°/10s, radius stable), and the atlas doc round-trip — own-room seed rides when public, other rooms' seeds stripped at both levels, graph intact, no-churn re-push, fresh visitor renders the whole station from the doc alone.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.20 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.19 — 2026-07-19

### 🛰️ EDIT HULL — the Outside Is a Click Away

- **The room console grew an EDIT HULL 🛰️ button** beside EDIT ROOM ✎ (owner request: "I don't see how to edit the outside"). Press it and the same edit mode opens with the **camera pulled back and the walls dropped**, so the hull margin all around the module is visible and clickable — drag tanks onto walls, stack layers, mount engines, remove pieces, exactly like interior furniture. DONE EDITING (or ESC) puts the camera and walls back.
- Both buttons share the owner-equivalence gate (venture shareholders included). The hull hint spells out the stacking rules as you enter.
- Verified: both buttons render and gate together; hull scope pulls the ortho camera to 0.52× and keeps walls hidden through live frames; exit restores zoom exactly and re-applies the wall-section coverage rules.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.19 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.18 — 2026-07-19

### 🛰️ Hull Space Unified — Stack Your Tanks, Mount Your Engines

- **One system now owns everything outside the walls** (new `hull.ts`): exterior mounts, the doors' docking envelopes, and vestibule chains all share one geometry-and-occupancy authority. Two honesty wins land immediately: **a mount can never be placed through a built vestibule chain**, and the keypad's assembly strip **warns when a chain would sweep through mounted equipment** ("⚠ chain sweeps through mounted equipment — bend around it or move the mount").
- **⛽ Fuel tanks go dual-mode**: place them on the interior floor as before, or drag one past a wall in edit mode and it mounts on the hull.
- **🥞 Stackable hull layers** (owner request): a tank on the wall offers its outer face — mount another tank on it, then an **engine on the outermost tank**. Stacks cap at 3 layers, children sit centred (no overhang), engines are always outermost (clear exhaust), and edit-mode carry snaps to walls *and* stack faces alike. **Removing a layer cascades**: everything mounted outboard of it goes to the room inventory — no floating equipment. A stack base with cargo on it refuses to move ("unstack first").
- **The space view shows the truth now**: exterior equipment renders from its real builders at its real poses — the stack you built is the stack you see from space — and the old fake "fittings dress" (phantom bells and saddle tanks conjured from interior items) is retired.
- Synced like all furniture (each layer is a room-doc record with its mount base id; LWW-safe); the helm's spaceworthiness checklist counts engines and tanks wherever they sit. `effectiveWallExtent()` is exposed for the jetbridge solver to respect deep stacks (wired in a future slice).
- Verified: 12/12 hull unit cases (wall/stack/door-band/overlap/face-taken/depth-cap/cascade-order/chain-block/extent), stack round-trips through the sync reconcile, 3-layer stack renders in-room and from space, zero legacy dress meshes remain.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.18 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.17 — 2026-07-19

### 🚀 Exterior Wall Mounts — Engines on the Hull

- **🚀 Exterior wall mounts** — furniture can hang on the OUTSIDE of the hull now (new mount placement mode: wall snapping, door-band guard, edit-mode carry); the engine module became a proper **5-bell main thrust array** out there — mount plate flat against the hull, flared nozzles pointing away from the room, orange feed lines and a warm idle glow in every throat.
- Placement stays honest: exterior items snap to the outer wall lattice with a wall-derived orientation (no free rotation — a hint explains why), keep clear of every door's docking envelope, and never obstruct the interior. Edit-mode carry slides them along the walls; DEV spawn finds the nearest free hull spot.
- This is the shared mechanism for what's ahead — solar panels and the manipulator arm just tag the same mount mode. Legacy engine records at interior positions self-heal when picked up in edit mode (the carry snaps them to a wall).
- The helm's spaceworthiness checklist still counts these engines (capability tags unchanged).
- Built and browser-verified by its session (hull mount + snap + door-band clearance + doc reconcile, test records cleaned up).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.17 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.16 — 2026-07-19

### 🧬 Clone Vat — Spawning Is Diegetic

- **🧬 Clone vat** — the spawn point is diegetic now: new clones decant from a draining vat (drain → glass spins open → walk out), with a DEV respawn hook for the future death flow. The tank sits in the room's north-west pocket (a fresh green-lit cloning cylinder, concept-art styled), plays its ceremony at boot after the exterior fly-in, and `World.respawnAtVat()` is the entry point death will use later. Legacy rooms without a vat keep the old mid-room spawn.
- No wire changes — the ceremony is client-local; peers simply see the clone appear at the vat and walk out.
- Built and browser-verified end-to-end by its session (boot hold → reveal → drain → door spin → walk-out → close-and-refill; DEV RESPAWN re-runs it). The owner's home room doc was migrated with the vat at the designed spot.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.16 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.15 — 2026-07-19

### 🪙 Chips Go Physical — Count Them

- **Casino chips are physical now (owner rule)**: outside the cashier, no screen ever shows a chip TOTAL. Your rack at the roulette table is a tray of actual chip stacks — standard casino colors (1 white · 5 red · 25 green · 100 black · 500 purple · 1000 orange), stacks of ten, edge stripes, the face value printed under each denomination — you **count them** to know what you hold. Buy-in and the wheel don't change; only the accounting moved from a number to your eyes.
- **The felt shows the real chips as placed**: every bet is one physical chip of its denomination, stacked in placement order — yours bright, other players' dimmed beside them. The old numbered marker is gone. Wins arrive as a **YOUR WIN tray of chips**, not a figure.
- **The BANK app** shows your chips as countable discs (no total). **The CASHIER is the one place the number exists** — balance, the cage ledger, and cash-out, plus the same physical tray beside the figure so the counting stays honest.
- Accuracy is guaranteed by one renderer (`chipDisplay.ts`): the drawn chips always sum EXACTLY to the balance (decomposition verified across 519 balances), and felt stacks are the literal bet records.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.15 in place). **Frontend-only — node binaries unchanged from v0.30.6.** (Also rides along: the 💬 quick-chat peek rework committed on the branch — the Enter-key chat bar now peeks the REAL phone.)

## v0.32.14 — 2026-07-19

### 🛏️ Bunk Beds — Sleep Berths

- **🛏️ Bunk beds** — two lie-down sleep berths (new 'sleep' rig pose, elevated top bunk, synced to peers via tick flags bits 2/3). Click a berth to climb in: the avatar lies down, eyes closed — bottom bunk or the ladder-end top bunk — and peers see the sleeping pose at the right height. Stand up (or walk) to climb out; the bed sits flush in the room's north-east nook and a fresh one is buildable like any furniture.
- **Wire note (additive)**: the tick byte layout is unchanged — two previously reserved flag bits now carry lying/elevated. Old clients interoperate fine and simply render a sleeping peer as a floor-level chair-sit; run matching versions on all machines for correct sleep-pose rendering.
- Built and verified by the bunk-bed session (both berths exercised live: lie-down, top-bunk elevation, climb-down, normal sits after).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.14 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.13 — 2026-07-18

### 🎰 The Casino Opens — Cashier Chips + Roulette (#69 G1/G2)

- **🎰 CASHIER ATM** (new buildable fixture): walk up for **CHIPS** — buy in (+25/+100/+500), cash out, and read **THE CAGE**, a fully public ledger: chips issued, returned, on the floor, house net, and every player's balance. The house keeps no hidden book — every number is derived from the public records, so issuance can't be quietly inflated. (Test network: the cage advances chips against your Account; real Chia buy-ins arrive with the Registry cashier — #69 G4.)
- **🎡 ROULETTE** (new buildable table): single-zero wheel, the classic felt — straight numbers 35:1, dozens & columns 2:1, red/black · odd/even · 1–18/19–36 1:1 — chip denominations 1/5/25/100, undo/clear, live per-player "on the felt" totals. **House-banked**: the croupier (the room's owner side — in a venture-owned room, every shareholder) presses SPIN; one settle write carries the result and payouts to every client, and the wheel animation lands on the honest pocket. Fair-spin (commit-reveal) is the #69 G5 upgrade and the panel says so.
- **BANK app** shows the chips you hold in the room you're standing in (chips stay with their casino).
- Chips, bets and table state are room-doc records in plain language (chips · cashier · the cage — never chain jargon), shaped so the Registry-anchored chip upgrade slots in without changing a single screen.
- Fixed a latent exterior-view guard: it claimed clicks on ANY canvas while the space view was active — now only the game canvas — so device panes with canvases of their own (game boards, the roulette felt) can never be strangled by it.
- Verified: 22/22 payout engine cases; full table loop live (buy-in 200 → three felt bets → SPIN landed 5 RED → payout 25 credited to the chip → NEW ROUND); cage arithmetic; chips persist across reload.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.13 in place). **Frontend-only — node binaries unchanged from v0.30.6.** (Also rides along: v0.32.12's readable-text fix for the VENTURES + BANK apps, committed on the branch after that tag.)

## v0.32.12 — 2026-07-18

### 🏠 Real Estate — Deeds in the Ventures App

- **The VENTURES app grew a REAL ESTATE section**: every module you personally own lists there as a **deed** (and mirrors into the BANK app's new PROPERTY block). Like the station atlas and the venture ledger, the list builds by visitation — and since you can only ever have *become* an owner while standing in a room, it's complete in practice.
- **Deed detail screen**: each deed shows its venture assignment (registered office / venture property / held outright) and docked links, with plain-language copy throughout.
- **Hand over a deed**: transfer a module's ownership to another player — **in person, at the module** (the same rule as share trades at the office: one doc at a time). Recipient is picked from the room's keyed player records, with a two-tap ⚠ CONFIRM guard. Passes, door policies, co-hosts and a venture property link ride along to the new owner; a venture's **registered office refuses hand-over** (the Charter holds that deed — transfer shares instead).
- Venture PROPERTY lists now show real module names (from your atlas) instead of bare ids.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.12 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.11 — 2026-07-18

### 🧱🪟 Movable Bar + Modular Walls & Windows

- **The bar is furniture now** — grab it in edit mode, move it, or stow it like anything else. Its three stools are part of the bar build and ride along with it (splitting them into separate chairs can come later).
- **New buildable wall sections**: a 🧱 **brick wall** and a 🪟 **window wall** (Development menu → spawn). The window wall has real glass — place it on a side-wall line and you **look out through it**: at the stars, at neighboring modules, and at the new ambient planet drifting outside the room.
- **Walls swap out**: placing a wall section along the room's built-in side wall *replaces* that structural wall (it hides while your section covers the line, and returns if you move the section away) — the first step toward fully modular room shells. The complete conversion of all structural walls to placeable sections lands with the floor-plan generation refactor (#66 S2).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.11 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.10 — 2026-07-18

### 🚪 Small-Door Clicks Always Work Now

- Fixed the "sometimes clicking a small door does nothing" bug: the small doors' walk-up spots sit in the furniture-heavy middle of the room, and when furniture covered the spot the walk silently gave up. Now the avatar **retargets to the nearest clear spot beside the doorway** and walks; if the doorway is truly walled in, you get a hint ("The doorway is blocked by furniture") instead of silence.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.10 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.9 — 2026-07-18

### 🛬 Jetbridge Vestibules — Chains Fit Reality

- **Vestibule chains now solve themselves to fit** — like an airport jetbridge. When the 🧲 contact prompt matches a real module, the chain's bends relax to the *actual* angle needed (a 45° preset becomes 40° if that's the truth), **bends equalize across the chain** (your domino effect), and **extensions telescope** (±0.6 m of slide) when the module sits a little nearer or farther. The prompt shows the fit — *"auto-fit 20.1°/24.2°"* — and CONNECT builds exactly that.
- Bend detents (7.5° steps) remain for hand-editing; solved chains carry precise angles and sync to everyone as built. If a fit is genuinely out of range, the prompt says so and connects rigid as before.
- Ready for the custom-sized modules ahead: whatever shape the station takes, the tubes reach.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.9 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.8 — 2026-07-18

### 🧲 The Chain Finds the Door

- **Build a vestibule toward a module and the keypad notices**: as you add and bend chain pieces, the game folds the chain, checks whether its far end has reached a known module's door, and offers the connection right there — *"🧲 CHAIN REACHES Octagon 1 — connect via its WEST door? [CONNECT]"*. One press fills the address and far door and initiates the pairing. The prompt appears and disappears live as you edit the chain.
- Closing the octagon is now: stand in room 8, arm the ring preset, open the east keypad — the prefilled chain immediately reaches room 1 — press CONNECT. (Verified: the ring geometry closes to exactly 0.00 m.)
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.8 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.7 — 2026-07-18

### 🔗 Doors Arrive Where They Should + Pick-a-Module

- **Fixed wrong-door arrivals** (the broken center-hub links): walking a connection now lands you at **the far room's door that actually points back at where you came from** — the far room's own records are the source of truth, so links stay correct no matter what else gets connected or changed on either side. Stale geometry data can't misroute you anymore, and the automatic return-link always lands on the right door.
- **Closing the ring is one dropdown now**: the keypad's address box has a **🗺️ "pick a KNOWN MODULE"** menu listing every module your atlas knows — pick "Octagon 1" while standing in room 8, INITIATE, done. (Clicking modules from space still works too.)
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.7 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.6 — 2026-07-18

### 🔧 The Station Atlas Actually Learns Now

- Fixed the follow-up from the octagon report: the atlas was parsing **the wrong pass format** (a test-fixture format instead of the real base64 passes), so it could never link modules together — the exterior stayed stuck at direct neighbors. It now decodes real passes (raw or URL-wrapped), verified against a full synthetic octagon rendering as a closed ring.
- **After updating: walk your octagon once** (each room you enter re-records its connections correctly) and the whole ring appears from space, ready for click-to-connect.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.6 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.5 — 2026-07-18

### 🔧 The Vestibule Pills Are Back On Top

- Fixed the keypad regression from the permissions work: the **CONNECTION ASSEMBLY chips** (the FLEX/EXT pills where you cycle bend angles) had been pushed below the fold by the DOOR POLICY block — they looked gone, but were just buried. Assembly is back at the top of the keypad where it belongs, and the policy controls now live in a **collapsed ⚙ DOOR POLICY · RIGHTS · POSITION section** at the bottom — one click to open, never in the way.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.5 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.4 — 2026-07-18

### 🗺️ See the Whole Station + Click-to-Connect (octagon findings)

- **The exterior view now shows every module you've visited** — not just the neighbors of the room you're in. Your client keeps a personal station atlas (each room you enter contributes its name, address, and connections), and the space view walks the whole graph with true chain geometry — **the octagon renders as a complete closed ring**. The camera automatically pulls back to frame however big your station has grown.
- **Closing the ring is now a click**: open the door keypad in room 8, zoom out to space, **click room 1** — its address drops straight into the keypad ("address filled — zoom in and INITIATE"). Keypads dock to the left edge while you're in space so the station stays visible. Modules you haven't visited yet say so ("visit it once").
- Also answered ([#62](https://github.com/Bella-Addormentata/StarStationFurlong/issues/62)): module *ownership* belongs on the Chia Registry (the deed architecture); connection *topology* stays in room records — the atlas is your local view of it.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.4 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.3 — 2026-07-18

### 🚀 Ship Fittings (#30 SH1) — your module starts becoming a ship

- **Three new fittings** (DEV menu stocks them; place in edit mode): the 🛢 **FUEL TANK**, the ⚙ **ENGINE BLOCK** (glowing reactor core), and the 🎛 **HELM CONSOLE**. Walk up to the helm and it opens a **pre-flight checklist**: engines, fuel, helm, hull — and a verdict: *ALL SYSTEMS FITTED — this module is spaceworthy* (or what's missing). Flight controls arrive with the flight update; the helm says so honestly.
- **The hull shows it**: fit engines and tanks inside, then zoom out — **engine bells appear on the aft face and saddle tanks on the roof**. Your module visibly transforms as you outfit it, exactly the #30 fantasy.
- Also landed: the full **module→spaceship sliced plan** ([`brainstorming/spaceship-conversion-plan.md`](brainstorming/spaceship-conversion-plan.md)) — flight will be *a record, not a simulation* (everyone aboard travels together because the ship IS the room), chained modules can't fly by construction, and undock/redock rides the #67 berthing already shipped. Next: SH2 fuel truth, SH3 first flight.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.3 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.2 — 2026-07-18

### 🏘 Ventures Own Multiple Modules (#68 V2)

- **A venture can own the whole neighborhood now.** In any module you personally own, the VENTURES app offers **🏘 ADD THIS MODULE TO \<venture\>** — it becomes venture property, and **every shareholder gets full co-owner access there** (docking, editing, policies — same as the office). The property room's personal owner can ⏏ DETACH it any time.
- The **registered office stays the source of truth**: share transfers happen only there; property rooms carry a snapshot that **refreshes as shareholders come and go** (whoever saw the office most recently brings the news — very frontier-town, and exactly how a P2P station should work).
- Perfect for the weekend test: found a venture, hand your friends shares at the office, add your other modules, and everyone co-owns the lot.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.2 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.1 — 2026-07-18

### 🧱 Doors Slide Now (#66 S1)

- **Move your doors.** Every door keypad has a 🧱 POSITION row (owner-only): ◀ ▶ slide the door along its wall in 0.5 m steps. Everything follows — the frame and keypad, where you walk to enter, the first-person auto-open doorway, future vestibule connections, even the adapter collar in the exterior view. Everyone in the room sees the door move live.
- A **paired** door won't slide ("unpair first") — connections never warp. Positions are shared room truth on the new floor-plan record, which also quietly lays the foundation for #66's next act: **growing your room one hull tile at a time**.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.1 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.32.0 — 2026-07-18

### ♟ Chess + 🏦 A Real Bank

- **Chess is on the game table** — full rules: castling, en passant, promotion (auto-queen), check warnings, checkmate and stalemate. The board face now opens with a **game menu** (♟ CHESS / ⛀ CHECKERS — anyone picks, first two SIT), pieces show where they can move on your turn, the last move glows, a threatened king flares red, and VS BOT works for solo play. RESET clears the table back to the menu so you can switch games. Everything syncs through the room — spectators see the game live.
- **BANK is a real app now**: your ACCOUNT card (name + account key for receiving shares), your PORTFOLIO (venture stakes, live), and an honest Registry section — no fake balances; Chia numbers appear when the node's account service lands.
- Issues housekeeping: [#25](https://github.com/Bella-Addormentata/StarStationFurlong/issues/25) closed into [#66](https://github.com/Bella-Addormentata/StarStationFurlong/issues/66)/[#30](https://github.com/Bella-Addormentata/StarStationFurlong/issues/30). Still to come on [#45](https://github.com/Bella-Addormentata/StarStationFurlong/issues/45): war, two-player poker, and solitaire on the card felt, then chia-gaming wagers.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.32.0 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.5 — 2026-07-18

### 🚶 Automatic Doors in First Person

- **Walk through doors like it's a space station.** In first person, approaching a passable docked door slides it open automatically; keep walking into the doorway and you're carried through into the next room. Doors close behind you when you step away. All the rules still apply — hearth-blocked, owner-restricted (passage policy), and locked doors don't open, and there's a grace period on arrival so you don't bounce straight back.
- Also landed: the **shared-ownership architecture doc** ([`brainstorming/chia-ventures-shared-ownership.md`](brainstorming/chia-ventures-shared-ownership.md)) — how VENTURES anchor to the Registry later (vault-custodied deeds, provably fixed share supplies, holder proofs, offers as the market). The v0.31.4 in-game ventures are the exact off-chain first phase it prescribes.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.5 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.4 — 2026-07-18

### 🚀 VENTURES — Joint Ownership (#68 V1)

- **Found a space company.** New 🚀 VENTURES phone app: in a module you own, **sign a Charter** — the module becomes the venture's registered office, and 100 shares are issued to you. **Transfer shares** to other players from the app (paste their key from CONTACTS), and the cap table updates for everyone.
- **Any share = full co-ownership**: every shareholder gets owner-equivalent access to venture property — docking, edit mode, door policies, co-hosts, all of it. A shared clubhouse actually shared.
- The app: list screen (your stakes — name, SOLE/JOINT, %) → detail screen (the Charter, OWNERS with percentages, PROPERTY, transfers). Everything in plain language — deeds, charters, shares; no crypto jargon anywhere.
- v1 scope: a venture owns its founding module; multi-module property and the on-Registry Charter (real tradeable shares + the trading floor) are the next slices on [#68](https://github.com/Bella-Addormentata/StarStationFurlong/issues/68).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.4 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.3 — 2026-07-18

### 🤝 Co-Hosts (durability C1)

- **Rooms can have co-hosts now.** In the phone's ACCESS app, members tap **🤝 VOLUNTEER AS CO-HOST** (withdrawable); the owner sees pending volunteers there and ACCEPTs into a **standing, revocable designation** tied to the member's cryptographic identity (it survives leaving and rejoining).
- v1 is designation only — the shared record that upcoming slices build on: co-host **nodes keeping your room alive while you're away** (the next node update), co-host addresses riding room passes, and signed authority chains. Co-hosts don't gain owner powers.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.3 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.2 — 2026-07-18

### 🔌 The Docking Adapter (#67 D2)

- **Guest ships can park now.** The owner installs a **Docking Adapter** at a door (a new station part — DEV menu grants it; INSTALL from the keypad's DOOR POLICY section, REMOVE refunds). At an adapter door, **anyone** may berth their ship module without construction rights: the keypad shows 🔌 BERTHING OPEN, and INITIATE creates a **transient** pairing — no vestibule chains allowed, no permanent station structure.
- **⏏ DETACH belongs to both sides**: a live berth shows a detach button to everyone — the visitor casts off when they leave, or the owner clears the port. No approval ceremony either way. Owner-built connections are untouched — those remain permanent structure.
- **The IDA collar in space**: from the exterior view, adapter doors wear the docking collar from the art reference — white soft-goods ring, black capture latches, silver guide rings, equipment crate, blue truss struts.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.2 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.1 — 2026-07-18

### 🚪 Boot Into Space (#65 complete)

- **The game now opens in the exterior view**: after the welcome click, you arrive in space — your module's hull with the planet below — and a bobbing **🚪 ENTER ROOM** bubble over the dome drops you inside. `-` from the room takes you back out any time.
- Fixed in passing: the exterior view's click capture was swallowing every UI click at level 3 (phone, dev menu, its own toolbar) — it now claims only clicks on the game canvas.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.1 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.31.0 — 2026-07-18

### 🛰️ The Outside-the-Station View

- **Zoom out once from the room view and you're in space.** Level 3 is now a real 3D exterior: your module wears a hull shell (roof plating, observation dome, antennas, comms dish), the **planet hangs below**, and every paired connector chain + neighboring module stays visible at its true angle — your station, seen from outside, exactly like the concept art. (Reaching level 3 currently uses the `-` key with `?devzoom=1`; the default-on zoom path and the boot-into-exterior "enter room" bubble are #65's next step.)
- **Click a bellows joint to bend it**: a floating BEND editor (−45°…+45°) rewrites that segment live — same construction-rights gate and sync path as the keypad, so everyone in the room sees the chain re-curve.
- **☀️ Solar panels**: owners add panels to four roof slots from the exterior toolbar and click a panel to dismount it. Synced — joiners see your array.
- **Issues housekeeping**: closed #12 (phone chat), #21 (player appearance), #63 (sitting), #64 (module sync) with evidence; status updates on #20/#62/#65.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.31.0 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.30.9 — 2026-07-18

### 🚦 Door Permissions + Build-Rights Requests (#67 D1/D1b)

- **Every door now has two owner-set policies** in the keypad's new DOOR POLICY section: **PASSAGE** (open/close/walk-through: `PUBLIC` default / `OWNER`) and **CONSTRUCTION** (dock/build: `OWNER` default / `REQUEST` / `PUBLIC`). A door can be freely walkable but build-locked, wide open to community construction, or owner-restricted entirely. Defaults preserve today's behavior exactly.
- **REQUEST mode makes rights a social flow**: a guest at the keypad taps **🙋 REQUEST BUILD RIGHTS** → the owner sees the pending request in the same keypad (ACCEPT/DENY) → ACCEPT creates a **standing, revocable grant** keyed to the guest's cryptographic identity (it survives leave/rejoin), and the guest's assembly controls unlock live, on the spot.
- The LOCK button now follows the passage policy (it had escaped the v0.30.7 owner gate), and an owner-restricted door refuses walk-through before any choreography starts.
- Enforcement is UI-level for the dev phase (like edit mode); cryptographically signed records are the planned D3 slice. Next up on #67: **D2 — the 🔌 Docking Adapter** item for transient guest ship berthing.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.9 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.30.8 — 2026-07-18

### 💬 QUICK CHAT

- **Press ENTER to chat** — no phone dance needed: a mini bar slides up from the bottom edge (the top of your phone peeking) holding just the chat field. Type + ENTER to send — your message pops as a bubble over your avatar and the field stays ready for the next line. ENTER on a **blank** field (or ESC) slides it away. **TAB from the mini bar expands to the full phone on the CHAT app** so you can scroll history; TAB again puts the phone away.
- Installing this skips v0.30.7 — everything from it is included (one-way vestibule fixes, owner-only docking, chat bubbles, movable fireplace + auto north door).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.8 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.30.7 — 2026-07-18

### Vestibule Fixes (owner's findings) + 💬 Chat Bubbles + Movable Fireplace

- **One-way vestibules FIXED** (root-caused, three compounding bugs): (1) a plain pairing never wrote the far room's half of the connection — the return direction *structurally didn't exist* ("No room docked at this port"); the first walk-through now writes the mirror record for **every** pairing, plain or assembled. (2) The mirror's departure-address lookup failed for exactly the rooms you walk out of most — your own (never in your own pass list); it now falls back to the module ledger and then mints a link, and skips log loudly instead of silently. (3) The misleading "it shows a vestibule though" ghost: merely *opening* a keypad with a preset armed consumed parts and armed a ghost tube on an unpaired door — untouched prefills are now refunded on pane close, and a rejected pairing refunds + drops its chain.
- **Docking is now OWNER-only**: initiating, approving, and editing connections on a room's ports requires being that room's owner (guests see "owner only"; legacy unowned rooms stay open to all). Dev-phase UI gating — cryptographic record signing is a planned later slice.
- **💬 Chat bubbles**: messages sent via the phone's CHAT app pop up above the sender's avatar for ~6 s, tracking the head in both the room view and first person. Works across machines (the message carries the sender's position; the bubble finds their avatar), and offline.
- **🔥 The fireplace is furniture now** — pick it up in edit mode and slide it aside; the **north door unblocks automatically** when its approach is clear (re-blocks if you put it back). Works in existing rooms too.
- Also: the movable-doors + unit-grid floor-plan design landed (`brainstorming/floorplan-grid-plan.md`, issue #66) — 6×6 m tiles, today's room is exactly 2×2, door-slide ships first. The opening station-exterior view is tracked as #65 (not yet built; the zoomed dev views are unrelated 2D schematics).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.7 in place). **Frontend-only — node binaries unchanged from v0.30.6.**

## v0.30.6 — 2026-07-17

### Rooms Survive Node Restarts (durability C4/B)

- **The next durability rung.** v0.30.4 made a room survive its closed *browser* (the still-running node answers visitors from RAM); this release makes it survive a **node restart**: every room your browser participated in persists its doc to disk (`rooms/` beside the node's key — 15-second snapshots, written only when content changed) and loads back at boot still serving. Reboot the owner's machine, relaunch the game, and visitors get the full room with no browser open. Corrupt or unreadable files never block startup (the node logs and boots fresh).
- **Node binaries changed** — install on every machine. The `ssf-p2p-node-chia.exe` asset from this release carries the same persistence plus the chia heartbeat (v0.30.3+) and remains the one to use for chia testing.
- Known-open: the owner is documenting vestibule-transit issues found in the v0.30.5 two-machine session — fixes land in the next release once studied.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.6 in place).

## v0.30.5 — 2026-07-17

### The Station Builder (#62 P1–P4) + the Settings Phone App + Roster Friending

- **Build angled stations — the octagon toolkit is in.** New buildable connector parts: **FLEX JOINT** (corrugated bellows, bend ±60° in 7.5° steps, slight stretch) and **EXTENSION** (straight tube, 1.2–7.2 m, ribbed or solid skin per the concept art). Assemble them per-door in the docking keypad's new **CONNECTION ASSEMBLY** strip (chips: click to cycle bend/length, toggle skin, ✕ to remove), and the chain renders live in-world as a translucent ghost while unpaired. Pairing publishes the geometry with the connection: **everyone in the room sees the bent link, and the far room's projection sits at the chain's true angled position** (v0.30.x clients see the straight gangway — fully compatible). Arrival doors follow the connection (angled links land on non-opposite doors), and the first walk through an assembled link auto-writes the far side's mirror record so the connection works from both ends.
- **DEV menu → PARTS**: part counts (+4 flex / +2 ext per click), the two build presets (**RING LINK** = the octagon's 45° turn, **HUB SPOKE** = straight hub run — armed presets prefill the keypad), a **module seeds ledger** with COPY buttons (building 9 rooms needs more than one clipboard), **AUTO-ACCEPT MY MODULES** (your own minted modules pair instantly), and the **NORTH DOOR** unlock. The full in-game octagon walkthrough is §6.4 of `brainstorming/angled-vestibules-octagon-plan.md` — this release is the build to attempt it on.
- **⚙️ SETTINGS phone app**: Network Details (incl. the Chia Mesh toggle + RETRY) and the FPS/POS/NODE stats moved off the screen overlay into the phone (Settings → NETWORK / STATS); Room Name + Owner moved into the ACCESS app. The zoom-level pill is now a 2.5 s toast on level change instead of a permanent box. The screen is clean.
- **Friend from the roster**: CLONES SEEN rows with a verified identity get a one-tap **+ FRIEND** button (cert-verified to the same standard as a card import; ★ FRIEND badge once added; room list recategorizes into Friends' Rooms).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.5 in place). **Frontend-only — node binaries unchanged from v0.30.0**, so the `ssf-p2p-node-chia.exe` chia asset (heartbeat version: v0.30.3+) still applies.

## v0.30.4 — 2026-07-17

### Rooms Survive Closed Browsers + Instant Rejoins (durability Tiers A & C2)

- **A room no longer dies the moment its browsers close.** Root cause found and fixed: the node held every room's doc but **never answered a relayed sync request** — only browser-local requests got answers; relayed ones were silently dropped in a blind decode (which could also panic on malformed frames — also fixed). Now any room a local browser participated in is *served*: after the browser closes, the still-running node answers visitors' sync requests from its own copy, point-to-point. **"Owner left the game open-but-minimized, or closed the window but not the machine" rooms now load for visitors.** Rooms a node only relayed for are unchanged.
- **Rejoins paint instantly from a local snapshot cache.** The browser now caches each room's doc in IndexedDB (full CRDT snapshots): rejoining a room restores the cached state *before* the network sync, so the room appears immediately and the host ships only the missing delta. Your own room's cached owner also closes the long-documented rename-revert-on-reload race. Stale-cache freshness is guarded: after a cache restore the bounded resync window always runs. Chat is now capped at 200 messages in the shared doc (bounds doc, cache, and sync at the source). The cache never evicts rooms you own; corrupt entries self-discard; private-mode browsers degrade to exactly the old behavior.
- **Also from v0.30.3 (installing this skips it):** the ChiaHub heartbeat — armed rooms (chia-lane node + `SSF_CHIA_LANE=1` + Chia Mesh toggle ON + funded wallet) publish presence under their real room key every ~30 min. **Use THIS release's `ssf-p2p-node-chia.exe` for the chia test.**
- **New multi-machine test this enables:** enter a room from machine A, close the game *window* on A (leave the machine on — note the installed app kills its node on exit only if the whole app closes; minimizing keeps it alive), then cold-join from machine B: the room should load with full state instead of an empty Lobby. Verified in dev: cache write→restore round-trip live in-browser; the two-node serve path is the runtime test.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.4 in place). Frontend + node both changed — install on every machine.

## v0.30.3 — 2026-07-17

### ChiaHub Heartbeat — Armed Rooms Now Actually Publish (node-only)

- **Slice 6, the last gap in the introduction lane.** The resolve side (dial-exhaustion → find a lost peer via the chain) already used real room keys, but publishing only fired via a fixed-test-key dev hook — an *armed* room (chia-lane node + `SSF_CHIA_LANE=1` + Chia Mesh toggle ON) would never write its presence. Now a heartbeat publisher covers every armed room: it publishes within a minute of arming, every ~30 min thereafter, immediately on address change, and retries every 5 min after failures (an unfunded wallet logs exactly that, so the operator knows to fund). One room publishes per minute at most — sequential spends inside one ~19 s block window would double-spend the wallet coin.
- **For the 3-machine chia test, use THIS release's `ssf-p2p-node-chia.exe`** — the v0.30.0–v0.30.2 chia assets predate the heartbeat and will not publish for armed rooms. The default node and the app itself are unchanged in behavior; if you already installed v0.30.2 you only need the new chia exe (no reinstall).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.3 in place). Node-only (feature-gated chia code + a design doc); frontend identical to v0.30.2.

## v0.30.2 — 2026-07-17

### Docked Modules Now Appear for Everyone in the Room (issue #64)

- **A module you provisioned and docked to a door was invisible to the other players in the room** — they couldn't see the adjacent-module projection and got "No room docked at this port" when they tried to walk through. Door pairings lived only in the local docking system's private state and never entered the shared room doc, so everyone else's door read unpaired.
- **Fix (frontend):** door pairings are now part of the shared room doc — a new `doors` map keyed by door id, mirroring the furniture-layout sync that already keeps every client's arrangement in step. When one user docks a module, the pairing publishes to the doc; every other client reconciles it, drawing the module projection, opening the door, and enabling transit. Applying a remote pairing is idempotent and self-echo-safe (it never re-publishes), and unpairing tears the projection back down. A player who never docks a module sees no change.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.2 in place). **Frontend-only — the v0.30.0 node binaries are unchanged**, so the experimental `ssf-p2p-node-chia.exe` from v0.30.0 still applies for Chia-lane testing. This can be exercised in the same multi-machine session as the Chia test: dock a module on one machine and confirm the others see + enter it.

## v0.30.1 — 2026-07-17

### Seated Players Now Look Seated to Everyone (issue #63)

- **When a player sat in a chair, everyone else saw them standing upright at the chair.** Sitting was fully implemented locally (the avatar walks over, turns, and slides into a seated pose), but the seated state was never replicated — the 13-byte movement tick only carried a "moving" bit, so remote clients rendered every seated peer as an idle stand at the seat's position.
- **Fix (frontend, no wire-size change):** the movement tick now carries the seated state in a spare flag bit (bit1) and the seat's facing in the otherwise-unused yaw field. A seated peer is rendered in the `sit_chair` pose at the correct orientation and skips the walk/idle motion path; standing up reverts to idle/walk. No codec change — `packTick`/`unpackTick` already round-trip flags + yaw.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.1 in place). **Frontend-only — the v0.30.0 node binaries are unchanged**, so the experimental `ssf-p2p-node-chia.exe` from v0.30.0 still applies for Chia-lane testing.
- **Known-diagnosed, not in this release:** issue #64 (a provisioned + docked module does not show up for other users) is fully diagnosed — door pairings are local-only and never enter the shared room doc. The fix (a synced door-pairing doc mirroring the furniture-layout sync) touches the docking/vestibule subsystem and wants a two-user runtime test, so it is landing as a focused follow-up rather than being rushed here.

## v0.30.0 — 2026-07-16

### ChiaHub Introduction Lane — Sovereign Chain Discovery (EXPERIMENTAL test build)

- **A node can now find a lost peer through the Chia chain when every live route fails.** This is rung 6 of the reachability ladder — consulted only at dial-exhaustion, after mDNS, DHT, direct addrs, the host relay, and hole-punching have all been tried. It is **strictly additive and fails to a no-op**: with the lane off, unfunded, or a peer that never published, nothing changes and the mesh behaves exactly as v0.29.10. The full **publish → resolve** loop is proven working on live **testnet11** (a node spends a coin to write a room-key-sealed presence record; another reads it back by room-hint, decrypts, verifies, and recovers the peer's addresses), and resolve is wired into the live dial ladder.
- **Two keys, two roles:** the node's existing **iroh key signs** the presence record (identity/authorship — resolvers dial the node-id inside it); a separate **Chia BLS key pays** (spends a coin back to itself carrying the record as memos). The principal returns minus fee, so only the fee leaves — and Chia fees are near-zero. Records are **room-key-sealed**: only holders of the room pass can find or read them, so the reach tracks the pass's reach automatically (works for public rooms too).
- **Security:** a record's addresses are self-declared, so at dial-exhaustion the node feeds only **public, internet-routable** addresses (private/loopback/link-local/ULA/CGNAT filtered, capped at 4) into **one node-id-authenticated** dial — a spoofed address just fails the handshake, never completes a link. The lookup runs off the hot path (a ~19 s block query); the chain is an address book, never a pipe.
- **Default install is unchanged in behavior.** The normal installers ship a new **"Chia Mesh (ADV)" toggle** in the Network Details panel, but it is **inert without a chia-lane node** (harmless). The chia chain-IO is behind a build feature the default node does not include, so the shipped binary is otherwise identical.
- **How to test the lane (opt-in):** (1) install this release normally; (2) download the separate **`ssf-p2p-node-chia.exe`** asset and use it in place of the app's node (rename to `ssf-p2p-node.exe` next to the app executable, or run it standalone from a folder where its `chia_identity.seed` persists); (3) launch with **`SSF_CHIA_LANE=1`** in the environment; (4) the node prints a **`txch1…` testnet11 receive address** — fund it from a free testnet11 faucet (valueless TXCH); (5) flip the **Chia Mesh** toggle ON for the room. Gating is layered: build feature → `SSF_CHIA_LANE=1` → per-room toggle → funded wallet.
- **This is an EXPERIMENTAL test build** — the publish/resolve mechanics are proven on-chain, but the *auto-dial firing across the internet* wants the three-machine test. Fixes from that test land in the next version.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` (version bumped to 0.30.0 in place). Frontend + node changed. The chia lane ships ONLY as the opt-in `ssf-p2p-node-chia.exe` asset; the default node and installers are chia-free.

## v0.29.10 — 2026-07-16

### IPv6 Self-Healing Mesh — Core (Direct Spoke-to-Spoke Groundwork)

- **Groundwork so firewalled peers can link *directly* over IPv6, not only through the host relay.** v0.29.9 established that joiners are spokes that route through the host; this release lays the two pieces a true joiner-to-joiner IPv6 mesh needs. It is **node-behavior groundwork that wants the 3-machine test to validate** — the relay path from v0.29.9 is unchanged and still carries the room, so nothing regresses if the direct link doesn't form.
- **(1) IPv6 port pin.** The iroh endpoint pinned only its IPv4 socket to the stable port; the IPv6 socket kept its default = a *random ephemeral port every launch*, so a `[v6]:44442` firewall allow-rule or an invite hint could never match v6 traffic. It now probes and pins `[::]:44442` too (degrading to a random port on conflict, exactly like the v4 pin; a v6 failure is never fatal — v4 + DHT still carry us). A member is now **stably dialable on IPv6**, which matters because IPv6 has no NAT — a fixed `[v6]:port` is directly reachable once the firewall is open.
- **(2) Both-side mesh-upgrade dial.** The signed gossip mesh-upgrade previously elected a *single* dialer via a `smaller-node-id` rule (to avoid glare). But a stateful IPv6 firewall only opens for a flow the device itself starts, so a one-sided dial is dropped as unsolicited inbound and two firewalled spokes never connect. **Both** peers now dial: each sends an outbound probe to the DHT-resolved route, opening **both** pinholes; iroh dedups the resulting connection by node id and `hub.dialing` single-flights each side, so the double-dial is bounded, not a storm.
- **Security unchanged (the reflection invariant holds).** The mesh-upgrade dial is still **node-id-only with empty address hints** — the sovereign Mainline DHT resolves the real route, so no relaying node can aim our QUIC handshake at a victim IP. Removing the smaller-id guard does not touch that: a peer's self-declared address is still never dialed.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.10 in place). **Node binary changed — every machine must install this build**, and for a direct IPv6 link both peers must allow inbound UDP 44442 on their IPv6 firewall (the node prints a reminder at startup). Without that, the v0.29.9 host relay remains the movement path.

## v0.29.9 — 2026-07-15

### Joiners See Each Other Move — the Tick-Relay Version-Skew Fix

- **In a room with a host and multiple joiners, the joiners could see each other in chat and the roster, but not each other's avatars moving.** The host relays traffic between spokes (joiners don't connect directly — see below), and it relayed *ysync* (chat, roster) fine but silently dropped *movement ticks*. Root cause: the multi-hop tick relay is gated on `if ttl > 1`, and a movement packet arriving in the **legacy (pre-M5.2) wire format** — a bare 13- or 14-byte tick with no TTL byte — parsed as `ttl = 0`. So the host delivered it to *its own* screen (that path is ungated → the host saw every joiner) but refused to *relay* it to the other joiners. Chat survived because ysync has no TTL and also self-heals through the durable room doc. Net effect: **a joiner running a version-mismatched node was invisible to other joiners' movement while everything else worked.**
- **Fix (node): normalize legacy frames + relay the last hop.** Legacy 13/14-byte ticks now get a full flood budget instead of `ttl 0`, and the relay gate is `ttl >= 1` (the dedup cache — not the TTL — is what kills loops, so the final hop is safe). A version-skewed joiner is now forwarded to the whole room. **The most reliable fix is still to run the same build everywhere** — installing this release on every machine both eliminates the skew and hardens the relay against a future straggler.
- **Note on topology (by design):** joiners are spokes — they route to each other *through the host*, not via direct links. Two peers behind home NATs generally can't hole-punch each other without a relay/coordinator (iroh relays are disabled in the sovereign preset), so "1 peer seen" on a joiner is the intended steady state, and the host relay is the movement path. A true joiner-to-joiner mesh is a separate, larger design item.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.9 in place). **Node binary changed — every machine must install this build** (and, for the fix to take effect, at minimum the *host* must run it, since it's the host's relay that was dropping the frames).

## v0.29.8 — 2026-07-15

### Furniture Editor — a Visible EXIT, and Tab No Longer Traps You

- **You could get stuck in the furniture editor with no way out.** Edit mode advertised only a transient "ESC exits" hint — no visible button — and the edit-mode ESC handler (like the `+`/`-` first-person keys) early-returns whenever the SpacePhone is open. The Tab key toggles the phone, and its handler was **completely unguarded**, so pressing Tab *while editing* opened the phone on top of edit mode — and from then on ESC no longer exited the editor **and** `+`/`-` no longer entered first-person, because both defer to the open phone. With no exit button, it was a dead end. (Neither key was "disabled" — verified live that `+` still enters first-person from the room; an open phone was silently swallowing them.)
- **Two fixes.** (1) A persistent **✓ DONE EDITING** button, top-center, visible the whole time you edit — it calls exit **directly**, bypassing the keyboard-guard chain, and blurs focus on the way out, so it works even if the phone is open; a click mid-move cancels that move first (mirrors ESC). (2) The Tab handler now **refuses to open the phone while you're editing** (it can still close an already-open one), so the guard that swallows ESC and `+`/`-` can never latch during an edit session. Together: ESC exits, `+`/`-` reach first-person, and there's always an obvious way out.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.8 in place). **Frontend-only — the v0.29.6 node binary is unchanged.**

## v0.29.7 — 2026-07-15

### The Room Name and Furniture Finally Land — Backfill the Quiescent SyncStep2

- **After v0.29.6 let you connect and join, a joiner still saw "Lobby" with no furniture** — the host's name, owner, and furniture never arrived, even though both avatars moved and your own data reached the host. Root cause (a *second*, independent seam from the dedup collision): a room's **quiescent** state — `roomInfo` (name/owner), the roster, and furniture — all ride **one signed SyncStep2** that only transfers when the host browser answers a `SyncStep1` reaching it **after** the P2P link is up. But the opening `SyncStep1` fires the instant the local transport connects — *before* the node's dial to the host finishes — so it's relayed to an empty neighbor set and lost. The re-ask that would fix it (`resync()` on the node's `connected` status) was either **never wired** (the background prefetch dropped the bridge status entirely → permanent UNREACHABLE) or **swallowed** (when a prefetch already claimed the node's single-flight dial, the JUMP session never received a `connected` status). Movement kept working because ticks are a separate, unsigned datagram lane that needs no handshake. Verified live: a single post-link `SyncStep1` pulls the entire `roomInfo`/roster/furniture SyncStep2 (custom name, 30 furniture, host entry all appeared at once).
- **Fix (frontend): a bounded backfill retry.** Both the JUMP path and the background prefetch now **re-issue `SyncStep1` on a bounded cadence until the host's `roomInfo` actually lands** (then stop), plus a fast-path re-ask the instant the node reports the peer LINKED. A slow or single-flight-swallowed dial can no longer strand a joiner showing "Lobby" with an empty room, and a pass warms to READY instead of timing out to UNREACHABLE. A room you own is unaffected (it sets its own owner immediately).
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.7 in place). **Frontend-only — the v0.29.6 node binary is unchanged** (both machines still need the v0.29.6-or-later node for the room-scoped dedup key; this release only rebuilds the frontend).

## v0.29.6 — 2026-07-15

### Room State Syncs Again — the Cross-Room Dedup Collision Fix

- **A joiner's room roster / name / furniture would never sync while a DM was open — the movement avatar showed up, but the room stayed "empty" and its name stuck on the raw room id (UNREACHABLE).** Root cause: the node's relay-dedup cache is a *single cache shared across every room*, but its key (`envelope_seen_key`) folded in only `node-id + seq + payload` — **not the room**. Every sync channel opens with the same first frame, `SyncStep1 = state-vector of an empty Yjs doc`, and that state vector is a **byte-for-byte constant**. So a browser running a DM (opened at app launch) and a room (opened on JUMP) emitted two *identical* opening frames from the same node id at the same starting seq — an identical dedup key. The DM won the cache slot first; the room's `SyncStep1` then hit "already seen" and was **dropped before it was ever delivered**, so the host never replied with the room's state. Movement ticks use a *separate* dedup cache, which is why they (and the remote avatar) flowed the whole time while the reliable state lane silently stalled. A reinstall made it deterministic: wiping localStorage left both docs empty, so their openers became byte-identical every time (with persisted, non-empty docs the state vectors differ, which is why the same path synced before). **Fix:** the dedup key is now **room-scoped** (the room id is folded in, with a `0x1f` separator so the two string fields can't concat-alias) — two rooms' identical empty-doc handshakes can no longer collide, while echo-storm protection *within* each room is unchanged. As added robustness, the browser now **re-issues `SyncStep1` when the node reports a peer `LINKED`**, so a slow P2P dial can't strand the one-shot opening handshake either.
- **`NODE OFFLINE` → `UNREACHABLE`.** The pass-list label for a room that couldn't be warmed now reads `UNREACHABLE` — a warm timeout is almost always the *host* being unreachable, not your own node, and the old wording made people think their node was broken.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.6 in place). **Node binary changed** — this is the first node-side change since v0.29.0, so both machines must install this build (a v0.29.0-line node won't have the room-scoped dedup key).

## v0.29.5 — 2026-07-15

### Room Renames Now Propagate to the Pass List

- **A renamed room no longer shows its old name on a joiner's list.** The pass list captured `roomInfo.name` exactly **once**, when a pass first warmed to READY, and then froze it — so if the host renamed the room afterward, every joiner kept showing the stale name forever (and a pass added before the sync completed could keep the raw roomId). The room-warm now **observes** `roomInfo` and keeps the pass's display name synced to the room's live name on the initial sync *and* every later rename (persisting + re-rendering the list), and the row for the room you're currently in reads the name straight from the live session doc so a local rename shows instantly. Verified: renaming the current room updates the list immediately; the cross-machine propagation rides the same `roomInfo` observer.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.5 in place). Frontend-only — the v0.29.0 node binary is unchanged.

## v0.29.4 — 2026-07-15

### NODE OFFLINE on Launch — Wait for the Node, Retry with a Fresh Cert

- **The frontend now waits for the local node instead of flashing NODE OFFLINE.** The Rust node sidecar takes a second or two to bind after the app launches, and its WebTransport cert is regenerated on *every* node launch. But `fetchLocalFingerprint` returned a **cached** hash (only fetching fresh when the cache was empty), and the initial connect had **no retry** — so a startup race between the WebView and the node dropped straight to `NODE OFFLINE` with no recovery (the recurring "node offline" on launch), and a node restart left a stale cert the handshake couldn't match. Now `fetchDefaultBootstrap` retries a **fresh** fingerprint read for up to ~7s (waiting for the node to come up), and the local (loopback) connect retries up to 3× re-reading the **current** cert on each failure — so a late-binding node or a regenerated cert self-heals instead of stranding you offline. Remote dials are untouched (their cert isn't ours to refresh; the RESTRICTED?-network diagnostics still own that path). Verified: the happy path connects cleanly (`NODE ONLINE`, ping/pong flowing) with no regression.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.4 in place). Frontend-only — the v0.29.0 node binary is unchanged.

## v0.29.3 — 2026-07-15

### Paste a Pass → You're In — Auto-Enter on Ready

- **ADD PASS now takes you into the room automatically.** The staged room-list (#60) warms a pasted pass in the *background* and left you standing in your *own* room until you noticed the row turn READY and clicked ENTER — so a working cross-internet connection *looked* like a failure ("peers seen" stayed 0 because you were alone in your own room). Pasting a pass is a request to *join*, so it now arms an **auto-enter**: the room warms, and the instant it's READY the app swaps you in and closes the phone — "🛰️ Connecting to that room — you'll be taken in automatically once it's ready." The sync-before-enter gate is preserved (it waits for the room's state, never drops you into a half-loaded room), a first cross-internet connect is called out as taking up to ~30s, and a timeout surfaces a clear, non-destructive "couldn't reach it — it's saved, tap ENTER to retry." A manual ENTER/JUMP on any room cancels the pending auto-enter. Verified end-to-end against a live port-forwarded host: paste → connecting → auto-entered the host's room → host avatar + live movement ticks visible.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.3 in place). Frontend-only — the v0.29.0 node binary is unchanged.

## v0.29.2 — 2026-07-15

### Room List, by Owner — My Rooms / Friends' Rooms / Visited, + an ADD-PASS Fix

- **The ACCESS room list is now grouped by owner.** The single flat list becomes four sub-sections: **MY ROOMS** (rooms you own — `roomInfo.owner` is you), **FRIENDS' ROOMS** (owner is on your Friends list — resolved owner-id→pubkey via the players-map name↔key cert, then matched against friends, which are keyed by pubkey), **VISITED** (a pass to someone else's room), and **UNREACHED** (a room whose owner hasn't synced yet — so we never mis-file a room we haven't actually reached). The room you're currently in always appears in its owner's section ("YOU ARE HERE"), and a newly-added pass shows up immediately under UNREACHED (loading) and moves to its real section as it warms. Re-categorises live as rooms sync and as you add/remove friends.
- **ADD PASS no longer "refreshes your own room".** A pass that lost its room id used to fall back to `getDefaultRoomId()` — *your own room* — so ADD PASS silently added your current room (which then no-oped its prefetch) instead of the pasted one. Decode now rejects a room-id-less pass as invalid rather than substituting yours, and the grouped list makes a real add visibly land under UNREACHED so it can never look like "nothing happened."
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.2 in place). Frontend-only — the v0.29.0 node binary is unchanged.

## v0.29.1 — 2026-07-15

### SpacePhone Scroll Fix

- **The SpacePhone's tall apps scroll now.** `#phone-screen` (the `flex: 1` child of the fixed-height phone frame) was missing `min-height: 0`, so a tall app view — **ACCESS with its MY ROOMS list**, or CONTACTS with its many sections — grew *past* the 500px frame instead of letting its inner `overflow-y: auto` engage; the container's `overflow: hidden` then clipped everything below the fold, leaving **MY ROOMS unreachable**. Adding `min-height: 0` (+ `overflow: hidden`) to `#phone-screen` completes the flex-shrink chain so the active app view becomes the scroll region, and CONTACTS gets the same `overflow-y: auto` + padding as ACCESS. Verified in-browser: the ACCESS view now bounds to the frame and scrolls (was clipped, no scroll). Frontend-only — the v0.29.0 node binary is unchanged.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy (version bumped to 0.29.1 in place — a patch on the same line).

## v0.29.0 — 2026-07-15

### The Traffic Mesh — Multi-Hop Movement, Live Membership, and a Bounded, Trust-Ordered Overlay

M1–M4 made the network *reachable*; this line changes how game **traffic flows across it**. The hub-centric star — where real-time movement was hop-1-capped, single-hub-critical, and `remote_peers` was insert-only with no liveness — becomes a resilient, hub-independent, multi-hop gossip overlay, admission-gated so free-minted keys can't buy relay leverage. Built from the design panel's synthesis: *flood over a bounded, trust-ordered neighbor set.* (Node-side; the browser stays a thin WebTransport client.)

- **Multi-hop movement (M5.2) — the core win.** The 20 Hz movement-tick lane was hop-1-capped (`main.rs`), so a spoke two relay-nodes out never saw you. The datagram hop byte is repurposed from a 0/1 flag to a **decrementing TTL** (init 4), and a **second, tick-scoped dedup cache** (keyed on the full 13-byte tick, so a wrapping `u16` seq can never alias a fresh tick) makes the multi-hop flood loop-safe. Dedup gates *before* both local delivery and relay; a node seeds its own outgoing ticks so a mesh cycle can't echo them back. Result: in an A–B–C line where A and C aren't directly linked, A's movement reaches C through B — with no echo storm.
- **The node's first-ever liveness (M5.1).** `remote_peers` was insert-only and never pruned, so every relay fanned out to dead connections forever. A per-room **heartbeat** (5 s) now stamps `last_seen` on every tick/frame/heartbeat and **prunes** a peer silent past ~15 s — and a pruned-but-live peer is **re-admitted** the instant it sends again, so a transient gap can't harden into a permanent one-way partition.
- **Signed control plane + closed the unsigned dial (M5.0).** The old gossip mesh-upgrade dialed off **any** relayed bytes with no signature check, inline (stalling the ysync reader) and bypassing the dial single-flight — an open amplifier. It now requires a **sig-Valid** envelope, claims the single-flight, and routes through the bounded-backoff dialer. New control kinds (`roster`/`graft`/`prune`/`px`/`ihave`/`iwant`) ride the reliable lane behind **strict admission** (signature must be *Valid*, not merely present — independent of `SSF_REQUIRE_SIG`), and are never blind-flooded.
- **Bounded, trust-ordered neighbor set (M5.3) + trust-tiered dialing (M3).** Each node holds mesh links to a bounded degree (`D≈6`, hysteresis 4/8); every relay is narrowed to that `in_mesh` neighbor set (at ≤ 8 nodes it *is* the complete graph, so small rooms are unchanged). Dial candidates are trust-ordered (direct > room > introduced > unvetted; the browser stamps the tier, the node's hard gate stays sig-Valid), and the bounded candidate pool is capped (256/room) so a key-spraying peer can't exhaust memory.
- **Reachability bootstrap-dial (M4).** The node bootstrap-dials **every** member hint from the room roster, not just the first — so if the primary host is unreachable, another reachable member still bootstraps you, and the node learns the whole roster (transitive gossip meshes the rest). A **ChiaHub rung-6 fall-through hook** is left at dial-exhaustion (`resolve_presence`, an inert `None` stub until chain IO lands) — "identity known, route unknown" made recoverable later with zero live infrastructure.
- **Security hardening from an adversarial review** (10 findings, all actionable ones fixed before ship): gossip-learned peers dial by **node id only** (DHT-resolved) so a relay can't aim our QUIC handshake at an arbitrary IP (reflection); the pruned-but-live re-admission above; the bounded candidate pool; and the IWANT responder gated off with the rest of lazy-pull.
- **Honest scope — the link-trust boundary.** This ships M5.0–M5.4 on the *link-trust* boundary. **M5.5** (per-tick authorship) is designed and stubbed but deferred — the 13-byte/20 Hz tick stays unsigned, so tick-spoof resistance rests on neighbor-trust + TTL + dedup, which is sound for the small trusted rooms this targets. **M5.4** lazy-pull (IHAVE/IWANT) is wired but **opt-in** (`SSF_MESH_LAZYPULL=1`); the deduped flood is the correct default. The large-room symmetric-membership work (emit `graft`/`prune`/`px`) is dormant at ≤ 8 nodes and deferred. **Verification:** the multi-hop flood + prune + convergence need a **three-machine** test (A–B–C) to confirm — this line is cut for that test; publish follows a green run.
- **Release line:** `prototypes/0.29.0-core-loop-demo/` is the shipping copy; `0.28.0-core-loop-demo/` stays frozen at its 0.28.1 release snapshot.

## v0.28.0 — 2026-07-15

### The Signed Wire — Verify-Before-Apply, Sovereign Room IDs, and a Cross-Internet Sync Fix

The node-side half of the keyed-identity work: the sovereign node now verifies the signatures it relays, plus two connectivity fixes surfaced by a real two-machine (cross-internet) test.

- **Keyed-identity Slice 2 — the real sign/verify-before-apply seam (browser + node).** Outgoing ysync envelopes are signed over canonical bytes that bind `v‖roomId‖kind‖seq‖payload` (`blake3`, domain-tagged) — closing the old payload-only gap so a signature can't be replayed into a different room or as a different message kind. The browser verifies before `Y.applyUpdate` (a signed-but-tampered envelope is dropped; unsigned legacy still applies), and the node verifies in **both** reader loops, gated by **`SSF_REQUIRE_SIG = off | warn | reject`** shipping at **`warn`** (observe-then-enforce — logs mismatches, drops nothing; the owner flips to `reject` once the metric is clean). Verified on real cross-machine traffic: signed state synced between two internet-separated nodes with **zero invalid-sig on both** — and cross-room replay resistance, tamper rejection, and wrong-author rejection all hold.
- **Per-install random default room id (dev-stage collision fix).** Every install used to boot into the literal room id `furlong-lobby`, so a pass for one install's lobby collided with the other's — the joiner saw "YOU ARE HERE" and its node short-circuited the dial to itself. The default room is now a random, persisted `home-<hex>` per install (display name still "Lobby"), so a home-room pass bridges two installs directly. Confirmed cross-internet: the joiner's node now dials the *host's* node and the QUIC link secures on the first attempt.
- **Node datagram/ysync lane split (long-standing cross-internet sync fix).** `handle_iroh_connection` raced the unreliable tick lane (`read_datagram`, 20 Hz movement) and the reliable ysync lane (`accept_bi`) in a single `tokio::select!`. A peer streaming ticks kept the datagram branch perpetually ready, so `accept_bi` was cancelled every iteration before it could accept a single stream — a joiner received the host's **ticks** (avatar) but never its **state** (players map, chat, room name). Instrumented proof across two machines: zero stream receives despite a secured link and flowing ticks. The two lanes now run as independent tasks so neither starves the other (the ysync sibling of the tick fix in #60). **Note:** both peers must run this node build — a peer on the old node can still starve its own `accept_bi`; final bidirectional confirmation is pending both machines on 0.28.0.
- **Release line:** `prototypes/0.28.0-core-loop-demo/` is the shipping copy; `0.27.0-core-loop-demo/` stays frozen at its release snapshot.

## v0.28.1 — 2026-07-15

### Two-Way Cross-Internet Sync, Confirmed

The fix that finished v0.28.0's story — with two internet-separated machines both on this build, a joiner now sees the host's **player *and* full furniture layout** (verified: 29 pieces), both directions.

- **Node relay streams now `finish()` gracefully (the fix that closed the host→joiner state gap).** Every node-to-node relay opened a QUIC bi-stream, wrote the framed envelope, and **dropped the send stream — which in iroh/quinn sends `RESET_STREAM`**, so the peer's read could get the reset before the frame and silently discard the ysync update. Racy and timing-asymmetric: one direction won the race, the other lost it, so state stalled while ticks (datagrams) flowed — the joiner saw the host's avatar but not its room. The relays now call `send_stream.finish()` (graceful FIN; quinn retains and delivers the finished stream's data). Together with v0.28.0's lane split, this closes a bug visible as far back as the 0.22.0 "red ball" placeholder. **Confirmed on two internet-separated machines.**
- **Release line:** `prototypes/0.28.0-core-loop-demo/` is the shipping copy (version bumped to 0.28.1 in place — a patch on the same line); `0.27.0-core-loop-demo/` stays frozen.

## v0.27.0 — 2026-07-14

### Keyed Identity & the Social Mesh — Contacts, DMs, and a Trust-Weighted Peer Substrate

This line makes identity real and builds the sovereign social layer on top of it: every install now holds a cryptographic keypair, and Contacts, friends, direct messages, and the contacts-as-mesh substrate are all built on it — authenticated by client-side signatures, with no servers, directory, or third-party infrastructure.

- **Real cryptographic identity (keyed-identity Slice 1).** Every install mints a 32-byte Ed25519 seed (`@noble`, fully in-browser, zero network) persisted beside the legacy UUID — the public key is your durable identity. The seed is exportable as a recovery credential (sovereign: no reset service), the phone shows your key fingerprint, and the room `players` map carries a self-signed name↔key cert so a display name is cryptographically tied to a key. Fully additive — no wire change, legacy entries coexist, and the keyed entry is re-asserted after sync so it wins over a stale pre-keyed entry.
- **The Contacts app is real** (was a NO SIGNAL placeholder). Self-signed **contact cards** carry identity + reachability + a self-signed `discoverable` consent flag, cryptographically verified on import (a tampered card is rejected). Two tiers: CONTACTS (everyone you've verified) and FRIENDS (the curated subset, the DM boundary + mesh trust anchors). Share your card, import one back, toggle friends, and back up / restore your identity from the recovery key.
- **Direct messages between friends.** A DM is a private two-person room derived deterministically from the pair of keys — both sides compute the same room from the sorted pubkeys, nothing exchanged — dialed via the friend's card reachability over the proven room/prefetch transport. Every message is signed (author + name bound) and verified by the recipient: a relay can inject bytes into the shared doc but cannot forge into the conversation (verified — injected wrong-author and bad-signature messages are dropped before rendering). Honest scope: **authenticated, not encrypted** (the node relays plaintext, same as every room today; the room key is an addressing tag derived from public keys, not a secret).
- **Contacts as a self-strengthening mesh (§7 M1 + M2).** Every verified identity you meet — friends, contacts, and room co-members with a valid self-cert — folds into a durable, bounded, trust-weighted peer store: the sovereign alternative to relay servers, so the network densifies from who you know with no central index. Trust tiers (friend > contact > introduced > room > unvetted) rank dialing and decide cap survival, so a flood of free-minted keys can't crowd real contacts out (verified — 700 sybils cap to 500 without evicting the vetted friend). Signed, consent-gated friend-of-friend **introductions** gossip reachable peers over a friend's DM: consent is proven by the subject's *own* signature (a trusted-but-malicious introducer can't introduce a non-consenting subject), and an untrusted introducer's vouch is dropped.
- **Staged room-list UX (issue #60 P2, ported).** The ACCESS app keeps a persisted list of rooms you hold a pass to; adding a pass background-loads the room and you enter once it reads READY, instead of being dropped in mid-connect.
- **Public / unlocked doors.** A room owner can set the room access mode to 🌐 PUBLIC (anyone enters), 🔗 PASS (link-gated, the default), or 🔑 KEYED; the door status LEDs retint to the mode and it syncs live to everyone in the room.
- **Security hardening** across the keyed-identity + mesh layer, from an adversarial review before the node-side work: subject-proven introduction consent, signed DM author names, bounded + deduped introduction gossip, memoized cert verification, and honest DM confidentiality copy.
- **Scope honesty:** this is the browser-side social layer, authenticated by client-side signatures. The node-enforced verify-before-apply seam and the node-side reachability + traffic mesh (M4/M5, designed in `brainstorming/`) are future work — cross-internet DM/mesh reach depends on the same reachability as rooms today.
- **Release line:** `prototypes/0.27.0-core-loop-demo/` is the shipping copy; `0.26.0-core-loop-demo/` stays frozen at its release snapshot.

## v0.26.0 — 2026-07-14

### The Reachable Room — Cross-Internet Connect/Sync Fixes ([#60](https://github.com/Bella-Addormentata/StarStationFurlong/issues/60))

A diagnosis pass mapped the reported symptoms to one unifying cause — **you entered a room before it was ready** — plus one independent P2P bug and one blocked-on-unbuilt-work item. This line ships the confirmed fixes and builds the furniture-sync slice they needed.

- **The joiner can see the host now (peer tick fan-out symmetry).** Movement ticks flow over the iroh datagram lane and remote avatars spawn from received ticks. A connection the joiner *dialed* never bound its room, so `chosen_room` stayed unset on the dialing side and the node silently dropped every tick the host sent — the joiner saw no host avatar while the host saw the joiner. `handle_iroh_connection` now takes the room on the dial paths; inbound-accepted connections still learn it from the first sync stream. (The same binding was missing on the gossip mesh-upgrade dial and is fixed too.)
- **Faster first contact (off-loop, retrying dial).** The peer dial ran *inside* the document-sync reader loop, so a multi-minute NAT hole-punch stalled every following sync frame on that stream — the joiner's room state couldn't converge while the dial hung. The dial moved into its own task with bounded backoff (and a single-flight guard so a slow punch can't spawn a storm of duplicate dials), and the stream's writer is shared so it still reports DIALING/LINKED/FAILED.
- **Enter only when the room is ready (sync-before-enter gate).** Accepting an ACCESS pass used to beam you in the instant the transport connected — before the host's name, owner and layout had synced — so you landed in a room painting default "Lobby / Clone-XXXX" values. The transit now holds the curtain until the room's shared state arrives (bounded, and it enters anyway on timeout, repainting live as state lands).
- **Furniture layout syncs (E4).** The room's placed furniture now lives in a shared room-doc map: a joiner sees the host's actual arrangement on entry, and the owner's moves / removals / DEV spawns propagate live to everyone (the room owner seeds the default layout on first claim; the seed is deferred past initial sync so an owner reload never reverts a room others have edited). A player standing on — or walking toward — a piece the host moves or removes is stood up / re-routed instead of stranded. The personal removed-item inventory stays local.
- **Two players on one machine sync room state too.** A browser's document updates were relayed to remote nodes and merged locally but never to *sibling tabs on the same node*, so two tabs on one PC synced movement but not chat / players / games / furniture. The node now fans state-bearing sync frames out to sibling tabs (no echo — applied updates aren't re-emitted).
- **Release line:** `prototypes/0.26.0-core-loop-demo/` is the shipping copy; `0.25.0-core-loop-demo/` stays frozen at its release snapshot. Deferred by owner decision: the staged room-LIST UX and a default hole-punch relay. Cross-machine tick symmetry is verified by tracing (a single machine can't run two nodes on the fixed ports) and confirmed by the owner's two-machine playtest.

## v0.25.0 — 2026-07-14

### Game Night — First-Person Legs, Real Gangways, Passes in Your Pocket

- **Walk in first person ([#49](https://github.com/Bella-Addormentata/StarStationFurlong/issues/49)):** zoom level 1 is now a real playable camera instead of a frozen viewpoint. WASD walks the avatar with the same camera-rig-aware, screen-relative movement as the room view (the local mesh stays hidden so you don't render inside your own head; collision, room bounds and movement ticks to peers all keep working). Mouse look engages via pointer lock: entering first person grabs the cursor, moving the mouse looks around, and a click frees the cursor to interact — that unlock click is swallowed (its coordinates froze at the lock point and must never reach the raycaster), clicking seats/doors/devices/floor works unlocked, and a click on empty space re-engages the lock. `Esc` (the browser-native unlock) degrades to the same unlocked-interaction state. Guards from the review pass: only primary-button clicks unlock, the swallow flag expires after 300 ms so a stale one can't eat a real click, and the lock is never requested while the welcome overlay is still up.
- **Modules keep their distance — real gangways ([#51](https://github.com/Bella-Addormentata/StarStationFurlong/issues/51)):** a docked neighbor room now projects 15.2 units away instead of 12 (the boxes visually touched), and the two half-vestibules of a paired door pair up into one continuous gangway tube spanning the new gap. Vestibule shells — and the door leaves behind them — fade with camera facing at every 45° rig detent, so the tube never blocks the view into the room; during a walk-through the tube goes fully solid around the traveler. Vestibule disposal is deferred while any door sequence is live on that door (a mid-walk-through teardown can't strand the player). Known pre-existing edge (amplified here, follow-up filed): a remote peer re-pairing while you're in a different room can leave a stale vestibule shell until the next pairing refresh.
- **Flippable game table + checkers ([#45](https://github.com/Bella-Addormentata/StarStationFurlong/issues/45) v1):** a sturdy 2×1 game table stands by the south wall — its top FLIPs 180° (update-loop tween, trunk-lid idiom) between an 8×8 checkerboard face and a green card-felt face. Focus it (the #33 device stack) and checkers is fully playable: standard American rules (black opens, forced captures, chained multi-jumps, kings, no-move = loss — choices documented in `src/games/checkers.ts`), seats claimed per S2 player id (first two claimants), click-to-move with legal-move and mandatory-capture highlighting, forfeit/reset, and a VS BOT single-player mode (trivial capture-preferring random AI). Game state is plain JSON in a new room-doc `games` Y.Map keyed by table item id — transacted writes, observer-driven re-render, rebound per join like `players`/chat — so games survive stepping away and spectators watch live (the in-world board texture mirrors the doc too). The card face honestly says no deck is dealt yet; chess/war/poker/solitaire and the chia-gaming wagering posture are phased in `brainstorming/games-plan.md`.
- **Remove furniture to a room inventory + re-place ([#53](https://github.com/Bella-Addormentata/StarStationFurlong/issues/53)):** in edit room mode the selected piece now shows a floating **✕ REMOVE** button under its label (the `X` or `Delete` key does the same): the piece despawns cleanly (geometry/materials/screen textures freed, its wall-screen/trunk-lid/holo-ring drive handles deregistered; a player sitting on it stands up first, in-flight walks to it cancel) and its kind is stowed in a new per-room **furniture inventory** (`ssf-room-inventory:<roomId>`, localStorage — deliberately *not* the trunk's 8-tool/4-outfit slot layout, which is the wrong shape for furniture). Removal needs no validity gate: deleting an obstacle only opens floor, so the freed cells are immediately walkable and nothing reachable can be sealed off. The DEV menu gains an **INVENTORY** section listing stored pieces with a **PLACE** button that re-spawns them at the nearest valid spot through the same placement gate as furniture spawning (re-placed seats are sittable, re-placed devices focusable). Fixed room structure (fireplace wall, bar, wall computer) is not selectable in edit mode and therefore not removable. Local-only until E4 sync — and one honest quirk until E4's persisted layout: the room layout resets on reload while the inventory persists, so a removed *built-in* piece reappears at its default spot with its inventory entry intact.
- **ACCESS — room passes move into the SpacePhone ([#52](https://github.com/Bella-Addormentata/StarStationFurlong/issues/52)):** the network panel's invite tooling is now a phone app: a 🚪 ACCESS tile on the home grid opens **MY PASS** (current room name + id, GENERATE PASS = the same invite mint incl. the R1 no-public-IPv4 pre-flight warning, copied to the clipboard and kept current per join) and **ENTER WITH PASS** (paste + USE PASS = the accept path). Dev-phase ruling per the issue: using a pass **immediately transports** you to its room — the T1 transit's curtain fade, epoch-guarded leave→join, watchdog and failure-restore all reuse, but there is no door walk on either side: the avatar simply materializes at the room's default spawn in MANUAL control (an active sit/device-focus/edit session is force-released; a mid-door-walk leg closes its leaf behind you). In the future a used pass will instead drop a pin + access permission on the map table once room pins land. The network panel keeps diagnostics/status rows plus a thin "moved to the ACCESS app" pointer (Override Invite now writes its diagnostics-minted pass into the app's field); the docking pane's pairing input is unchanged — doors still pair with seeds for walk-through transit. Review guards: a pass is refused during the adapter door choreography (a beam failure mid-hold used to wedge the door machine for its 8 s self-rescue), and a failed swap with no room to return to now reports honestly with the HUD set OFFLINE.
- **Node survives bad handshakes + RETRY survives node restarts (stale-cert fix):** restarting the local node mints a fresh WebTransport certificate, but a session that had imported a seed (any used pass or transit) kept dialing RETRY with the pre-restart cert hash — and the node's accept loop treated that one failed handshake as fatal, going permanently deaf to every future tab until restarted. Both halves fixed: the browser now refreshes the cert hash (and WT port) from the live fingerprint before any loopback dial, and both the WebTransport and iroh accept loops log a failed client handshake and keep accepting. Verified live including an adversarial garbage-cert dial followed immediately by a clean connect.
- **Release line:** `prototypes/0.25.0-core-loop-demo/` is the shipping copy; `0.24.0-core-loop-demo/` stays frozen at its release snapshot.

## v0.24.0 — 2026-07-14

### The Open Door — Reachability by Default + The Camera Rig

_(0.24.0 was briefly marked "skipped" when the 0.25.0 line was pre-cut; the owner un-skipped it — this release pairs the camera rig with the zero-setup reachability work, and 0.25.0 follows with the next issue batch.)_

- **Internet reachability by default (R1):** the node now auto-advertises its public IPv4 with **zero terminal setup** — an unset `SSF_EXTERNAL_ADDRS` behaves exactly like `auto` (resolve via HTTP echo, re-check every 5 minutes, hot-swap on ISP rotation). **This deliberately flips the v0.22.0 opt-in posture to opt-out for the demo phase** (owner decision: joining a friend's station must "just work"); the full opt-out — no third-party echo calls at all, the old default — is `SSF_EXTERNAL_ADDRS=off` (also `none`/`0`, case-insensitive). Explicit address lists keep their exact semantics, `SSF_IP_ECHO` still overrides the echo hosts, and CGNAT detection/refusal is unchanged.
- **Live reachability status in the network panel:** the fingerprint API now carries a per-request reachability classification plus the *actually bound* iroh UDP port (so the random-port fallback shows the real port to forward). A new REACHABILITY row renders it: light-green `LIKELY OPEN — public route detected (UDP <port>)` when iroh discovered a public v4 on its own (a portmapper mapping or a peer-observed address — provenance is inferred since iroh 1.0.1 doesn't expose it publicly, so the row deliberately doesn't overclaim OPEN), amber `ADVERTISED — forward UDP <port> if joins fail` for the echo-advertised address (honest: unverified — inbound UDP can't be probed without external infra), red `CGNAT — direct dials impossible, needs relay`, red `LAN ONLY — set up UDP <port> forward`. The browser re-polls the fingerprint every 60 s, which also keeps freshly-minted invite hints current.
- **Copy Invite pre-flight warning:** if the outgoing invite carries no internet-reachable IPv4 (and no UPnP mapping is active), the invite still copies but the panel warns inline: "⚠ This invite has no internet-reachable IPv4 — LAN/IPv6 only. Forward UDP <port> on the router (auto-advertising is on by default)." IPv4 hints deliberately stay in invite links (reliability over minimalism — DHT re-resolution keeps them refreshable).
- **45° view rotation ([PR #48](https://github.com/Bella-Addormentata/StarStationFurlong/pull/48) + Shift-hotkey follow-up):** the room camera keeps its locked isometric elevation and radius but can now swing around the room centre in 45° detents with a ~0.3 s eased tween. Inputs: a bottom-left HUD cluster (`◀ 0° ▶`, azimuth chip between the arrows), `←`/`→`, and `Shift+<` / `Shift+>` (matched via `e.code` so bare `,`/`.` typing keys stay inert). WASD stays screen-relative at every detent ("W = up-screen"); click-to-move, edit-mode picking, seats and doors are rotation-transparent because every raycast already goes through the live camera. Zoom-level snaps (L2/L3/L4), the first-person dive, and device-focus fly-ins/outs all depart from and return to the rotated azimuth. Rotation is guarded out of first person (L1), the flat top-down maps (L5+), and any device-focus substate — the arrows dim and no-op there. New module `src/cameraRig.ts` owns the detent state; guards are dependency-injected from `main.ts` so the module stays import-cycle-free.
- **Release line:** `prototypes/0.24.0-core-loop-demo/` is the shipping copy (camera rig + reachability); the pre-cut `0.25.0-core-loop-demo/` folder is re-cut from it after this release and carries the next issue batch (`v0.25.0`).

## v0.23.0 — 2026-07-13

### The Hangout Update — Rooms Worth Visiting, Doors Worth Opening

- **TEMPORARY development menu (DEV1 — will be phased out):** a dashed-amber DEV panel (bottom-left button or the `` ` `` key) lets anyone spawn things for free while the demo is tested: add any catalogue item to the room trunk's stowage, equip any outfit, and spawn new furniture pieces — each lands at the nearest valid snapped spot to the player (the full E3 placement gate: bounds, overlap, player clearance, connectivity) and immediately collides, paths, seats, focuses and edit-moves like built-in furniture (spawned pieces are local-only until E4 sync). A module-seed row lights up on transit builds that expose the provisioning handle (disabled with a note otherwise), and a vestibule row toggles the PR-A east-door preview without the URL flag. The whole thing lives in one module (`src/devMenu.ts`) plus a button and three wiring lines, so removing it later is a one-commit delete.
- **Same-node room transit through the docking adapter (T1 of [#30](https://github.com/Bella-Addormentata/StarStationFurlong/issues/30)):** clicking a door whose pairing completed with a target seed now carries the avatar into the other room instead of the peek-and-return. The door machine gains a transit branch — walk through the threshold, on into a procedurally-spawned gangway vestibule (amber "cycling" lights), hold while a ~400 ms full-screen fade covers the T0 `leaveRoom()`→`joinRoom(target)` swap, then emerge walking in through the arrival door of the destination room (opposite cardinal of the departure door; a south departure falls back to east because north is fireplace-blocked). WASD and click navigation are swallowed for the whole scripted stretch. On any failure (unreadable seed, join error) the vestibule lights red, the original room is rejoined from a pre-departure snapshot, the avatar walks back in, and a "Dock seal failed." hint shows. The docking pane gains a **PROVISION NEW MODULE** button ("buy a module" v0): it mints a fresh `module-<hex>` room seed against the local node and fills the pairing address input; transiting into a module you provisioned this session claims its owner/name defaults (everyone else joins as a guest). Known v1 edges: pairing state is still per-tab (no reciprocity until T3, so the trip is one-way), your departed avatar lingers in the old room for the ≤10 s tick-reaper window, and the node-side `local_connections` cleanup is deferred out of this slice.
- **Move furniture — click-carry-place in edit room mode (E3 of [#25](https://github.com/Bella-Addormentata/StarStationFurlong/issues/25)):** inside edit mode (wall computer → EDIT ROOM), clicking the selected movable item picks it up: the piece follows the cursor snapped to the placement lattice (odd tile-widths centre on n+0.5, even on n), tinted green/red for drop validity, with `R` rotating a quarter-turn mid-carry and `Esc`/right-click cancelling back to the exact origin. A drop must pass a four-stage check — inside the room bounds, no footprint overlap, no player (local or remote) under the piece, and a flood-fill connectivity gate that rejects any layout sealing off a currently-reachable seat, enabled door, or device front (the fireplace conversation pit can't be bricked shut and the wall computer can't be walled off). Committing rebakes obstacles → pathfinding grid → seats → device targets in that order, so sitting at a moved armchair and focusing a moved trunk/map table work at the new spot immediately; in-flight walks replan around the new layout, approaches to the moved piece cancel, and picking up the chair you're sitting on stands you up first. The held item's original obstacle stays solid until commit (no transient walk-through hole). Layout still resets on reload — sync/persistence is the E4 slice. One legacy wart retires on touch: a moved piece sheds its hand-authored obstacle-drift override (e.g. the front-right lamp table's one-tile offset) and collides where it visually stands.

- **Player identity + display names in the room doc (S2 of [#20](https://github.com/Bella-Addormentata/StarStationFurlong/issues/20)):** every install now mints a stable player id (UUID in localStorage) with an editable display name (default `Clone-XXXX`, inline editor on the SpacePhone home screen). A new Yjs `players` map carries `{name, joinedAt, outfitId}` per player and drives a "CLONES SEEN" roster on the phone home screen (departed players remain listed until S3 presence adds liveness). Chat messages now carry `authorId`, so me/them bubble classification finally works with 2+ players (legacy `Local-Clone` messages still render); the room owner is stored as a player id (legacy `Local-Clone` rooms stay editable) and the HUD resolves the owner's display name through the players map. Only the room creator's own-bootstrap path claims the owner/name defaults — seed-link joiners never write them, so a joiner can no longer race the initial sync and steal ownership or reset a custom room name. Name tags over remote rigs and outfit application on remote avatars are deferred to S3 — the tick lane keys peers by per-connection lane id and there is no lane→player mapping yet.
- **The solar map becomes diegetic — holographic map table + zoom/overlay deprecation ([#33](https://github.com/Bella-Addormentata/StarStationFurlong/issues/33) M4+M-dep):** per the diegetic-maps ruling, map/data views should be things standing in the world, not floating HUD chrome (the wall-computer room terminal landed separately as M1). A holographic map table now stands in the lobby — a dark 2×2 table with an emissive cyan holo disc and a slow-spinning ring; click it and the player walks over, the camera eases in, and the full solar-system map (pan / zoom / select / travel) runs inside the table's focused panel. Its orbital sim only ticks while the table is open. In exchange, the non-diegetic paths are retired: the `M` hotkey, the `SOLAR MAP [M]` HUD button and the `+`/`-` HUD zoom buttons are removed, and keyboard zoom-out now clamps at level 2 (room view) — levels 1↔2, including the first-person transition and the eyelid blink, work exactly as before. The old level 3–8 canvas overlay stays demoable behind a `?devzoom=1` URL flag during the transition (the world-side capsule exterior shell is untouched — it seeds the future exterior renderer).

- **Storage trunk — first-person stowage and the wardrobe ([#35](https://github.com/Bella-Addormentata/StarStationFurlong/issues/35) TR1–TR3):** the ISS-ST04 storage trunk from the concept art now stands at the hearth's west flank as real furniture. Click it and the avatar walks over, the lid swings open, and the camera eases into a first-person look inside: a tool tray up top and a wardrobe tray beneath. Outfits (Midnight Courier, Ember Scout, Snowdrift Recon — palette swaps plus a cap/visor/scarf head accessory on the fox rig) equip with one click and persist locally (`ssf-outfit`); trunk contents are per-room local stowage, honestly labeled — synced trunk inventories arrive with TR-sync after the furniture-map lands. Remote players still see hue-tinted foxes until S3 maps tick lanes to player identities.
- **Remote players are fox avatars with feet on the floor (fixes [#21](https://github.com/Bella-Addormentata/StarStationFurlong/issues/21)):** peers render as the full chibi-fox rig with a stable per-peer hue tint (was: a red placeholder sphere), animating walk/idle with 8-way facing derived from motion; the rig's idle/walk baseline was raised so feet rest exactly on the floor (they sank ~0.18 below). Also fixed: an unclamped frame-delta lerp inherited from the original rig sample code exploded the torso (and the whole leg hierarchy) to ±1e17 world units after a backgrounded tab resumed — all rig interpolation and the global game-loop delta are now clamped and unconditionally stable.
- **Doors look like doors and you can walk through them (closes [#23](https://github.com/Bella-Addormentata/StarStationFurlong/issues/23)):** the four docking ports got grounded frames, status-tinted glow strips, paneled leaves with lit center seams, and threshold plates; clicking a door walks the avatar up, slides it open (update-loop-driven with completion signals), steps through, and — if unpaired — peeks and returns. The north door keeps its keypad but isn't walk-targetable (it's behind the fireplace).
- **Diegetic devices — the wall computer (#33 M1/D0):** a shared device-focus mechanic (walk up → camera eases to a fixed first-person framing → DOM panel → WASD/Esc/click releases) powers all in-world devices. The wall computer by the south door shows a live idle screen (room name, peers, node status) and, focused, a top-down wireframe room view with door-pairing LEDs, an honest `FUEL — NO SENSOR FITTED` gauge, and the EDIT ROOM entry.
- **Edit room mode (E2 of [#25](https://github.com/Bella-Addormentata/StarStationFurlong/issues/25)):** owner-gated (S2 identity) EDIT ROOM button on the wall computer's screen; the platform grid appears, movable furniture highlights on hover, clicks select — the foundation the E3 mover builds on. Under the hood, the whole room derives from a data-driven furniture registry (E1): visuals, collision obstacles, seats, and device targets share one source of truth.
- **SpacePhone home screen (S1 of [#20](https://github.com/Bella-Addormentata/StarStationFurlong/issues/20)):** the phone opens to an app grid (Chat, Contacts, Bank) with back/Esc navigation; Chat is fully functional, Contacts/Bank show NO SIGNAL placeholders until their slices land. Includes your editable display name and the CLONES SEEN roster.
- **Real sender identity on the movement-tick lane (fixes [#22](https://github.com/Bella-Addormentata/StarStationFurlong/issues/22)):** remote players no longer vanish when a 3rd player joins. The browser used to fabricate peer identity from the tick's own wrapping seq counter (`peer-${seq % 4}`), so every remote player aliased into the same four render slots and whoever ticked last captured the mesh. The node now tags every tick it delivers with an 8-byte sender lane id — blake3(node id ‖ tab addr) — and browsers key remote players by it.
  - **Wire change (0.23.0):** node→browser ticks are now 21 B (`[8B sender][13B tick]`); node→node ticks are 22 B (`[hop][8B origin][13B tick]`). Browser→node stays 13 B. Inbound legacy 14 B/13 B ticks are accepted with a per-node synthesized lane id; 0.22.0-and-older nodes drop 22 B ticks — run matching versions on all machines (same rule as v0.18.0).
  - **Ghost-peer reaper (first cut of C4):** remote replicas now despawn after 10 s of tick silence, and re-bootstrap clears stale replicas. The Tauri fallback listener (`wt_listener.rs`) tags tick senders the same way, so sibling tabs on the loopback room also render distinctly.

## v0.22.0 — 2026-07-10

### The Address That Keeps Itself — Dynamic-IP Self-Healing

- **`SSF_EXTERNAL_ADDRS=auto` (or `auto:<port>`):** the node resolves its current public IPv4 at startup and re-checks every 5 minutes; when the ISP rotates the address, the node hot-swaps the advertised hint live (`Endpoint::add/remove_external_addr`) — the DHT record and newly-minted invites follow automatically, no restart needed. Pairs the discovered IP with the actual bound port (`auto`) or an explicit one (`auto:<port>`).
- **Invites survive IP changes regardless:** they are anchored to room key + node ID, and remote peers re-resolve current addresses from the Mainline DHT — `auto` closes the last gap (the node's own knowledge of its public address after a manual router forward).
- **Sovereignty posture kept:** discovery is **opt-in** — the node makes no third-party calls unless `auto` is configured; the plain-HTTP echo services are overridable via `SSF_IP_ECHO=host1,host2` (self-hostable). A poisoned echo can at worst add one dead dial hint: iroh connections are authenticated by node key.
- **CGNAT detection:** if the echo reports a CGNAT/private WAN address (100.64.0.0/10 etc.), the node refuses to advertise it and explains why a router port-forward cannot work from there — pointing at the relay/beacon lanes instead.
- Zero-third-party alternative documented: routers with UPnP enabled already self-heal via the built-in portmapper (reachability rung 1) with no echo service involved.

## v0.21.0 — 2026-07-10

### Batteries Included, Take Two — Bundled Node (Windows/Linux) + Race-Proof Publishing

- **Re-ships everything from v0.20.0**, which never got artifacts (see its entry below): the sovereign P2P node bundled inside the **Windows and Linux** installers via `bundle.externalBin` — no separate `ssf-p2p-node.exe` download — plus the silent auto-spawn (`CREATE_NO_WINDOW`), the per-user key dir (identity survives read-only install locations), and the v0.19.0 default-pinned swarm port (UDP 44442).
- **macOS: sidecar bundling temporarily disabled.** The v0.20.0 run showed the mac `tauri build` failing with `externalBin` while Windows and Linux built clean; the release overlay now strips `externalBin` on macOS only, restoring the pre-0.20.0 flow there (standalone node / manual placement) until the mac bundler failure is reproduced with logs. Tracked as a follow-up.
- **Release publishing is now automated and race-proof.** This repository has **immutable releases**: publishing permanently freezes the asset list. v0.20.0's draft was published while installers were still building, freezing an empty release forever — that is why this version exists. The workflow now holds the draft until a final gate job confirms every installer job and the standalone node asset succeeded (≥ 6 assets attached), then publishes automatically. **Never publish the draft manually.**

## v0.20.0 — 2026-07-10 (burned — no artifacts)

> ⚠️ **This version number is unusable.** The draft release was published while platform builds were still uploading; repository releases are immutable, so the empty v0.20.0 release can neither be deleted nor amended. Windows/Linux builds had succeeded (proving the bundled sidecar) and only failed at upload; macOS had a genuine `tauri build` failure. Everything below ships — with the macOS scope-down — in **v0.21.0**.

### Batteries Included — The Sovereign Node Ships Inside the Installer

- **The P2P node is now bundled inside the installers** (Tauri `bundle.externalBin`): every platform build stages `ssf-p2p-node` next to the app executable, where the app's spawn probe already looks first — **no separate `ssf-p2p-node.exe` download needed** on fresh installs. The standalone release asset remains for headless/always-on node operators and for patching older installs.
- **Invisible sidecar:** the auto-spawned node no longer flashes a console window on Windows (`CREATE_NO_WINDOW`), and it runs from a per-user data dir (`%LOCALAPPDATA%\StarStationFurlong`, `~/Library/Application Support/StarStationFurlong`, `~/.local/share/StarStationFurlong`) so `iroh_node_id.key` persists even when the app is installed to a read-only location (Program Files, `/usr/bin`) — previously the key write would have failed there, killing the node at startup. One-time consequence: installs whose key previously lived beside a manually-placed binary get a fresh node identity on first spawn (old invite *hints* go stale; room keys and new invites are unaffected).
- Note for local packaging: `tauri build` now expects the staged sidecar at `src-tauri/binaries/ssf-p2p-node-<host-triple>[.exe]` (CI does this automatically in step 4b of the release workflow).
- Carries the v0.19.0 default-pinned swarm port (UDP 44442) unchanged — the bundled node pins it out of the box.

## v0.19.0 — 2026-07-10

### A Door With a Number On It — Default-Pinned Swarm Port (UDP 44442)

- **The node's iroh UDP socket is now pinned to 44442 by default** (previously a random port per launch — impossible to forward ahead of time). Router port-forwards, firewall rules, and invite hints finally survive restarts, and "forward UDP 44442 on the host's router" becomes a one-time, repeatable instruction — reachability rung 3 with zero configuration. Port choice verified against the IANA registry (2026-07-10): 44442 is unassigned for both TCP and UDP (nearest assignments 44444/44445 are TCP-only), sits in the non-privileged User Ports range, and is outside the OS ephemeral range.
- **Override & opt-out:** `SSF_IROH_PORT=<port>` still overrides the pin (unchanged); new `SSF_IROH_PORT=0` restores the pre-0.19.0 random per-launch bind. IPv6 keeps its default bind either way.
- **Graceful degradation:** the default pin probes UDP 44442 before binding — if a foreign process already owns it, the node logs a warning and falls back to a random port instead of dying (an auto-spawned node must not take the app down with it). An **explicit** `SSF_IROH_PORT` that cannot bind still fails loudly, as before.
- **Joiner guidance updated:** the SpacePhone's failed-dial message now gives the actual instruction ("one side needs to forward UDP 44442 on their router") instead of only naming an env var.
- **Known limits (unchanged physics):** a pinned port makes the manual rung possible and external endpoints predictable (which the ChiaHub punch lane will exploit) — it does not change NAT physics. Two stations both behind unconfigured home routers still need one reachable side: the UDP 44442 forward, UPnP, or a relay (`SSF_RELAYS`).

## v0.18.0 — 2026-07-10

### One Open Door Serves the Room — Hub Relay, Membership Gossip & the ChiaHub Scaffold

- **Hub relay (N-player rooms through one reachable member):** a node now forwards remote peers' envelopes and movement ticks to the room's *other* remote peers — spokes behind closed routers finally see **each other**, not just the hub. Loop-safe by construction: a bounded `blake3(origin, seq, payload)` dedup cache drops echoes, and node→node ticks carry a hop byte so they fan out exactly once. (Previously a three-player room was silently pairwise: each joiner saw only the hub.)
- **Membership gossip + automatic mesh upgrades:** relayed envelopes keep the *original* sender's node ID and dial hints instead of being overwritten by the hub — so members learn about each other through any shared connection. When a gossip-learned peer appears, the smaller node ID attempts a direct dial (instant win on the same LAN via mDNS, or wherever NAT physics allow); failures stay hub-relayed with a console note, successes appear in the Bridge row as a mesh upgrade.
- **ChiaHub lane scaffold (C0, per [REVIEW-20260710-ChiaHub.md](brainstorming/REVIEWS/REVIEW-20260710-ChiaHub.md)):** the chain-independent half of the Chia rendezvous lane ships and is unit-tested — signed presence records (ed25519 by the node's swarm key), room-key-sealed encryption (XChaCha20-Poly1305 via `blake3` domain-separated derivation), and epoch-rotated lookup hints. `SSF_CHIA_LANE=1` runs a startup crypto self-test and reports lane status. **Chain IO deliberately does not ship yet** — publish/resolve lands in C1 after spike B-7 verifies the chia-wallet-sdk API surface, on testnet11 with faucet TXCH (no real XCH needed until the mainnet privacy gate).
- **Wire note:** node→node ticks are now 14 bytes (hop flag + 13-byte tick). 0.18.0 nodes accept 13-byte ticks from 0.17.0 peers (without relaying them), but 0.17.0 nodes drop 0.18.0 ticks — run matching versions on all machines when testing.
- **Known limits:** mesh upgrades succeed only where direct reachability exists (open NAT / LAN / IPv6-friendly firewalls) — hostile pairs stay hub-relayed by design; hub tick fan-out costs the hub ~N× upstream (fine at playtest scale); S2 room challenge and the beacon toggle remain the top open items.

## v0.17.0 — 2026-07-09

### The Bridge Actually Bridges — Cross-Machine Join Fix Pack (from the first v0.16.0 playtest)

The v0.16.0 two-machine invite test failed silently. Live diagnosis on the joiner found one hard code bug and four reachability gaps — all fixed here:

- **🐛 Browser now reads node-initiated streams (the hard blocker):** the node forwards remote peers' updates by opening new WebTransport streams toward the browser — and no code ever accepted them, so every bridged update died at the local node **even on a perfect network** (LAN included). The browser now drains `incomingBidirectionalStreams` and feeds bridged `ysync` envelopes into the shared room state.
- **Bridge status is visible:** the node now pushes `bridge` envelopes (`dialing` / `connected` / `failed` + error detail) to the browser; the network panel gained a **Bridge** row and the SpacePhone logs dial outcomes with actionable guidance. No more staring at a quiet room wondering if anything happened.
- **🐛 Invite hints refresh live:** `/api/fingerprint` now re-reads the iroh endpoint's address view on every request instead of serving a boot-time snapshot — portmapper-mapped and externally-configured public addresses now actually reach invites (in 0.16.0 they never could).
- **🐛 Shareable link carrier:** invites minted inside the packaged app used the WebView-internal origin `http://tauri.localhost/…`, which resolves nowhere outside the app. Packaged-app invites now mint as `ssf://room?seed=…` (the import box already accepts any URL carrying `?seed=`); dev-server invites stay clickable http links.
- **Manual reachability rungs wired (§4.1.2 ladder):** `SSF_IROH_PORT` pins the iroh UDP port so a router port-forward is actually possible (default port is random per launch), and `SSF_EXTERNAL_ADDRS` advertises forwarded public addresses to peers, invites, and the DHT.
- **mDNS same-LAN discovery:** bare room keys + node IDs now resolve on the local network with zero hints and zero internet (`iroh-mdns-address-lookup`; `SSF_NO_MDNS=1` to disable).
- **Known limits (unchanged physics):** two stations that are BOTH behind unconfigured home routers still cannot punch to each other without one reachable side — use `SSF_IROH_PORT` + a UDP port-forward on one side, or stand up a player-run relay (`SSF_RELAYS`). The relay/beacon lane and the S2 room challenge remain the top backlog items.

## v0.16.0 — 2026-07-09

### The Sovereign Node Ships — Mainline DHT Discovery & Auto-Spawned P2P Backbone

- **BitTorrent Mainline DHT discovery (zero servers, zero DNS, zero registration):** the node now publishes its ed25519-signed dial addresses to — and resolves other players' node IDs from — the public BitTorrent Mainline DHT (`iroh-mainline-address-lookup`). A bare invite (room key + node ID, no address hints at all) can now find its host across networks with **no relay, no DNS record, and no third-party service**. Full addresses are published (not just relay pointers) so DHT-resolved dials can go direct. Privacy/strict mode: set `SSF_NO_DHT=1` to keep your addresses off the public DHT.
- **App now runs the real P2P node (🐛 fixes silent separate-rooms bug):** the packaged app previously served rooms from an embedded iroh-less listener, so two players importing the same invite silently landed in two disconnected same-key rooms — no error shown. The Tauri shell now: (1) uses an already-running `ssf-p2p-node` if one owns UDP 4443, (2) otherwise spawns `ssf-p2p-node.exe` found next to the app executable (or in the dev tree), killing it again on app exit, and (3) only then falls back to the embedded listener, loudly labelled as non-bridging. 
- **`ssf-p2p-node.exe` ships as a release asset:** download it from this release alongside the installer and drop it next to the installed `StarStationFurlong.exe` (or just run it before launching the app). The app picks it up automatically — this is the interim delivery until the node is bundled inside the installers.
- **NAT auto-mapping restored (🐛):** the iroh `portmapper` feature (UPnP / NAT-PMP / PCP — reachability rung 1 of the plan's ladder: most home routers can be asked to open a port automatically) had been silently disabled by the Windows linker workaround (`default-features = false`). It is explicitly re-enabled — many hosts become directly reachable with zero configuration.
- **Testing recipe (two machines):** both sides: install v0.16.0 + place `ssf-p2p-node.exe` next to the app (or run it first). Host: launch, `Copy Invite`, send it. Joiner: paste the invite. Same-LAN joins use direct hints; cross-network joins use portmapper-opened ports and DHT-resolved addresses. `SSF_RELAYS` on both sides remains the optional lane for hostile-NAT-both-sides topologies.
- **Known limits (tracked in TODO):** node not yet bundled inside installers (separate asset this release); embedded fallback listener still present (retirement planned); room-challenge handshake (S2) still unwired; WebTransport certificate still rotates per launch; hostile-NAT-both-sides still needs a player-run relay (`SSF_RELAYS`) or one reachable member; cross-network run-proof is the goal of this release's playtest.

## v0.15.0 — 2026-07-08

### One-Link Room Invites — "The Room Is the Key" (Cabal-inspired discovery, Phase A wired)

- **One-button Copy Invite:** the network panel's dual LAN/WAN share fields, per-scope copy buttons, and mandatory address entry are gone. One `Copy Invite` button mints a single link that works for every friend — the sharer is never asked a network-topology question. Manual address entry + Self-Test live on as an optional override inside a diagnostics drawer.
- **Room-key-first tickets (v2 seeds):** invites now carry a persistent 32-byte room key as the room's identity, plus optional autogenerated member dial hints (`memberHints[]`: iroh node IDs, relay URLs, direct addresses). Links identify the *room*, not a machine — they survive host restarts and address changes, and a hint-less link remains a valid (slower) invite.
- **Always-bridge imports:** both invite entry points (paste + `?seed=` URL) now route through the local companion node via `resolveBridgeBootstrap`, so every join attempt can use the iroh hole-punch lane — the loopback-only special case is retired.
- **Dialable invite hints (🐛 fix):** direct-address hints are now derived from the iroh endpoint's reachable addresses (`endpoint.addr().ip_addrs()`, unspecified addresses filtered) instead of the bind socket — previously invites advertised the undialable `0.0.0.0:<port>`.
- **Local node connect fixes (playtest-driven):** the fingerprint API's CORS allowlist now accepts any loopback origin on any port (Vite fallback ports no longer break discovery), adds the Windows Tauri WebView origin `http(s)://tauri.localhost` (the packaged Windows app previously could not fetch its own fingerprint), supports operator-extendable public origins via `SSF_ALLOWED_ORIGINS`, and answers Chromium private-network preflights (`Access-Control-Allow-Private-Network: true`) for the future public-web lane. Applied to both the standalone node and the Tauri sidecar.
- **Sovereign relay scaffolding:** the non-resolving placeholder relay default is removed — relay endpoints come exclusively from the player/community-controlled `SSF_RELAYS` env (comma-separated), and outbound dials use every ticket hint (`with_relay_url` / `with_ip_addr`). Hole-punch coordination infrastructure remains 100% player-ownable: no DNS, no CA, no registration required (self-signed relay certs via custom trust anchors are the documented path).
- **Housekeeping:** node identity keys (`iroh_node_id.key`) are now gitignored; forwarded envelopes propagate the sender's relay/direct hints for automatic back-dials.
- **Known limits (tracked in TODO):** room-challenge handshake (S2) not yet wired; no community relay list ships by default yet (set `SSF_RELAYS` to enable the relay lane); WebTransport certificate still rotates per node launch; cross-network hole-punch run-proof pending — this line is the first with all wiring landed for that test.

## v0.12.0 — 2026-07-07

### Sovereign Full-Duplex NAT Hole-Punch Swarm (Zero-Config Bridge)

- **Asymmetric Base64 Serialization:** Bypasses browser-sandbox limitations by implementing transparent Base64 binary adapters (`u8ToB64`/`b64ToU8`), successfully resolving JSON parser bugs on yrs sequence streams.
- **Sovereign Community Relays:** Integrated a robust, customizable Relay mode (`RelayMode::Custom`) with secure fallback coordination servers on the native backdrop, bypassing public, rate-limited public rendezvous channels cleanly.
- **ALPN ssf Inbound Handshaking:** Enabled explicit `.alpns(b"ssf")` on the native Iroh listener builder, unblocking incoming connections on UDP/QUIC pathways.
- **Full-Duplex Peer Loops:** Connected a bidirectional, mutual read loop to automatic outbound QUIC dial-up streams. If Computer A dials Computer B, both nodes open and parse parallel streams symmetrically with zero duplicate routing.
- **Sovereign REST API Sandboxing:** Implemented a secure CORS allowed-origin verification filter (locking to `tauri://localhost` and Vite dev origins) on the HTTP loopback discovery endpoints, locking out cross-site capabilities and super-cookie exploits.
- **Persistent Swarm Identity:** Configured automatic filesystem persistence of Iroh Node cryptographic secret keys to `iroh_node_id.key` so shared Dial Keys survive restarts.
- **Decentralized Loopback Swapping:** Enabled automatic loopback swap intercepts on *both* manual copy-link imports and direct browser URL `?seed=` parameters.

## v0.11.0 — 2026-07-07

### Modular Grid-Aligned Rooms & Multi-Link P2P Seeding

- **1.0m Tile-Grid Alignment:** All cozy lobby assets (fireplace hearth walls, sofas, coffee tables, armchairs, lamp tables, bar cabinets, and floor rugs) are aligned precisely to whole-number boundaries along a uniform $1.0\text{m} \times 1.0\text{m}$ grid, preventing player waypoint drift.
- **Variable-Width sliding Doors:** conformed North/South doors to taking exactly $1.0\text{m}$ of width (1 tile) and East/West doors to taking exactly $2.0\text{m}$ (2 tiles), ensuring perfect structural brick integration.
- **Aspect-Ratio Adaptive Frustums:** Camera zooms automatically compute viewport widths and heights relative to monitor dimensions, resolving squeezed isometric room projections.
- **Multi-Link WAN/LAN Seed Generator:** Separates the network control panel into discrete LAN and Internet link parameters so players can copy and share the correct IP addresses.
- **Custom Re-Connection Helpers:** Adds a RETRY click target to immediately execute certificate restructures on backends without page reloads.

## v0.10.0 — 2026-07-06

### Cinematic Camera Trajectories & Flat Astronomical Overlays

- **Quadratic Bezier Zoom Paths:** Transitioning to First-Person ($Level\ 1$) now maps camera positions along a smooth Quadratic Bezier Curve ($P_0 \to P_1 \to P_2$). This begins relative to your clone's dynamic coordinates instead of absolute roots, eradicating perspective camera jump.
- **Interpolated Gaze Vector Panning:** Camera orientation pans through linear interpolations ($LERP$) relative to the back of the clone's neck before granting mouse-look control, and fades clone opacity transparently.
- **Matte Silhouette Level 4 Shaders:** Capsule models are simplified into structural slate-matte gray geometries upon stepping to Level 4 (Space Station Assemblies), hiding cluttered interior furnishings.
- **Top-Down Level 5 Astronomy Spin:** Zooming to Level 5 and above spins the orthographic camera into a flat top-down tactical viewport ($Position = 0, 60, 0$), looking straight down down the Y-axis.
- **Zoom In / Zoom Out Map Controls:** Binds floating overlay "+" and "-" keys to trigger coordinate scaling without requiring physical key inputs, and strips obsolete HUD controls panels.
- **Room Info HUD card & Yjs CRDT Sync:** Renders a dedicated card tracking Room Name and Owner over synchronized CRDT maps.
- **Self-Dismissing SpacePhone Tooltip:** Emits an absolute helpful "Click parent / Tab" overlay bubble that permanently records to local storages upon active closure.

## v0.9.0 — 2026-07-05

### Multi-room Docking Port System (`docking.ts`)

- **4-Wall Doors:** Placed moving metal sliding door panels (leaves) and carbon frames at the geometric centers of each lobby limits: North, South, East, and West.
- **Keypad Control Panel:** Keypad golden terminal is interactive. Click raycasts trigger floating overlay context menus to manage locked states, security pin codes, and remote room seed links.
- **Blinking LED Warnings:** Remote co-hosts see a flashing yellow indicator LED above the target door keypad upon receiving a pairing request. Owners can accept or reject couplings on the fly.
- **Adjacent Room Projection:** Paired doors automatically slide open, projecting a translucent "gray-box representation" of the connected, adjacent cockpit outside the doorway walls.

## v0.8.0 — 2026-07-05

### Standalone P2P Swarm Hub (`ssf-p2p-node`)

Implemented a dedicated console binary facilitating direct, zero-config internet connections:
- Launches a native Iroh Swarm endpoint alongside WebTransport servers.
- Automatically routes inbound/outbound streams. Passes chat and datagram movement ticks over direct Iroh hole-punched QUIC streams, bridging them safely into browser contexts.
- Exposes your unique Iroh Node ID to the browser so "Bootstrap Links" embed your Dial Key. PASTING a seed link triggers a direct P2P dial back to the host, bypassing port-forwarding requirements completely.

### Solar System Map

Designed a lightweight 2.5D top-down system map:
- Supports central star Sol, circular inner orbits, and highly accurate elliptical orbits (Planet Sovereign with 0.15 eccentricity).
- Models stable Sovereign L4 and L5 Lagrange points, carrying minable resource nodes of Iron Ore, Silica, and Rare Minerals.
- Progress travel distances are completely computed deterministically using simulation ticks, respecting 'derive-don't-tick' database pruning rules.

### Keyboard Multi-Scale views

Programmed smooth view transitions using keyboard `+` and `-` inputs:
- Leverages 8 detailed levels: First Person, Room View, Module structuring, entire H-shaped Space Station outlines, Lagrange systems, Heliocentric Solar rings, Galaxy arms, and universe path seeds.
- Level 1 First-Person: Swaps active orthographic cameras to a genuine `THREE.PerspectiveCamera` positioned at eye height, and binds pointer-locked free mouse looking (yaw/pitch).
- Level 1 Transition: Smoothly glides the camera along a trajectory into the player clone's head, gradually fading player opacity.
- Zoom Out Blink: Closing the perspective camera triggers full-screen organic eyelid blinks to seamlessly re-reveal standard room views.

### SpacePhone battery indicator

- SpacePhone header now parses and shows a retro cellphone signal bar graphic.
- Displays connection speeds (`LTE` on active ports, `3G` on CGNAT fallbacks, and `NO SIGNAL` on OFFLINE).

## v0.6.0 — 2026-07-05

### Click-to-sit navigation

Chairs and sofas are now interactive navigation targets:

- **Click a chair** and the avatar A*-walks to the front of that seat, turns so
  its back faces the chair, and slides down into a seated pose (`SIT_CHAIR` rig
  state — folded legs, lowered torso).
- **Click anywhere else or press WASD while seated** and the avatar stands up at
  the front of the chair first, then continues on the requested route — pending
  destinations and pending seat-swaps are queued through the stand-up animation.
- 18 seats defined in a new shared `seats.ts` module (5 armchairs per wall,
  3 back-sofa cushions, 2 front-sofa cushions approached from the open sides —
  the middle front cushion is blocked by the coffee table, matching the room's
  real walkable geometry). Seat fronts sit outside the collision AABBs so
  pathfinding and the collision resolver never fight; the final slide onto the
  seat is scripted and bypasses collision.
- Debug HUD `NAV` row now reports the live sit phase
  (`APPROACH / FINE / TURN / SIT_DOWN / SEATED / STAND_UP`).

### Sovereign network bootstrapping + connection transparency

Every player's node is part of the hosting fabric by default (the Rust node
serves on `0.0.0.0` whenever the app runs) — only their connection can block it.
The network details panel now reflects that model:

- **Bootstrap a network**: enter the address friends can reach you at (LAN IP,
  public IP/DNS, optional `:port`) and click **Bootstrap Link** — the game builds
  a `?seed=` URL from *your own node's* certificate fingerprint, with no prior
  connection required. This is how the first node of a network comes online
  (interim mechanism until on-chain Chia peer publishing lands).
- **Self-Test**: dials your own node at the entered address from the browser to
  verify reachability (LAN results are definitive; public addresses are marked
  inconclusive when routers refuse hairpin dials).
- **New status rows**: `Net Type` (wifi/cellular via the Network Information API
  where available — cellular flags likely CGNAT), `Address Type`
  (LOOPBACK / LAN / PUBLIC classification), and `Seeding`
  (`SEEDING · verified` / `SEEDING · untested` / `BASIC · join-only` /
  `BLOCKED · not reachable` / `RESTRICTED? · UDP/QUIC dial failed`).
- Locked-down network hint: when a dial to a remote peer fails while the page
  itself works, the panel calls out that the network (campus/office style) is
  likely dropping UDP/QUIC.
- Share links pointing at loopback now substitute the reachable bootstrap
  address (previously they embedded a useless `127.0.0.1`).

### Controls

- SpacePhone chat overlay now toggles with `Tab` (was `P`); Tab no longer
  cycles browser focus, and closing the phone releases the chat input focus.

## v0.5.0 — 2026-07-04

### Layout & navigation parity with the navigation demo (PR #11)

The game now matches the look and feel of `prototypes/0.0.4-navigation-demo`:

- **Locked orthographic camera** — parallel-projection camera fixed at an elevated
  three-quarter isometric angle (position never changes; no more two-stage cinematic zoom).
- **One-click entry** — a single click morphs the station planet into the lobby platform
  and connects networking; subsequent clicks are routed to navigation.
- **Hybrid A\* point-and-click + WASD navigation** with the demo's post-review fixes:
  - `MANUAL | WAYPOINT` player state machine — WASD always wins and clears the path.
  - Two-pass X-then-Z AABB collision resolution in *both* manual and waypoint modes.
  - Shared `obstacles.ts` module — single source of truth for player collision and
    the A\* obstacle grid.
  - Dedicated `hud.ts` module, removing the `main → world → player → main`
    circular-import chain.
  - 8-way directional facing snap while walking; animated destination reticle.
- **Lobby layout** — right-side wall, windows, and amber light strip removed so the
  locked camera has a clear view into the lobby; NPC removed so only the voxel robot
  character remains; nearest-neighbour (pixel-crisp) texture sampling throughout.
- **HUD** — debug HUD gains `CAM: ORTHO · LOCKED` and live `NAV: MANUAL/WAYPOINT` rows;
  control bar now shows the "🖱 Click floor — Navigate" hint alongside WASD and
  SpacePhone hints.

### Network status info box (PR #17)

New expandable **Network Details** panel under the debug HUD:

- Live per-session stats: **Peers Seen, Ticks Received, Ping/Pong counters, Datagrams,
  Session uptime, and Endpoint URL** — alongside the existing LINK / RTT / LOSS HUD rows.
- **Share seed links**: copy a `?seed=` URL encoding the current room bootstrap
  (WebTransport URL + certificate hashes) so another player can join your node.
- **Import seed links**: paste a link or raw seed to override the default bootstrap,
  with `https:`-only URL validation, cert-hash checks, and accessibility labels.

### Other

- `prototypes/0.0.4-navigation-demo` added — the hybrid-navigation demo this release's
  game changes are ported from (PR #11).
- Version bumped to 0.5.0 across `package.json`, `package-lock.json`, `Cargo.toml`,
  `Cargo.lock`, and `tauri.conf.json`.

## v0.4.0

- Tauri icons added; wtransport 0.6 API fixes; `chosen_room` shared via `Arc<Mutex>`
  so the datagram path sees the room set by the stream task (PRs #15 and earlier).

## v0.3.0

- First release with a working `publish-tauri-binaries` workflow (PR #14);
  `package-lock.json` committed for CI caching.

## v0.2.0

- Compiled Rust targets removed from tracking; `.gitignore` hygiene; system spikes,
  Trust & Safety design, and release scripts committed.
