# StarStation Furlong: Core Loop Demo

This prototype is the playable demo for Phase 1, Task 1.1 in the execution plan.

It includes:
- Vite + TypeScript project setup
- Three.js rendering with a locked orthographic (isometric) camera
- One-click entry: the station planet morphs into the lobby platform
- Hybrid navigation: WASD manual movement plus point-and-click A* pathfinding with an animated waypoint reticle

## 1. Prerequisites

Install the following software before running the demo:

1. Install Node.js 20 or newer.
2. Install npm.
3. Install Git if you need to clone the repository.
4. Use a modern desktop browser such as Chrome, Edge, or Safari.

Recommended versions used during development:
- Node.js: 20.x
- npm: 10.x

### Optional: Create a Dedicated Local Environment

This is recommended for reproducibility, especially during review or handoff, but it is not required.

You can use any environment manager you prefer. Common options include:
- `nvm` for managing Node.js versions
- `conda` if your team already uses it

Example using `nvm`:

```bash
nvm install 20
nvm use 20
```

Example using `conda`:

```bash
conda create -n starstation nodejs=20 -y
conda activate starstation
```

Then verify the toolchain:

```bash
node --version
npm --version
```

## 2. Open the Project

1. Open Terminal.
2. Go to your local `StarStationFurlong` repository.
3. Enter the demo folder:

```bash
cd /path/to/StarStationFurlong/prototypes/0.15.0-core-loop-demo
```

Replace `/path/to/StarStationFurlong` with the folder where you cloned or copied the repository.

## 3. Install Dependencies

Run the following command inside the demo folder:

```bash
npm install
```

This installs the project dependencies defined in `package.json`, including:
- `three`
- `vite`
- `typescript`
- `yjs` (+ `y-protocols`, `y-indexeddb` â€” Sprint 3 sync/awareness)
- `msgpackr`

> Networking note: the transport is **raw WebTransport with `serverCertificateHashes`** per [STUDY-Architecture v006](../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) â€” `simple-peer` was removed with the v005/v006 revisions. The typed port seams live in `src/network/` (`protocol.ts` defines the contracts; Sprint 3 implements them).

## 4. Run the Demo in Development Mode

Start the development server:

```bash
npm run dev
```

What to expect:
1. Vite starts a local development server.
2. The terminal prints a local URL such as `http://localhost:5173/`.
3. If port `5173` is already in use, Vite automatically chooses another port such as `5174`.
4. The browser may open automatically.

If the browser does not open automatically:
1. Copy the local URL shown in Terminal.
2. Paste it into your browser.

## 5. Interact with the Demo

After the page loads:

1. The station appears as a Mars-like planet suspended in space.
2. Click `Click to Enter` â€” the planet morphs into the lobby platform (the camera stays locked).
3. Use `W`, `A`, `S`, `D` to move the character around the lounge.
4. Or click anywhere on the floor to navigate there automatically (A* pathfinding). Any WASD input immediately cancels the waypoint path.
5. Click a chair or sofa cushion â€” the avatar walks to its front, turns around, and sits down. Click elsewhere or press WASD to stand back up and continue.
6. Press `Tab` to open and close the SpacePhone chat overlay.

## 6. Build the Project

To verify the project builds successfully for production, run:

```bash
npm run build
```

Expected result:
1. TypeScript compiles successfully.
2. Vite outputs production files into the `dist/` folder.

## 7. Preview the Production Build

After building, you can preview the production version locally:

```bash
npm run preview
```

Then open the URL shown in Terminal.

## 8. Optional: Stop the Development Server

When you are done testing the demo:

1. Return to the Terminal window running Vite.
2. Press `Ctrl + C` to stop the server.

## 9. Project Structure

Key files and folders:

```text
0.15.0-core-loop-demo/
â”œâ”€â”€ public/              # Static assets such as textures
â”œâ”€â”€ src/                 # Game source files
â”‚   â”œâ”€â”€ main.ts          # Entry point, one-click entry flow, networking bootstrap
â”‚   â”œâ”€â”€ renderer.ts      # Three.js renderer, locked orthographic camera, lighting
â”‚   â”œâ”€â”€ world.ts         # Station planet, platform morph, click plane, world logic
â”‚   â”œâ”€â”€ player.ts        # Hybrid MANUAL/WAYPOINT player navigation state machine
â”‚   â”œâ”€â”€ pathfinding.ts   # A* grid pathfinding (8-directional, octile heuristic)
â”‚   â”œâ”€â”€ obstacles.ts     # Shared obstacle AABBs (collision + pathfinding)
â”‚   â”œâ”€â”€ waypoint.ts      # Animated destination reticle
â”‚   â”œâ”€â”€ hud.ts           # Debug HUD updater (shared, no circular imports)
â”‚   â”œâ”€â”€ input.ts         # Keyboard input handling
â”‚   â”œâ”€â”€ map.ts           # 2D Solar System map (elliptical, Kepler, Lagrange)
â”‚   â”œâ”€â”€ zoom.ts          # multi-scale 8 zoom levels + first person perspective camera + pointer locked mouse look + eye blinking
â”‚   â””â”€â”€ network/         # WebTransport + Yjs sync networking (Sprint 3)
â”œâ”€â”€ ssf-p2p-node/        # Standalone Rust direct Iroh Swarm P2P node
â”œâ”€â”€ index.html           # Main page shell and UI overlay
â”œâ”€â”€ package.json         # Scripts and dependencies
â””â”€â”€ vite.config.ts       # Vite configuration
```

## 10. Troubleshooting

### `npm run dev` fails

Check the following:
1. Make sure you are inside the `0.15.0-core-loop-demo` folder.
2. Make sure `node --version` shows Node.js 20 or newer.
3. Run `npm install` again if `node_modules/` is missing.
4. Make sure you are running the command inside the demo folder, not the repository root.

### Port `5173` is already in use

This is expected behavior.
Vite will automatically move to another available port and print the correct URL.

### Mars texture does not appear

Make sure this file exists:

```text
public/assets/mars.png
```

## 11. Current Scope

This demo currently covers the local rendering foundation for early Phase 1 work.

Included now:
- Local rendering with a locked orthographic camera
- Planet-to-platform morph entry flow
- Hybrid WASD + point-and-click A* navigation
- Real-time multiplayer sync over WebTransport (when a local Rust node is running)
- SpacePhone chat overlay (Yjs shared array)
- HUD with live network status and expandable network details panel

Not included yet:
- Multi-room navigation
