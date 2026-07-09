# Changelog

All notable changes to StarStation Furlong releases. The packaged application lives in
[prototypes/0.17.0-core-loop-demo](prototypes/0.17.0-core-loop-demo/) and is built by the
[release workflow](.github/workflows/release.yml) when a `vX.Y.0` tag is pushed.
Prototype folders are named `<release-version>-<demo-name>`; superseded demos stay
frozen under their original version prefix (e.g. the pre-0.5.0 game is preserved at
[prototypes/0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/)).

## Unreleased

- In progress for Phase 2 Star Swarm features.

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
