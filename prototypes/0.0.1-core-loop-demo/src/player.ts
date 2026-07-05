/**
 * Player Entity
 * Drives a rigged VoxelCharacter with hybrid WASD + point-and-click A* navigation (Sprint 3 / Task 1.4).
 * Obstacle collision and 8-way directional snapping mirror the NPC logic.
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './main';
import { VoxelCharacter } from './voxelCharacter';
import { WaypointReticle } from './waypoint';
import { findPath, worldToCol, worldToRow } from './pathfinding';

const PLAYER_R = 0.38;

interface Box { x0: number; z0: number; x1: number; z1: number }

const OBSTACLES: Box[] = [
  // Fireplace / bookcase wall
  { x0: -5.00, z0: -5.95, x1:  5.00, z1: -5.08 },
  // Back 3-seater sofa
  { x0: -1.50, z0: -2.12, x1:  1.50, z1: -0.88 },
  // Front 3-seater sofa
  { x0: -1.50, z0:  2.58, x1:  1.50, z1:  3.82 },
  // Left-wall armchairs
  { x0: -4.82, z0: -4.32, x1: -3.78, z1:  2.32 },
  // Right-wall armchairs
  { x0:  3.78, z0: -4.32, x1:  4.82, z1:  2.32 },
  // Coffee table — back zone
  { x0: -0.94, z0: -3.82, x1:  0.94, z1: -2.78 },
  // Coffee table — front zone
  { x0: -0.94, z0:  1.02, x1:  0.94, z1:  1.98 },
  // Bar cabinet + stools
  { x0:  4.48, z0:  1.48, x1:  5.92, z1:  4.72 },
  // Lamp tables
  { x0: -4.62, z0: -5.02, x1: -3.98, z1: -4.38 },
  { x0:  3.98, z0: -5.02, x1:  4.62, z1: -4.38 },
  { x0: -4.12, z0:  2.88, x1: -3.48, z1:  3.52 },
  { x0:  3.48, z0:  2.88, x1:  4.12, z1:  3.52 },
];

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
  public mesh: THREE.Group;
  private character: VoxelCharacter;
  private reticle: WaypointReticle | null = null;
  
  private navMode: 'MANUAL' | 'WAYPOINT' = 'MANUAL';
  private path: Array<{ x: number; z: number }> = [];
  
  private speed = 3.2; // meters per second
  private bounds = 5.2;
  private logicalAngle = 0;

  constructor(scene: THREE.Scene) {
    // Scaffold player root utilizing the voxel structure (PR9/PR11)
    this.character = new VoxelCharacter(scene);
    this.mesh = this.character.masterGroup;
    this.mesh.position.set(0, 7.5, 0); // initial cinematic float
  }

  /** Request A* navigation towards target coordinate */
  navigateTo(tx: number, tz: number) {
    const startRow = worldToRow(this.mesh.position.z);
    const startCol = worldToCol(this.mesh.position.x);
    const targetRow = worldToRow(tz);
    const targetCol = worldToCol(tx);

    const calculatedPath = findPath(startRow, startCol, targetRow, targetCol);
    if (calculatedPath.length > 0) {
      if (this.reticle) {
        this.reticle.remove();
      }
      // Create new glowing target waypoint ring
      this.reticle = new WaypointReticle(this.mesh.parent as THREE.Scene, tx, tz);
      this.path = calculatedPath;
      this.navMode = 'WAYPOINT';
      console.log(`🧭 Waypoint navigation requested to (${tx.toFixed(2)}, ${tz.toFixed(2)}) with ${calculatedPath.length} nodes.`);
    }
  }

  update(deltaTime: number, inputManager: InputManager) {
    const dir = inputManager.getMoveDirection();
    const manualInput = dir.x !== 0 || dir.z !== 0;

    // manual input always overrides waypoint path immediately (v006 hybrid nav)
    if (manualInput && this.navMode === 'WAYPOINT') {
      this.navMode = 'MANUAL';
      this.path = [];
      if (this.reticle) {
        this.reticle.remove();
        this.reticle = null;
      }
      console.log('⌨️ Manual overrides waypoint navigation.');
    }

    if (this.mesh.visible) {
      if (this.navMode === 'MANUAL') {
        if (manualInput) {
          // Normalize diagonal speed boost
          const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
          const nx = dir.x / len;
          const nz = dir.z / len;

          const targetX = this.mesh.position.x + nx * this.speed * deltaTime;
          const targetZ = this.mesh.position.z + nz * this.speed * deltaTime;

          // Inflate wall collision check
          const cl = resolveObstacles(targetX, targetZ);
          this.mesh.position.x = Math.max(-this.bounds, Math.min(this.bounds, cl.x));
          this.mesh.position.z = Math.max(-this.bounds, Math.min(this.bounds, cl.z));

          // Set 8-way face target
          this.logicalAngle = Math.atan2(nx, nz);
          this.character.setState('walk', this.logicalAngle);
        } else {
          this.character.setState('idle', this.logicalAngle);
        }
      } else if (this.navMode === 'WAYPOINT' && this.path.length > 0) {
        // Step towards next pathfinding node in order
        const target = this.path[0];
        const dx = target.x - this.mesh.position.x;
        const dz = target.z - this.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        const step = this.speed * deltaTime;

        if (dist <= step) {
          // Snap directly to node and shift queue
          this.mesh.position.x = target.x;
          this.mesh.position.z = target.z;
          this.path.shift();

          if (this.path.length === 0) {
            this.navMode = 'MANUAL';
            if (this.reticle) {
              this.reticle.remove();
              this.reticle = null;
            }
            this.character.setState('idle', this.logicalAngle);
            console.log('🏁 Arrived at waypoint target location!');
          }
        } else {
          // Move step towards target node
          const nx = dx / dist;
          const nz = dz / dist;
          
          const cl = resolveObstacles(this.mesh.position.x + nx * step, this.mesh.position.z + nz * step);
          this.mesh.position.x = Math.max(-this.bounds, Math.min(this.bounds, cl.x));
          this.mesh.position.z = Math.max(-this.bounds, Math.min(this.bounds, cl.z));
          
          this.logicalAngle = Math.atan2(nx, nz);
          this.character.setState('walk', this.logicalAngle);
        }
      }

      // Update Voxel character leg animations & eyes
      this.character.update();

      if (this.reticle) {
        this.reticle.update(deltaTime);
      }

      // Update Debug HUD details
      updateDebugHUD('position', `X: ${this.mesh.position.x.toFixed(2)}, Z: ${this.mesh.position.z.toFixed(2)}`);

    } else {
      // Floating in skies during startup enter animation
      const valY = 7.5 + Math.sin(deltaTime * 2) * 0.08;
      this.mesh.position.set(0, valY, 0);
      updateDebugHUD('position', `sky`);
    }
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }
}
