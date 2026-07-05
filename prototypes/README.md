# Prototypes & Demos

This directory is for quick, throwaway code, proof-of-concepts, and playable demos to test game mechanics before implementing them properly in `src/`.

## Available Demos

Folders are named `<release-version>-<demo-name>` — the version prefix records
which release line the demo targeted. `0.0.x` demos are frozen snapshots from
before versioned releases began; the highest-versioned core-loop folder is the
live game.

| Demo | Description |
|---|---|
| [`0.7.0-core-loop-demo`](0.7.0-core-loop-demo/) | **The game (current release target).** Inherits features from 0.6.0 including click-to-sit, bootstrap networking and the Tab phone, ready for Phase 1 Sprint 4 |
| [`0.6.0-core-loop-demo`](0.6.0-core-loop-demo/) | Frozen v0.6.0 release snapshot: click-to-sit chair navigation, network bootstrapping (Bootstrap Link + Self-Test + seeding status), and Tab-toggled SpacePhone on top of 0.5.0 |
| [`0.5.0-core-loop-demo`](0.5.0-core-loop-demo/) | Frozen v0.5.0 release snapshot: locked orthographic camera, hybrid WASD + point-and-click A* navigation, WebTransport multiplayer + SpacePhone chat |
| [`0.0.1-core-loop-demo`](0.0.1-core-loop-demo/) | Original Phase 1 core loop demo (frozen): perspective camera, two-click cinematic entry, NPC with sit/stand behavior, Sprint-3 networking |
| [`0.0.2-ortho-camera-demo`](0.0.2-ortho-camera-demo/) | Same as the original core loop but with orthographic (parallel) projection and a fully locked camera |
| `03-character-model-demo` (PR #9) | Rigged voxel humanoid player with hierarchical joints, lerp state machine, and 8-way visual snapping — folded into demo 0.0.4 rather than kept as its own folder |
| [`0.0.4-navigation-demo`](0.0.4-navigation-demo/) | Hybrid point-and-click / WASD navigation: A* pathfinding, animated waypoint reticle, dual navigation modes |

## Releasing a different demo as the app

The packaged release always uses the Tauri shell from
[`0.7.0-core-loop-demo/src-tauri`](0.7.0-core-loop-demo/src-tauri/) (window, Rust
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
