# StarStation Furlong: Character Model Demo

This prototype builds on `02-ortho-camera-demo` and introduces a rigged voxel player character.

It includes:
- Everything from `02-ortho-camera-demo` (orthographic camera, locked view, lobby scene)
- **Rigged voxel player character** — hierarchical pivot joints (torso, head, arms, legs)
- **State machine with lerp transitions** — idle, walk, sit_chair, sit_ground
- **8-way decoupled visual snapping** — masterGroup tracks continuous physics angle; visualGroup snaps to nearest 45°
- **WASD movement** — the player character walks around the lobby with full obstacle collision

## Character model differences from `02-ortho-camera-demo`

| Feature | Ortho Camera Demo | Character Model Demo |
|---|---|---|
| Player visual | Floating Mars planet | **Rigged voxel humanoid** |
| Player movement | Static (sky position) | **WASD walk around lobby** |
| Animation | Orbital ring spin | **Walk cycle / idle / sit states** |
| Facing direction | N/A | **8-way snapped rotation** |

## Key Implementation Concepts

### Hierarchical pivot joints (`src/voxelCharacter.ts`)

Each limb is a `THREE.Group` positioned at its joint (shoulder / hip).
The mesh geometry is shifted *downward* so rotation swings from the joint:

```ts
const armGeo = new THREE.BoxGeometry(0.3, 0.8, 0.3);
armGeo.translate(0, -0.4, 0);   // hang below shoulder pivot
this.leftArm.add(new THREE.Mesh(armGeo, bodyMat));
```

### Lerp-based state transitions

`THREE.MathUtils.lerp` ensures smooth transitions between poses.
When the player sits, the torso Y drops gradually rather than snapping instantly.

### 8-way decoupled snapping

`masterGroup` tracks the exact continuous angle for physics/camera.
`visualGroup` reverses the logical rotation then adds the snapped 45° increment:

```ts
this.masterGroup.rotation.y = this.logicalRotation;
this.visualGroup.rotation.y = -this.logicalRotation + snappedAngle;
```

## 1. Prerequisites

Install the following software before running the demo:

1. Install Node.js 20 or newer.
2. Install npm.
3. Install Git if you need to clone the repository.
4. Use a modern desktop browser such as Chrome, Edge, or Safari.

## 2. Open the Project

```bash
cd /path/to/StarStationFurlong/prototypes/03-character-model-demo
```

## 3. Install Dependencies

```bash
npm install
```

## 4. Run the Demo in Development Mode

```bash
npm run dev
```

Open the URL shown in Terminal (default: `http://localhost:5173/`).

## 5. Interact with the Demo

After the page loads:

1. Click `Click to Enter` to expand the platform.
2. Use `W`, `A`, `S`, `D` to move the voxel player character around the lounge.
3. The character transitions between idle and walk animations automatically.
4. Stop near a sofa or chair for about 1.2 seconds to trigger the NPC sit animation.
5. The debug HUD shows the player's current XZ position.

## 6. Build the Project

```bash
npm run build
```

## 7. Project Structure

```text
03-character-model-demo/
├── public/              # Static assets
├── src/                 # Game source files
│   ├── main.ts          # Entry point
│   ├── renderer.ts      # Orthographic camera setup
│   ├── world.ts         # Station planet, platform morph, world logic
│   ├── player.ts        # Player entity — wraps VoxelCharacter, handles movement
│   ├── voxelCharacter.ts # Rigged voxel state machine (new in this demo)
│   ├── npc.ts           # Sprite NPC companion
│   ├── input.ts         # Keyboard input handling
│   └── network/         # Placeholder networking files
├── index.html           # Main page shell and UI overlay
├── package.json         # Scripts and dependencies
└── vite.config.ts       # Vite configuration
```

## 8. Current Scope

Included now:
- Local rendering with orthographic projection and locked isometric camera
- Rigged voxel player character with idle/walk animation states
- 8-way directional snapping and lerp-based pose transitions
- WASD player movement with obstacle collision
- NPC sprite companion with sit/stand behavior

Not included yet:
- Multiplayer sync
- Chat
- Multi-room navigation
- Tauri shell integration

