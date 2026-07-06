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

type CharacterGender = 'male' | 'female';

// Current request: blue translucent parts mean male.
// Reserved: pink translucent parts mean female.
const CHARACTER_GENDER: CharacterGender = 'male';
const GENDER_THEME: Record<CharacterGender, { translucent: number; face: number; accent: number }> = {
  male: {
    translucent: 0x66c7ff,
    face: 0x113356,
    accent: 0x8bd9ff,
  },
  female: {
    translucent: 0xff9ac5,
    face: 0x6b1f46,
    accent: 0xffb6d8,
  },
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

  // ── Face voxels (generated as part of the robot head) ────────────────────
  private leftEye: THREE.Mesh | null = null;
  private rightEye: THREE.Mesh | null = null;
  private mouthMid: THREE.Mesh | null = null;
  private mouthLeft: THREE.Mesh | null = null;
  private mouthRight: THREE.Mesh | null = null;
  private smileAmount = 0;

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
    const theme = GENDER_THEME[CHARACTER_GENDER];

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xc86428,   // warm orange suit
      roughness: 0.8,
      metalness: 0.1,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: theme.translucent,
      emissive: theme.translucent,
      emissiveIntensity: 0.12,
      transparent: false,
      opacity: 1.0,
      roughness: 0.35,
      metalness: 0.05,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x3a2010,   // dark boots / belt
      roughness: 0.9,
      metalness: 0.0,
    });
    const faceMat = new THREE.MeshStandardMaterial({
      color: theme.face,
      emissive: theme.face,
      emissiveIntensity: 0.35,
      roughness: 0.6,
      metalness: 0.1,
    });
    const blushMat = new THREE.MeshStandardMaterial({
      color: theme.accent,
      roughness: 0.8,
      metalness: 0.0,
    });

    // ── Torso ─────────────────────────────────────────────────────────────────
    const torsoGeo = new THREE.BoxGeometry(0.8, 0.9, 0.4);
    this.torso.add(new THREE.Mesh(torsoGeo, bodyMat));

    // ── Head (oval) — softer silhouette than the original cube ──────────────
    const headGeo = new THREE.SphereGeometry(0.34, 20, 16);
    headGeo.scale(1.0, 1.12, 0.9); // vertical oval
    headGeo.translate(0, 0.31, 0);
    this.head.add(new THREE.Mesh(headGeo, skinMat));

    // Face voxels are part of the head geometry hierarchy (not a canvas overlay).
    const eyeGeo = new THREE.BoxGeometry(0.09, 0.1, 0.03);
    this.leftEye = new THREE.Mesh(eyeGeo, faceMat);
    this.rightEye = new THREE.Mesh(eyeGeo, faceMat);
    this.leftEye.position.set(-0.125, 0.45, 0.302);
    this.rightEye.position.set(0.125, 0.45, 0.302);
    this.head.add(this.leftEye);
    this.head.add(this.rightEye);

    const mouthGeo = new THREE.BoxGeometry(0.14, 0.035, 0.03);
    const mouthCornerGeo = new THREE.BoxGeometry(0.05, 0.03, 0.03);
    this.mouthMid = new THREE.Mesh(mouthGeo, faceMat);
    this.mouthLeft = new THREE.Mesh(mouthCornerGeo, faceMat);
    this.mouthRight = new THREE.Mesh(mouthCornerGeo, faceMat);
    this.head.add(this.mouthMid);
    this.head.add(this.mouthLeft);
    this.head.add(this.mouthRight);

    // Add tiny blush plates so the robot reads as friendlier.
    const blushGeo = new THREE.BoxGeometry(0.07, 0.05, 0.02);
    const blushL = new THREE.Mesh(blushGeo, blushMat);
    const blushR = new THREE.Mesh(blushGeo, blushMat);
    blushL.position.set(-0.215, 0.315, 0.298);
    blushR.position.set(0.215, 0.315, 0.298);
    this.head.add(blushL);
    this.head.add(blushR);
    this._updateFaceRig(0, 0);

    // ── Arms (rounded) — shift down so rotation pivots from shoulder ───────
    const armGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.8, 12);
    armGeo.translate(0, -0.4, 0);   // hang below shoulder pivot
    this.leftArm.add(new THREE.Mesh(armGeo, bodyMat));
    this.rightArm.add(new THREE.Mesh(armGeo, bodyMat));

    // ── Legs (rounded) — shift down so rotation pivots from hip ─────────────
    const legGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.9, 12);
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

    // Face expression animation (blink + smile) built into voxel rig.
    const blinkPulse = Math.pow(Math.max(0, Math.sin(time * 2.7)), 20);
    const smileTarget = this.currentState === 'walk' ? 1.0 : 0.65;
    this.smileAmount = THREE.MathUtils.lerp(this.smileAmount, smileTarget, 8 * delta);
    this._updateFaceRig(blinkPulse, this.smileAmount);

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

  private _updateFaceRig(blink: number, smile: number): void {
    if (!this.leftEye || !this.rightEye || !this.mouthMid || !this.mouthLeft || !this.mouthRight) return;

    const eyeScaleY = THREE.MathUtils.lerp(1.0, 0.12, blink);
    this.leftEye.scale.y = eyeScaleY;
    this.rightEye.scale.y = eyeScaleY;

    // Keep the mouth as an upturned arc even at idle.
    const mouthMidY = 0.236 + smile * 0.016;
    const cornerRise = 0.022 + smile * 0.028;
    this.mouthMid.position.set(0, mouthMidY, 0.302);
    this.mouthMid.scale.x = 1.25 + smile * 0.55;

    this.mouthLeft.position.set(-0.11, mouthMidY + cornerRise, 0.302);
    this.mouthRight.position.set(0.11, mouthMidY + cornerRise, 0.302);
    this.mouthLeft.rotation.z = 0.55 + smile * 0.35;
    this.mouthRight.rotation.z = -(0.55 + smile * 0.35);
  }
}
