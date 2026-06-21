/**
 * VoxelCharacter — Rigged Voxel State Machine
 *
 * Implements the hierarchical pivot-joint rig, lerp-based state transitions,
 * and 8-way visual snapping described in the character model issue.
 *
 * Key concepts:
 *  - masterGroup  : follows the exact logical rotation (physics / collisions)
 *  - visualGroup  : reverses logical rotation then applies the snapped 45° increment
 *  - Limb meshes  : vertices shifted away from each pivot so rotation swings
 *                   from the joint (shoulder / hip) rather than the mesh centre
 */

import * as THREE from 'three';

export type CharacterState = 'idle' | 'walk' | 'sit_chair' | 'sit_ground';

interface PoseState {
  /** World-space Y for the torso root (lower values = seated) */
  rootY: number;
  /** Target X-rotation for both legs; null = computed dynamically (walk cycle) */
  legRotX: number | null;
  /** Target X-rotation for both arms; null = computed dynamically (walk cycle) */
  armRotX: number | null;
}

const STATES: Record<CharacterState, PoseState> = {
  idle:       { rootY: 1.0,  legRotX: 0,             armRotX: 0             },
  walk:       { rootY: 1.0,  legRotX: null,           armRotX: null          },
  sit_chair:  { rootY: 0.5,  legRotX: -Math.PI / 2,  armRotX: -Math.PI / 6  },
  sit_ground: { rootY: -0.2, legRotX: -Math.PI / 2,  armRotX: 0             },
};

export class VoxelCharacter {
  /** The logical root — attach physics / camera here. */
  public masterGroup: THREE.Group;

  /** The visual root — receives the snapped 8-way facing rotation. */
  private visualGroup: THREE.Group;

  // ── Hierarchical joints ────────────────────────────────────────────────────
  private torso:    THREE.Group;
  private head:     THREE.Group;
  private leftArm:  THREE.Group;
  private rightArm: THREE.Group;
  private leftLeg:  THREE.Group;
  private rightLeg: THREE.Group;

  // ── State ──────────────────────────────────────────────────────────────────
  private currentState: CharacterState = 'idle';

  /**
   * The continuous 0–2π logical facing angle (e.g. from network or input).
   * masterGroup.rotation.y always tracks this value exactly.
   */
  private logicalRotation = 0;

  private clock: THREE.Clock;

  constructor(scene: THREE.Scene) {
    // ── 1. Master / visual group hierarchy ───────────────────────────────────
    this.masterGroup = new THREE.Group();
    this.visualGroup = new THREE.Group();
    this.masterGroup.add(this.visualGroup);
    scene.add(this.masterGroup);

    // ── 2. Skeletal joints ────────────────────────────────────────────────────
    this.torso    = new THREE.Group();
    this.head     = new THREE.Group();
    this.leftArm  = new THREE.Group();
    this.rightArm = new THREE.Group();
    this.leftLeg  = new THREE.Group();
    this.rightLeg = new THREE.Group();

    // Build parent-child chain
    this.visualGroup.add(this.torso);
    this.torso.add(this.head);
    this.torso.add(this.leftArm);
    this.torso.add(this.rightArm);
    this.torso.add(this.leftLeg);
    this.torso.add(this.rightLeg);

    // ── 3. Pivot positions (joint locations relative to torso) ────────────────
    this.torso.position.y = 1.0;          // torso root above floor
    this.head.position.y  = 0.8;          // neck top
    this.leftArm.position.set(-0.6,  0.6, 0);  // left shoulder
    this.rightArm.position.set( 0.6,  0.6, 0);  // right shoulder
    this.leftLeg.position.set(-0.25, -0.4, 0);  // left hip
    this.rightLeg.position.set( 0.25, -0.4, 0);  // right hip

    // ── 4. Build voxel geometry ───────────────────────────────────────────────
    this._buildLimbVoxels();

    this.clock = new THREE.Clock();
    console.log('✅ VoxelCharacter created (rigged voxel form)');
  }

  /**
   * Construct the box meshes for every body part.
   *
   * CRITICAL: Each geometry is translated so its vertices hang *below* the
   * pivot point.  When the parent Group rotates the mesh swings from the
   * joint (shoulder / hip) rather than spinning around its own centre.
   */
  private _buildLimbVoxels(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xc86428,   // warm orange suit
      roughness: 0.8,
      metalness: 0.1,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xf4c090,   // skin tone
      roughness: 0.9,
      metalness: 0.0,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x3a2010,   // dark boots / belt
      roughness: 0.9,
      metalness: 0.0,
    });

    // ── Torso ─────────────────────────────────────────────────────────────────
    const torsoGeo = new THREE.BoxGeometry(0.8, 0.9, 0.4);
    this.torso.add(new THREE.Mesh(torsoGeo, bodyMat));

    // ── Head (offset upward so it sits above the neck joint) ─────────────────
    const headGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    headGeo.translate(0, 0.3, 0);
    this.head.add(new THREE.Mesh(headGeo, skinMat));

    // ── Arms — shift down so rotation pivots from shoulder ───────────────────
    const armGeo = new THREE.BoxGeometry(0.3, 0.8, 0.3);
    armGeo.translate(0, -0.4, 0);   // hang below shoulder pivot
    this.leftArm.add(new THREE.Mesh(armGeo, bodyMat));
    this.rightArm.add(new THREE.Mesh(armGeo, bodyMat));

    // ── Legs — shift down so rotation pivots from hip ────────────────────────
    const legGeo = new THREE.BoxGeometry(0.4, 0.9, 0.4);
    legGeo.translate(0, -0.45, 0);  // hang below hip pivot
    this.leftLeg.add(new THREE.Mesh(legGeo, bodyMat));
    this.rightLeg.add(new THREE.Mesh(legGeo, bodyMat));

    // ── Feet (decorative, part of leg group) ─────────────────────────────────
    const footGeo = new THREE.BoxGeometry(0.42, 0.22, 0.52);
    footGeo.translate(0, -0.88, 0.06);   // at the base of each leg
    this.leftLeg.add(new THREE.Mesh(footGeo, darkMat));
    this.rightLeg.add(new THREE.Mesh(footGeo, darkMat));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Switch to a new animation state and update the logical facing direction.
   * Call this whenever input or network packets change the character's intent.
   */
  setState(newState: CharacterState, networkRotation: number): void {
    this.currentState    = newState;
    this.logicalRotation = networkRotation;
  }

  /**
   * Advance the animation by one frame.
   * Call this inside your requestAnimationFrame / game-loop update.
   */
  update(): void {
    const delta = this.clock.getDelta();
    const time  = this.clock.getElapsedTime();
    const state = STATES[this.currentState];

    const lerpSpeed = 10 * delta;

    // ── 1. Root height interpolation (for sitting states) ────────────────────
    this.torso.position.y = THREE.MathUtils.lerp(
      this.torso.position.y,
      state.rootY,
      lerpSpeed
    );

    // ── 2. Limb rotations ────────────────────────────────────────────────────
    if (this.currentState === 'walk') {
      // Dynamic walk cycle — opposite limbs swing together
      const walkSpeed   = 8;
      const strideAngle = Math.PI / 4;   // 45° peak swing

      const leftPhase  = Math.sin(time * walkSpeed)            * strideAngle;
      const rightPhase = Math.sin(time * walkSpeed + Math.PI)  * strideAngle;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  leftPhase,  lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, rightPhase, lerpSpeed);
      // Arms swing opposite to the legs (natural gait)
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  rightPhase, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, leftPhase,  lerpSpeed);

      // Add a subtle vertical bounce on every step
      this.torso.position.y = state.rootY + Math.abs(Math.sin(time * walkSpeed)) * 0.1;

    } else {
      // Static target pose (idle / sitting)
      const legTarget = state.legRotX ?? 0;
      const armTarget = state.armRotX ?? 0;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  legTarget, lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, legTarget, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  armTarget, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, armTarget, lerpSpeed);
    }

    // ── 3. 8-way decoupled snapping ───────────────────────────────────────────
    // masterGroup tracks the exact continuous angle → correct for physics/camera
    this.masterGroup.rotation.y = this.logicalRotation;

    // visualGroup first cancels the masterGroup rotation …
    this.visualGroup.rotation.y = -this.logicalRotation;
    // … then adds the nearest 45° snap so the character always faces one of
    // 8 cardinal/diagonal directions regardless of the raw input angle.
    const PI_4         = Math.PI / 4;
    const snappedAngle = Math.round(this.logicalRotation / PI_4) * PI_4;
    this.visualGroup.rotation.y += snappedAngle;
  }
}
