# Prototypes & Demos

This directory is for quick, throwaway code, proof-of-concepts, and playable demos to test game mechanics before implementing them properly in `src/`.

## Available Demos

Folders are named `<release-version>-<demo-name>` — the version prefix records
which release line the demo targeted. `0.0.x` demos are frozen snapshots from
before versioned releases began; the highest-versioned core-loop folder is the
live game.

| Demo | Description |
|---|---|
| [`0.11.0-core-loop-demo`](0.11.0-core-loop-demo/) | **The game (current release target).** Complete conformant $1.0\text{m}$ room layout grids. Houses seats, tables, and cabinets on whole integers, and builds wide $2.0\text{m}$ (East/West) and narrow $1.0\text{m}$ (North/South) sliding door units. |
| [`0.10.0-core-loop-demo`](0.10.0-core-loop-demo/) | Frozen v0.10.0 release snapshot: Seamless Quadratic Bezier zoom-in trajectories, interactive Room details maps, flat top-down system transitions, responsive "+/-" map scale bounds, and self-dismissing tooltips. |
| [`0.9.0-core-loop-demo`](0.9.0-core-loop-demo/) | Frozen v0.9.0 release snapshot: Interactive center-wall docking doors, security pin codes, remote handshakes, and adjacent translucent grey-box projections. Inherits standard system maps and keyboard multiscale zoom. |
| [`0.8.0-core-loop-demo`](0.8.0-core-loop-demo/) | Frozen v0.8.0 release snapshot: Fully modular H-shaped space stations, 2.5D Keplerian orbit paths, stable L1-L5 Lagrange zones, and multi-scale + / - key zooms. Adds a dedicated iroh P2P standalone node router supporting internet connections. |
| [`0.7.0-core-loop-demo`](0.7.0-core-loop-demo/) | Frozen v0.7.0 release snapshot: Kepler system map, First-Person switchable camera + pointer locked mouse look, and SpacePhone cellphone weather indicator. |
| [`0.5.0-core-loop-demo`](0.5.0-core-loop-demo/) | Frozen v0.5.0 release snapshot: locked orthographic camera, hybrid WASD + point-and-click A* navigation, WebTransport multiplayer + SpacePhone chat |
| [`0.0.1-core-loop-demo`](0.0.1-core-loop-demo/) | Original Phase 1 core loop demo (frozen): perspective camera, two-click cinematic entry, NPC with sit/stand behavior, Sprint-3 networking |
| [`0.0.2-ortho-camera-demo`](0.0.2-ortho-camera-demo/) | Same as the original core loop but with orthographic (parallel) projection and a fully locked camera |
| `03-character-model-demo` (PR #9) | Rigged voxel humanoid player with hierarchical joints, lerp state machine, and 8-way visual snapping — folded into demo 0.0.4 rather than kept as its own folder |
| [`0.0.4-navigation-demo`](0.0.4-navigation-demo/) | Hybrid point-and-click / WASD navigation: A* pathfinding, animated waypoint reticle, dual navigation modes |

## Releasing a different demo as the app

The packaged release always uses the Tauri shell from
[`0.9.0-core-loop-demo/src-tauri`](0.9.0-core-loop-demo/src-tauri/) (window, Rust
WebTransport node, icons, app version) — but the **frontend it renders is
switchable**. The [release workflow](../.github/workflows/release.yml) builds
whichever prototype `env.RELEASE_FRONTEND` points at and merges a config
overlay (`--config release-frontend.json`) so `frontendDist` targets that
demo's `dist/`.

To ship a different demo:

1. Edit `RELEASE_FRONTEND` at the top of
   [release.yml](../.github/workflows/release.yml)
   (e.g. `prototypes/0.0.4-navigation-demo`).
2. Make sure that demo has a committed `package-lock.json` and a
   `npm run build` script outputting to its local `dist/` (0.6.0, 0.5.0 and 0.0.4 qualify).
3. Commit, bump versions in `src-tauri/tauri.conf.json` etc. as usual, and
   push a `vX.Y.0` tag.

Starting the next release line is a plain folder copy: duplicate the current
game folder to the new version (e.g. `0.6.0-core-loop-demo` →
`0.7.0-core-loop-demo`, excluding `node_modules/` and `dist/`), update the
internal versions, and point `RELEASE_FRONTEND` at it — the previous folder
stays frozen as the shipped snapshot.

Note: window title and app version still come from the shared shell's
`tauri.conf.json`; demos that never call the Rust node simply render as
static frontends inside it.
