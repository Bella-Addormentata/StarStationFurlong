/**
 * Player Entity
 * Drives a rigged VoxelCharacter with WASD movement inside the lobby.
 * Obstacle collision and 8-way directional snapping mirror the NPC logic.
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './main';
import { VoxelCharacter } from './voxelCharacter';

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
// Each box is inflated by PLAYER_R so we treat the player as a point.
const PLAYER_R = 0.38;
interface Box { x0: number; z0: number; x1: number; z1: number; }
const OBSTACLES: Box[] = [
  // Fireplace / bookcase wall (full width, front face z≈-5.55, depth 0.46)
  { x0: -5.00, z0: -5.95, x1:  5.00, z1: -5.08 },
  // Back 3-seater sofa (seat centre 0, -1.5 — size 2.4 × 0.96)
  { x0: -1.50, z0: -2.12, x1:  1.50, z1: -0.88 },
  // Front 3-seater sofa (seat centre 0, +3.2)
  { x0: -1.50, z0:  2.58, x1:  1.50, z1:  3.82 },
  // Left-wall armchairs × 5 merged (x=-4.3, z=-3.8/−2.4/−1.0/0.4/1.8)
  { x0: -4.82, z0: -4.32, x1: -3.78, z1:  2.32 },
  // Right-wall armchairs × 5 merged (x=+4.3)
  { x0:  3.78, z0: -4.32, x1:  4.82, z1:  2.32 },
  // Coffee table — back zone (centre 0, -3.3  size 1.6 × 0.9)
  { x0: -0.94, z0: -3.82, x1:  0.94, z1: -2.78 },
  // Coffee table — front zone (centre 0, +1.5  size 1.6 × 0.9)
  { x0: -0.94, z0:  1.02, x1:  0.94, z1:  1.98 },
  // Bar cabinet + stools (x≈5.24, z≈3.10, body 0.58 × 2.80 + stools)
  { x0:  4.48, z0:  1.48, x1:  5.92, z1:  4.72 },
  // Lamp table back-L
  { x0: -4.62, z0: -5.02, x1: -3.98, z1: -4.38 },
  // Lamp table back-R
  { x0:  3.98, z0: -5.02, x1:  4.62, z1: -4.38 },
  // Lamp table front-L
  { x0: -4.12, z0:  2.88, x1: -3.48, z1:  3.52 },
  // Lamp table front-R
  { x0:  3.48, z0:  2.88, x1:  4.12, z1:  3.52 },
];

// ── 8-way directional snap ───────────────────────────────────────────────────
const SNAP_INCREMENT = Math.PI / 4;

function snapTo8Ways(angle: number): number {
  return Math.round(angle / SNAP_INCREMENT) * SNAP_INCREMENT;
}

/**
 * Push (x, z) out of any penetrated obstacle AABB using the minimum axis.
 */
function resolveObstacles(x: number, z: number): { x: number; z: number } {
  let rx = x, rz = z;
  for (const b of OBSTACLES) {
    const ex0 = b.x0 - PLAYER_R, ex1 = b.x1 + PLAYER_R;
    const ez0 = b.z0 - PLAYER_R, ez1 = b.z1 + PLAYER_R;
    if (rx > ex0 && rx < ex1 && rz > ez0 && rz < ez1) {
      const dL = rx - ex0, dR = ex1 - rx, dT = rz - ez0, dB = ez1 - rz;
      const m = Math.min(dL, dR, dT, dB);
      if      (m === dL) rx = ex0;
      else if (m === dR) rx = ex1;
      else if (m === dT) rz = ez0;
      else               rz = ez1;
    }
  }
  return { x: rx, z: rz };
}

export class Player {
  /** Root group — consumed by World to toggle visibility and read position. */
  public mesh: THREE.Group;

  private character: VoxelCharacter;
  private logicalAngle = 0;
  private readonly SPEED = 2.8;
  private readonly BOUND = 5.2;

  constructor(scene: THREE.Scene) {
    this.character = new VoxelCharacter(scene);
    // Expose masterGroup as `mesh` so World can set .visible / .position
    this.mesh = this.character.masterGroup;
    // Place the player near the centre of the lobby
    this.mesh.position.set(0, 0, 1.5);
  }

  /**
   * Update player movement and character animation for the current frame.
   */
  update(deltaTime: number, inputManager: InputManager): void {
    const pos = this.mesh.position;
    const dir = inputManager.getMoveDirection();
    const moving = dir.x !== 0 || dir.z !== 0;

    if (moving) {
      const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      const nx = dir.x / len;
      const nz = dir.z / len;

      // Derive continuous angle, snap to nearest 45° for visual facing
      this.logicalAngle = snapTo8Ways(Math.atan2(nx, nz));

      // Slide on X axis first, then Z axis (two-pass AABB separation)
      const candX = Math.max(-this.BOUND, Math.min(this.BOUND, pos.x + nx * this.SPEED * deltaTime));
      const r1    = resolveObstacles(candX, pos.z);
      const candZ = Math.max(-this.BOUND, Math.min(this.BOUND, pos.z + nz * this.SPEED * deltaTime));
      const r2    = resolveObstacles(r1.x, candZ);
      pos.x = r2.x;
      pos.z = r2.z;

      this.character.setState('walk', this.logicalAngle);
    } else {
      this.character.setState('idle', this.logicalAngle);
    }

    // Advance the character's own animation clock
    this.character.update();

    // Push the HUD position readout
    updateDebugHUD('position', `${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}`);
  }

  /** Returns the player's current world-space position. */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }
}
