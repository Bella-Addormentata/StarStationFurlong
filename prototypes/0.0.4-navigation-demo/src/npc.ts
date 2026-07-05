/**
 * NPC - Beautiful anime princess. Canvas 160×240, rendered at 4× then
 * downsampled by Three.js giving natural anti-aliasing.
 */
import * as THREE from 'three';
import { InputManager } from './input';
import { OBSTACLES as BASE_OBSTACLES, type Box } from './obstacles';

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
// Each box is inflated by NPC_R so we can treat the NPC as a point.
const NPC_R = 0.38;
const OBSTACLES: Box[] = [
  ...BASE_OBSTACLES,
  // Cherry blossom tree front-L (centre -5.0, +4.5)
  { x0: -5.48, z0:  4.08, x1: -4.52, z1:  4.92 },
  // Cherry blossom tree front-L2 (centre -5.0, +3.0)
  { x0: -5.48, z0:  2.58, x1: -4.52, z1:  3.42 },
  // Cherry blossom tree back-L (centre -4.9, -5.0)
  { x0: -5.38, z0: -5.48, x1: -4.42, z1: -4.52 },
  // Cherry blossom tree back-R (centre +4.9, -5.0)
  { x0:  4.42, z0: -5.48, x1:  5.38, z1: -4.52 },
];

// ── 8-way directional snap ───────────────────────────────────────────────────
// Locks visual facing to the 8 cardinal/diagonal directions (every 45°).
const SNAP_INCREMENT = Math.PI / 4;

/**
 * Snap a continuous angle to the nearest of 8 equally-spaced directions.
 * θ_snapped = round(θ / (π/4)) × (π/4)
 */
function snapTo8Ways(angle: number): number {
  return Math.round(angle / SNAP_INCREMENT) * SNAP_INCREMENT;
}

/**
 * Inflate each obstacle by NPC_R, then check if point (x,z) is inside.
 * Returns the push-out position (minimum-penetration axis).
 */
function resolveObstacles(x: number, z: number): { x: number; z: number } {
  let rx = x, rz = z;
  for (const b of OBSTACLES) {
    const ex0 = b.x0 - NPC_R, ex1 = b.x1 + NPC_R;
    const ez0 = b.z0 - NPC_R, ez1 = b.z1 + NPC_R;
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

// ── Sit zones: rectangles where NPC can sit (near sofa/chair edges) ─────────
// Each zone has an approach box + a canonical sit position + facing direction
interface SitZone { x0: number; z0: number; x1: number; z1: number;
                    sx: number; sz: number; face: 'front'|'back'|'side'; faceDir: number; }
const SIT_ZONES: SitZone[] = [
  // Back sofa: NPC blocked at z≈-0.50 (inflated obstacle south edge) — approach from south
  { x0: -1.4, z0: -0.8, x1:  1.4, z1:  0.1, sx:  0.0, sz: -1.50, face: 'back',  faceDir:  1 },
  // Front sofa: coffee table blocks center; approach from left side (x < -1.32)
  { x0: -1.8, z0:  1.5, x1: -1.1, z1:  2.2, sx:  0.0, sz:  2.65, face: 'back',  faceDir:  1 },
  // Front sofa: approach from right side (x > 1.32)
  { x0:  1.1, z0:  1.5, x1:  1.8, z1:  2.2, sx:  0.0, sz:  2.65, face: 'back',  faceDir:  1 },
  // Left wall chairs: NPC blocked at x≈-3.40 (inflated obstacle right edge)
  { x0: -3.6, z0: -4.2, x1: -3.2, z1: -3.4, sx: -4.3, sz: -3.8, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0: -2.8, x1: -3.2, z1: -2.0, sx: -4.3, sz: -2.4, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0: -1.4, x1: -3.2, z1: -0.6, sx: -4.3, sz: -1.0, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0:  0.0, x1: -3.2, z1:  0.8, sx: -4.3, sz:  0.4, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0:  1.4, x1: -3.2, z1:  2.2, sx: -4.3, sz:  1.8, face: 'side',  faceDir:  1 },
  // Right wall chairs: NPC blocked at x≈3.40 (inflated obstacle left edge)
  { x0:  3.2, z0: -4.2, x1:  3.6, z1: -3.4, sx:  4.3, sz: -3.8, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0: -2.8, x1:  3.6, z1: -2.0, sx:  4.3, sz: -2.4, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0: -1.4, x1:  3.6, z1: -0.6, sx:  4.3, sz: -1.0, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0:  0.0, x1:  3.6, z1:  0.8, sx:  4.3, sz:  0.4, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0:  1.4, x1:  3.6, z1:  2.2, sx:  4.3, sz:  1.8, face: 'side',  faceDir: -1 },
];

export class NPC {
  public mesh: THREE.Sprite;
  private elapsed = 0;
  private facing = 1;
  private view: 'front'|'back'|'side' = 'front';
  private readonly SPEED = 2.2;
  private readonly BOUND = 5.2;

  // Sit state
  private sitting = false;
  private sitBlend = 0;           // 0 = standing, 1 = fully seated
  private idleTimer = 0;          // seconds idle while inside a sit zone
  private currentZone: SitZone | null = null; // locked zone while seated
  private readonly SIT_DELAY = 1.2;
  private readonly SIT_SPEED = 2.5;

  constructor(scene: THREE.Scene) {
    const tex = new THREE.TextureLoader().load('/assets/npc.png');
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    this.mesh = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.04 })
    );
    this.mesh.scale.set(1.35, 2.03, 1);
    const sx = (Math.random()-.5)*6, sz = (Math.random()-.5)*6;
    this.mesh.position.set(sx, 1.0, sz);
    scene.add(this.mesh);
  }

  update(dt: number, inputManager: InputManager) {
    this.elapsed += dt;
    const pos = this.mesh.position;
    const dir = inputManager.getMoveDirection();
    const moving = dir.x !== 0 || dir.z !== 0;

    // When already seated keep the locked zone; otherwise scan approach boxes
    const zone = (this.sitting && this.currentZone)
      ? this.currentZone
      : (SIT_ZONES.find(z =>
          pos.x >= z.x0 && pos.x <= z.x1 && pos.z >= z.z0 && pos.z <= z.z1
        ) ?? null);

    if (moving) {
      // Any input: stand up immediately, reset timer
      this.sitting = false;
      this.currentZone = null;
      this.idleTimer = 0;
      this.sitBlend = Math.max(0, this.sitBlend - dt * this.SIT_SPEED * 2);

      const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      const nx = dir.x / len, nz = dir.z / len;

      // Snap movement angle to nearest 45° for visual facing.
      // Actual position movement continues to use the raw nx/nz so movement
      // stays fluid and responsive regardless of the snapped facing.
      const snappedAngle = snapTo8Ways(Math.atan2(nx, nz));
      const snappedNx = Math.sin(snappedAngle);
      const snappedNz = Math.cos(snappedAngle);
      if (Math.abs(snappedNx) > 0.06) this.facing = snappedNx > 0 ? 1 : -1;
      const adx = Math.abs(snappedNx), adz = Math.abs(snappedNz);
      this.view = adz > adx * 1.2 ? (snappedNz < 0 ? 'back' : 'front') : 'side';

      const candX = Math.max(-this.BOUND, Math.min(this.BOUND, pos.x + nx * this.SPEED * dt));
      const r1 = resolveObstacles(candX, pos.z);
      const candZ = Math.max(-this.BOUND, Math.min(this.BOUND, pos.z + nz * this.SPEED * dt));
      const r2 = resolveObstacles(r1.x, candZ);
      pos.x = r2.x; pos.z = r2.z;
      pos.y = 1.0 + Math.abs(Math.sin(this.elapsed * 6.5)) * (this.view === 'side' ? 0.058 : 0.038);
      this.mesh.scale.setX(1.35 * this.facing);

    } else if (zone) {
      // Idle inside a sit zone: count down then sit
      this.idleTimer += dt;

      if (!this.sitting && this.idleTimer >= this.SIT_DELAY) {
        this.sitting = true;
        this.currentZone = zone;   // lock zone so snap doesn't break detection
        // Snap to seat position & facing
        pos.x = zone.sx; pos.z = zone.sz;
        this.view = zone.face;
        this.facing = zone.faceDir;
      }

      if (this.sitting) {
        this.sitBlend = Math.min(1, this.sitBlend + dt * this.SIT_SPEED);
      }

      // Seated height: lower the sprite so feet touch the seat
      const seatY = 0.62;
      pos.y = 1.0 + (seatY - 1.0) * this.sitBlend + Math.sin(this.elapsed * 1.4) * 0.008;

    } else {
      // Idle outside sit zones: normal breathing
      this.sitting = false;
      this.idleTimer = 0;
      this.sitBlend = Math.max(0, this.sitBlend - dt * this.SIT_SPEED);
      pos.y = 1.0 + Math.sin(this.elapsed * 1.8) * 0.018;
    }
  }

}
