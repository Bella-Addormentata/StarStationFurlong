# StarStation Furlong: Ortho Camera Demo

This prototype is a camera-tweaked variant of `01-core-loop-demo`.

It includes:
- Vite + TypeScript project setup
- Three.js rendering
- **Orthographic (parallel) projection** — no perspective distortion
- **Locked camera** — fixed isometric position and angle, never moves
- A Mars-themed station planet and lobby scene
- WASD-controlled NPC movement with collision and sit/stand behavior

## Camera differences from `01-core-loop-demo`

| Feature | Core Loop Demo | Ortho Camera Demo |
|---|---|---|
| Projection | Perspective | **Orthographic** |
| Camera animations | Cinematic zoom-in on click | **None — camera locked** |
| Entry flow | Two-click (approach → lobby) | **One-click (lobby immediately)** |

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
cd /path/to/StarStationFurlong/prototypes/02-ortho-camera-demo
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
- `yjs`
- `simple-peer`
- `msgpackr`

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

1. The station appears as a Mars-like planet viewed from a fixed isometric angle.
2. The debug HUD shows **CAM: ORTHO · LOCKED** confirming the camera mode.
3. Click `Click to Enter` to expand the platform immediately (no camera animation).
4. Use `W`, `A`, `S`, `D` to move the NPC around the lounge.
5. Stop near a sofa or chair for about 1.2 seconds to trigger the sit animation.

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
02-ortho-camera-demo/
├── public/              # Static assets such as textures
├── src/                 # Game source files
│   ├── main.ts          # Entry point and entry flow (no camera animations)
│   ├── renderer.ts      # Orthographic camera setup, locked position/angle
│   ├── world.ts         # Station planet, platform morph, world logic
│   ├── player.ts        # Mars-like sky planet shown above the lobby
│   ├── npc.ts           # NPC movement, collision, and sitting behavior
│   ├── input.ts         # Keyboard input handling
│   └── network/         # Placeholder networking files for later phases
├── index.html           # Main page shell and UI overlay
├── package.json         # Scripts and dependencies
└── vite.config.ts       # Vite configuration
```

## 10. Troubleshooting

### `npm run dev` fails

Check the following:
1. Make sure you are inside the `02-ortho-camera-demo` folder.
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

This demo covers the same local rendering foundation as `01-core-loop-demo` with camera tweaks applied.

Included now:
- Local rendering with orthographic projection
- Locked isometric camera (position and angle never change)
- One-click lobby entry (no cinematic zoom)
- NPC movement, collision, and sit/stand interaction
- HUD and visual prototype work

Not included yet:
- Multiplayer sync
- Chat
- Multi-room navigation
- Tauri shell integration
