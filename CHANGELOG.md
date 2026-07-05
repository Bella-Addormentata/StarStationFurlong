# Changelog

All notable changes to StarStation Furlong releases. The packaged application lives in
[prototypes/0.6.0-core-loop-demo](prototypes/0.6.0-core-loop-demo/) and is built by the
[release workflow](.github/workflows/release.yml) when a `vX.Y.0` tag is pushed.
Prototype folders are named `<release-version>-<demo-name>`; superseded demos stay
frozen under their original version prefix (e.g. the pre-0.5.0 game is preserved at
[prototypes/0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/)).

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
