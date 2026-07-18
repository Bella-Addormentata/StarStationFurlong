# Changelog

All notable changes to StarStation Furlong releases. The packaged application lives in
[prototypes/0.29.0-core-loop-demo](prototypes/0.29.0-core-loop-demo/) and is built by the
[release workflow](.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed.
Prototype folders are named `<release-version>-<demo-name>`; superseded demos stay
frozen under their original version prefix (e.g. the pre-0.5.0 game is preserved at
[prototypes/0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/)).

## Unreleased

- The mesh increments deliberately deferred out of v0.29.0 (see that entry's scope note): **M5.5** per-tick authorship (amortized epoch-signature on the 13-byte tick lane — closes the last tick-spoof gap), **M5.4** lazy-pull graduation from opt-in (`SSF_MESH_LAZYPULL`) to on-by-default once its dropped-frame recovery is hardware-verified, and the **large-room hardening** (emit `graft`/`prune`/`px` so membership is symmetric above 8 nodes, plus the eclipse tier-diversity floor + IWANT rate limit). Also still ahead: **ChiaHub C1** chain IO (gated on spike B-7), **E4** furniture PERSISTENCE, **S3** presence (name tags + remote outfits), and the station-doc flight-control authority tree.

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
