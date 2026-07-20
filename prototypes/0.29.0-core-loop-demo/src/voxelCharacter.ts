/**
 * VoxelCharacter — Rigged Fox Anthro State Machine (chibi-cute pass)
 *
 * Pivoted from the red-panda rig to a fox because a fox's iconic silhouette
 * (pointy triangular ears, pointed muzzle, big white-tipped tail, orange-with-
 * white markings) reads as "obvious cute character" faster than the panda did.
 * The proportions have also been re-tuned toward true chibi:
 *
 *   pass 3 head-to-body ratio ≈ 1:3   (adult mascot)
 *   this build head-to-body     ≈ 1:1.5 (chibi toddler)
 *
 * The character height is preserved — physics / camera / seat animations don't
 * change — but internally the head is much larger and the limbs are shorter
 * and stubbier so the whole thing reads as a cute plushie fox instead of a
 * chunky adult figure.
 *
 * Still keeping the shading upgrades from pass 3:
 *  - MeshToonMaterial + 4-band gradient map for cel shading
 *  - Inverted-hull outline shell around every silhouette mesh
 *  - Higher subdivisions on curved primitives
 *  - Unlit basic-material stylistic marks (eye shines, nose highlight, blush)
 *  - Subtle breathing scale + occasional ear twitches
 *
 * Tail: drooping natural-rest pose, roughly body-length, big fluffy base
 * tapering to a bright white tip. Sways side-to-side during walk.
 *
 * Public API preserved: constructor(scene), masterGroup, setState, update.
 * Only consumer is player.ts; NPCs use their own class.
 *
 * Outfit system (TR3, issue #35 — ADDITIVE, frozen API untouched):
 *  - _build* meshes whose material color comes from a swappable PAL entry are
 *    tagged with userData.paletteRole ('fur'|'furDeep'|'cream'|'accent').
 *  - setOutfit(outfit)/clearOutfit() recolor those materials with ABSOLUTE
 *    setHex (offsetHSL is cumulative — #27's documented trap), dedupe shared
 *    materials via a Set, skip the shared OUTLINE_MAT, and mirror the recolor
 *    into emissive where tmat() seeded it from the same hex. Originals are
 *    captured on first apply so restore/re-apply are exact.
 *  - attachAccessory/removeAccessory: one procedural head-slot accessory
 *    (cap/visor/scarf) parented to the head group, so it follows every
 *    walk/sit/twitch animation for free.
 */

import * as THREE from 'three';
import type { OutfitDef, PaletteRole, AccessoryKind } from './outfits';

export type CharacterState = 'idle' | 'walk' | 'sit_chair' | 'sit_ground' | 'sleep' | 'swim' | 'dive';

interface PoseState {
  /** World-space Y for the torso root (lower values = seated) */
  rootY: number;
  /** Target X-rotation for both legs; null = computed dynamically (walk cycle) */
  legRotX: number | null;
  /** Target X-rotation for both arms; null = computed dynamically (walk cycle) */
  armRotX: number | null;
  /**
   * Whole-body recline about X (🛏️ bunk beds): the torso group carries head /
   * arms / legs / tail, so tipping it lays the entire rig down in one joint.
   * Negative = onto the back, face up (head swings toward local -z — the
   * OPPOSITE of the facing direction). Undefined ⇒ upright (0).
   */
  bodyRotX?: number;
}

// Standing rootY math (issue #21 — feet below floor): torso.y ends up at
// rootY − 0.15, leg pivots hang at torso − 0.30, and the lowest foot-pad
// geometry extends −0.7328 below the leg pivot. At rootY 1.0 the pads sank to
// world y ≈ −0.18; rootY 1.18 puts the pad bottoms at ≈ −0.003 (flush with the
// y=0 floor). Walk bounce is strictly upward, so no transient dip re-appears.
const STATES: Record<CharacterState, PoseState> = {
  idle:       { rootY: 1.18, legRotX: 0,             armRotX: 0             },
  walk:       { rootY: 1.18, legRotX: null,          armRotX: null          },
  sit_chair:  { rootY: 0.5,  legRotX: -Math.PI / 2,  armRotX: -Math.PI / 6  },
  sit_ground: { rootY: -0.2, legRotX: -Math.PI / 2,  armRotX: 0             },
  // 🛏️ Lying on the back (bunk berths): legs/arms straight so they trail the
  // reclined torso horizontally. rootY holds the torso pivot high enough that
  // the oversized chibi skull squishes into the pillow rather than through the
  // mattress; the berth's elevation (top bunk) rides on the PLAYER MESH y, not
  // here, so one pose serves both bunks.
  sleep:      { rootY: 0.62, legRotX: 0,             armRotX: 0,            bodyRotX: -Math.PI / 2 },
  // 🏊 Swimming (pool seats): the PLAYER MESH y sits at POOL_SWIM_Y (-0.20),
  // so a low rootY sinks the torso beneath the water plane (y≈-0.03) and
  // leaves the chibi head bobbing above the surface — Habbo Lido style. Legs
  // tuck forward; arms paddle in a dedicated update() branch (null = dynamic).
  swim:       { rootY: -0.05, legRotX: -Math.PI / 2, armRotX: null          },
  // 🏊‍♂️ Dive arc: face-down superman — POSITIVE bodyRotX tips onto the FRONT
  // (sleep's -π/2 is onto the back), arms stretched past the head.
  dive:       { rootY: 0.9,  legRotX: 0,             armRotX: -Math.PI * 0.85, bodyRotX: Math.PI * 0.45 },
};

/** Snap a continuous angle to the nearest of 8 compass directions (π/4 steps). */
export function snapTo8Ways(angle: number): number {
  const PI_4 = Math.PI / 4;
  return Math.round(angle / PI_4) * PI_4;
}

// Fox palette — warm rich orange body, bright white underside, dark socks.
const PAL = {
  fur:        0xe07a2c,  // main warm orange body fur
  furDeep:    0xb45418,  // richer deep-orange (ear back, shading accents)
  cream:      0xfaf1d8,  // white / cream — chest, muzzle, inner ear, tail tip
  creamSoft:  0xfffbe8,  // brightest highlight cream (chest ruff top)
  dark:       0x2b1508,  // dark brown — socks, ear tips, feet
  paw:        0x1a0a04,  // paw underside — deepest tone
  pawPad:     0xa04a35,  // pink-brown paw pads
  pawPadHi:   0xd07458,  // brighter pad accent
  nose:       0x141010,  // nose + eye pupil
  noseHi:     0xffffff,  // nose highlight speck
  eyeIris:    0x27a4be,  // teal iris (cute anime tell — foxes canonically brown
                         //             but teal reads cuter and matches earlier art)
  eyeIrisHi:  0x64d8e8,  // iris highlight ring
  eyeShine:   0xffffff,  // pupil highlight
  blush:      0xe07868,  // soft pink blush on cheeks
  fang:       0xf6efd8,  // tiny visible tooth
  outline:    0x1e0d05,  // outline colour (soft dark brown)
};

// ── Toon gradient (4-band cel shading) ─────────────────────────────────────
// A tiny 4×1 DataTexture used as MeshToonMaterial.gradientMap. Nearest-filter
// sampling forces the shader to snap to one of four brightness bands, which
// is what gives the flat "cartoon" look. Higher steps = softer transitions;
// four steps is the sweet spot for chunky mascot art.
function createGradientMap(): THREE.DataTexture {
  const data = new Uint8Array([80, 140, 200, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const GRAD = createGradientMap();

// Toon material factory — cel-shaded with a subtle emissive tint so colours
// stay readable in dim light.
function tmat(hex: number, opts: { emissiveBoost?: number } = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: opts.emissiveBoost ?? 0.08,
    gradientMap: GRAD,
  });
}

// Basic (unlit) material — used for eye shines, nose highlight, blush.
// These are stylistic marks that shouldn't cast/receive shading.
function bmat(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: hex });
}

// Shared outline material — ONE instance shared across every outline shell of
// EVERY VoxelCharacter instance. Exported so despawn/tint code can skip it:
// disposing or recoloring it would break all rigs at once.
export const OUTLINE_MAT = new THREE.MeshBasicMaterial({
  color: PAL.outline,
  side: THREE.BackSide,
});

/**
 * Build an inverted-hull outline shell for a mesh. Renders only back faces
 * of a scaled-up copy of the mesh, giving a clean dark border wherever the
 * silhouette turns away from the camera.
 */
function outline(host: THREE.Mesh, thickness = 0.02): THREE.Mesh {
  const shell = new THREE.Mesh(host.geometry, OUTLINE_MAT);
  shell.scale.multiplyScalar(1 + thickness);
  shell.position.copy(host.position);
  shell.rotation.copy(host.rotation);
  shell.renderOrder = -1;
  return shell;
}

/** Small helper: add a mesh to a group AND drop an outline shell next to it. */
function addWithOutline(group: THREE.Group, mesh: THREE.Mesh, thickness = 0.02): void {
  group.add(mesh);
  group.add(outline(mesh, thickness));
}

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
  private tail:     THREE.Group;

  // Ear groups tracked so we can twitch them subtly during idle
  private leftEar:  THREE.Group | null = null;
  private rightEar: THREE.Group | null = null;

  // Torso "chest" group used for the subtle breathing scale
  private chest:    THREE.Group | null = null;

  // ── Face + expression meshes (kept as refs for blink / smile lerp) ────────
  private leftEye:   THREE.Mesh | null = null;
  private rightEye:  THREE.Mesh | null = null;
  private mouth:     THREE.Mesh | null = null;
  private smileAmount = 0;

  // ── State ──────────────────────────────────────────────────────────────────
  private currentState: CharacterState = 'idle';

  /**
   * The continuous 0–2π logical facing angle (e.g. from network or input).
   * masterGroup.rotation.y always tracks this value exactly.
   */
  private logicalRotation = 0;

  private clock: THREE.Clock;

  // ── Outfit state (TR3, issue #35) ──────────────────────────────────────────
  /**
   * Pristine color/emissive per role-tagged material, captured lazily on the
   * FIRST setOutfit before anything is mutated. clearOutfit restores from
   * here, and setOutfit reads un-overridden roles from here — so repeated
   * applies are exact (absolute hexes, zero cumulative drift).
   */
  private outfitOriginals = new Map<
    THREE.MeshToonMaterial,
    { color: number; emissive: number; emissiveSeeded: boolean }
  >();
  /** Currently attached head accessory (one slot), or null. */
  private accessoryGroup: THREE.Group | null = null;

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
    this.tail     = new THREE.Group();

    // Build parent-child chain
    this.visualGroup.add(this.torso);
    this.torso.add(this.head);
    this.torso.add(this.leftArm);
    this.torso.add(this.rightArm);
    this.torso.add(this.leftLeg);
    this.torso.add(this.rightLeg);
    this.torso.add(this.tail);

    // ── 3. Pivot positions (chibi proportions) ───────────────────────────────
    // The joints stay in roughly the same world-Y positions so the walk
    // cycle / seat animations still land right, but the visual meshes attached
    // to each joint are re-sized so the head visually dominates and the limbs
    // read as short stubs.
    this.torso.position.y = 1.03;             // idle rootY (1.18) − 0.15 chibi offset — feet flush at spawn
    this.head.position.y  = 0.55;             // head neck-point above torso — huge head above this
    this.leftArm.position.set(-0.5,  0.32, 0);// shoulders — pulled inward
    this.rightArm.position.set( 0.5,  0.32, 0);
    this.leftLeg.position.set(-0.20, -0.30, 0); // hips — pulled inward
    this.rightLeg.position.set( 0.20, -0.30, 0);

    // Tail root: attached LOW on the back (hip level) so the tail droops from
    // the base of the spine, not the mid-back. Angled BACKWARD-AND-DOWN via
    // negative rotation.x (right-hand rule tilts the tail group's local +Y
    // toward -Z, behind the character). -2.05 rad ≈ 117° gets a natural fox
    // drape without curling under the body.
    this.tail.position.set(0, -0.30, -0.28);
    this.tail.rotation.x = -2.05;

    // ── 4. Build voxel geometry ───────────────────────────────────────────────
    this._buildHead();
    this._buildTorso();
    this._buildArms();
    this._buildLegs();
    this._buildTail();

    this.clock = new THREE.Clock();
    console.log('✅ VoxelCharacter created (chibi fox)');
  }

  // ── Palette-role tagging (TR3, issue #35) ─────────────────────────────────
  //  Called at the end of each _build* with that builder's swappable
  //  materials. Tags every mesh under `root` whose material is one of them
  //  with userData.paletteRole so setOutfit can find the recolor targets.
  //  Everything else is skipped by construction: outline shells carry the
  //  shared OUTLINE_MAT, the face decal / nose / paw pads / vertex-colored
  //  ear cones use materials that simply aren't in the map.
  private _tagPaletteRoles(
    root: THREE.Object3D,
    roles: Array<[THREE.Material, PaletteRole]>
  ): void {
    const roleByMat = new Map(roles);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const role = roleByMat.get(mesh.material);
      if (role) mesh.userData.paletteRole = role;
    });
  }

  // ── Head ─────────────────────────────────────────────────────────────────
  //  MUCH bigger than any prior pass — dominates the character silhouette.
  //  Pointed fox muzzle, big pointy ears, huge chibi eyes.
  private _buildHead(): void {
    const furMat     = tmat(PAL.fur,       { emissiveBoost: 0.10 });
    const creamMat   = tmat(PAL.cream,     { emissiveBoost: 0.11 });
    const creamHi    = tmat(PAL.creamSoft, { emissiveBoost: 0.13 });
    const noseMat    = tmat(PAL.nose,      { emissiveBoost: 0.04 });
    const noseHiMat  = bmat(PAL.noseHi);

    // Skull — BIG rounded sphere, wider than tall for cute face silhouette
    const skullGeo = new THREE.SphereGeometry(0.62, 40, 30);
    skullGeo.scale(1.05, 1.02, 1.0);
    skullGeo.translate(0, 0.42, 0);
    const skull = new THREE.Mesh(skullGeo, furMat);
    addWithOutline(this.head, skull, 0.028);

    // (Removed: cheek puffs and chin patch. These were visual noise on top
    // of the muzzle+chin cream areas that the muzzle_bottom already provides.
    // Cute chibi face = big eyes + rounded muzzle only; extra facial fluff
    // fights for attention at play distance.)

    // Muzzle — POINTED forward, key fox feature. Built as a scaled cone with
    // rounded tip so it reads pointed but not sharp. Cream on underside,
    // orange on top.
    const muzzleTopGeo = new THREE.SphereGeometry(0.18, 26, 20);
    muzzleTopGeo.scale(1.0, 0.6, 1.55);
    muzzleTopGeo.translate(0, 0.04, 0.16);
    const muzzleTop = new THREE.Mesh(muzzleTopGeo, furMat);
    muzzleTop.position.set(0, 0.31, 0.30);
    addWithOutline(this.head, muzzleTop, 0.024);

    const muzzleBotGeo = new THREE.SphereGeometry(0.16, 24, 18);
    muzzleBotGeo.scale(1.0, 0.55, 1.5);
    muzzleBotGeo.translate(0, -0.04, 0.16);
    const muzzleBot = new THREE.Mesh(muzzleBotGeo, creamMat);
    muzzleBot.position.set(0, 0.20, 0.30);
    addWithOutline(this.head, muzzleBot, 0.024);

    // Nose — big cute button at muzzle tip
    const noseGeo = new THREE.SphereGeometry(0.075, 22, 18);
    noseGeo.scale(1.35, 0.90, 0.95);
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.set(0, 0.34, 0.60);
    addWithOutline(this.head, nose, 0.030);
    // Nose highlight speck — unlit, tiny
    const noseHi = new THREE.Mesh(
      new THREE.SphereGeometry(0.020, 12, 10),
      noseHiMat
    );
    noseHi.position.set(-0.014, 0.365, 0.65);
    this.head.add(noseHi);

    // Small mouth mark — smile curve below the nose. Simple line, no fang
    // (fang and small mouth marks fight for attention at play distance).
    const mouthGeo = new THREE.BoxGeometry(0.11, 0.025, 0.03);
    const mouth = new THREE.Mesh(mouthGeo, noseMat);
    mouth.position.set(0, 0.18, 0.68);
    this.head.add(mouth);
    this.mouth = mouth;

    // ── FACE DECAL (canvas-drawn 2D eyes + mouth) ────────────────────────
    // Big design change: instead of stacking 3D spheres for the eyes, paint
    // the whole face onto a canvas texture and apply it to a flat plane in
    // front of the head. That's how modern cute-mascot 3D games (Splatoon,
    // Fortnite, Overwatch supports) do anime faces on 3D bodies — the face
    // is 2D drawn, not 3D sculpted. Sidesteps every Z-fighting and
    // visibility issue we hit with the primitive stack.
    //
    // The plane sits just in front of the skull surface at the face's Y-mid
    // and its texture is drawn on-startup with pure Canvas 2D calls, so we
    // can iterate on the face by editing lines of drawing code.
    const facePlane = this._buildFaceDecal();
    this.head.add(facePlane);
    (facePlane as any).__leftEye = facePlane;   // reused by blink lerp
    this.leftEye  = facePlane;
    this.rightEye = facePlane;
    // The mouth mark 3D box below is retained as the smile-anchor mesh.

    // (Removed: eyebrow flecks and blush spots. Same reason as cheek puffs
    // above — too much small detail on the face. Big eyes carry the read.)

    // ── Ears ─────────────────────────────────────────────────────────────
    // BIG pointed triangular ears — signature fox feature. Pointing straight
    // up with slight outward tilt. Cream inner, orange outer, dark tip.
    //
    // Previously the ears looked like FLOATING TRIANGLES because:
    //   1. Ear position was 3% outside the skull ellipsoid (X=±0.32, y=0.98
    //      is outside the skull at that height) — the whole cone was above
    //      the head with a visible gap.
    //   2. Cone bottom is a flat disc that never blends with the round skull.
    //
    // Both fixed here:
    //   1. Ear now positioned INSIDE the skull surface (X=±0.28, y=0.94) so
    //      the base is embedded and only the pointed part sticks out.
    //   2. A rounded ORANGE BASE TUFT half-embedded in the skull hides the
    //      flat cone bottom and provides a smooth dome that connects ear
    //      into head. No outline on the tuft — an outline would draw a hard
    //      seam between the tuft and the skull; we want a seamless blend.
    const buildEar = (side: -1 | 1) => {
      const g = new THREE.Group();

      const EAR_H = 0.55;

      // Ear base tuft — half-embedded orange sphere, no outline
      const baseGeo = new THREE.SphereGeometry(0.25, 22, 16);
      baseGeo.scale(1.0, 0.85, 0.95);
      const base = new THREE.Mesh(baseGeo, furMat);
      base.position.y = 0.02;
      g.add(base);

      // Outer ear cone — single cone with a VERTEX COLOUR GRADIENT painted
      // from orange (base) to dark (tip). No separate tip mesh, no seam,
      // no floating-triangle discontinuity — the ear is one continuous
      // shape with a smooth colour change at the top. This is the clean
      // fix for the earlier "floating triangle on the tip" bug.
      const outerGeo = new THREE.ConeGeometry(0.22, EAR_H, 6);
      outerGeo.translate(0, EAR_H * 0.5 + 0.12, 0);

      // Paint per-vertex colour: orange for the bottom 65% of the cone,
      // ramp to dark over the top 35% for the "black-tipped fox ear" look.
      // The ramp uses pow(t, 3) to keep most of the cone orange and only
      // the very tip dark, matching the reference fox art proportions.
      const orangeColor = new THREE.Color(PAL.fur);
      const darkColor   = new THREE.Color(PAL.dark);
      const positions   = outerGeo.attributes.position;
      const colors      = new Float32Array(positions.count * 3);
      const coneBaseY   = 0.12;
      for (let i = 0; i < positions.count; i++) {
        const y = positions.getY(i);
        const t = Math.max(0, Math.min(1, (y - coneBaseY) / EAR_H));
        const mix = Math.pow(t, 3);   // most of cone orange, only tip dark
        const c = new THREE.Color().lerpColors(orangeColor, darkColor, mix);
        colors[i * 3    ] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      outerGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      // Custom vertex-coloured toon material for this cone (base white so
      // the vertex colours show through directly; low emissive so the tip
      // stays dark under bright ambient).
      const outerMat = new THREE.MeshToonMaterial({
        color: 0xffffff,
        vertexColors: true,
        gradientMap: GRAD,
      });
      const outer = new THREE.Mesh(outerGeo, outerMat);
      addWithOutline(g, outer, 0.035);

      // Inner ear cone — cream, sits in front of the outer cone
      const innerGeo = new THREE.ConeGeometry(0.14, EAR_H * 0.76, 6);
      innerGeo.translate(0, EAR_H * 0.76 * 0.5 + 0.14, 0);
      const inner = new THREE.Mesh(innerGeo, creamMat);
      inner.position.z = 0.05;
      g.add(inner);

      // Ear-inner fluff wisps — 2 tiny cream tufts near the inner ear base
      const wispGeo = new THREE.ConeGeometry(0.028, 0.08, 6);
      const wL = new THREE.Mesh(wispGeo, creamHi);
      const wR = new THREE.Mesh(wispGeo, creamHi);
      wL.position.set(-0.04, 0.24, 0.09); wL.rotation.z =  0.28;
      wR.position.set( 0.04, 0.24, 0.09); wR.rotation.z = -0.28;
      g.add(wL, wR);

      // Positioned INSIDE the skull ellipsoid so the base tuft can embed.
      // At (x=0.28, y=0.94) the skull ellipsoid formula sums to ~0.86 (< 1
      // = well inside). Ear tip still projects ~0.5 units above the skull.
      g.position.set(side * 0.28, 0.94, -0.02);
      g.rotation.z = side * -0.22;
      g.rotation.x = -0.10;
      return g;
    };
    this.leftEar  = buildEar(-1);
    this.rightEar = buildEar( 1);
    this.head.add(this.leftEar, this.rightEar);

    // Outfit roles: skull/muzzle-top/ear tufts = fur; muzzle underside +
    // inner-ear cones/wisps = cream. Nose, face decal, and the vertex-colored
    // outer ear cones stay untagged (not meaningfully swappable).
    this._tagPaletteRoles(this.head, [
      [furMat, 'fur'],
      [creamMat, 'cream'],
      [creamHi, 'cream'],
    ]);
  }

  // ── Face decal ──────────────────────────────────────────────────────────
  //  Canvas-drawn cute anime face (eyes + blush) on a plane in front of
  //  the head. The plane is transparent everywhere except the drawn strokes,
  //  so the orange fur shows through around them. The plane sits just in
  //  front of the skull surface at y = 0.44 (upper-middle of face) — this
  //  is the same Y the 3D eye stack used, so nose/muzzle/mouth positions
  //  don't need to move.
  //
  //  Why canvas 2D instead of stacking THREE meshes: we get clean crisp
  //  strokes that read as anime-style eyes at any camera distance, and
  //  every dimension is a single number I can tweak in JS instead of
  //  three variables per THREE.Sphere.
  private _buildFaceDecal(): THREE.Mesh {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;

    // Transparent background — the head fur shows through everywhere the
    // face isn't drawn.
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Colours mirror the PAL palette so the drawn face matches the 3D fur.
    const OUTLINE = '#1e0d05';
    const SCLERA  = '#faf1d8';
    const IRIS    = '#27a4be';
    const IRIS_HI = '#64d8e8';
    const PUPIL   = '#141010';
    const SHINE   = '#ffffff';
    const BLUSH   = 'rgba(224, 122, 105, 0.55)';

    // ── Eyes ─── two mirrored cute anime eyes ────────────────────────
    // Face coord system: (0,0) = top-left of canvas, (256, 256) = center.
    // Positioned in the upper-middle so the mouth/muzzle 3D geometry
    // occupies the lower face.
    const drawEye = (cx: number, cy: number, side: -1 | 1) => {
      // Sclera — BIG cream oval with heavy dark outline for contrast
      ctx.fillStyle = SCLERA;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 85, 110, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Iris — teal disc, larger to fill more of the sclera
      ctx.fillStyle = IRIS;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8, 66, 92, 0, 0, Math.PI * 2);
      ctx.fill();

      // Iris bright inner ring
      ctx.fillStyle = IRIS_HI;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 12, 42, 62, 0, 0, Math.PI * 2);
      ctx.fill();

      // Pupil — big dark oval
      ctx.fillStyle = PUPIL;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 12, 24, 48, 0, 0, Math.PI * 2);
      ctx.fill();

      // Big shine — up-and-out white oval, THE cute signal
      ctx.fillStyle = SHINE;
      ctx.beginPath();
      ctx.ellipse(cx + side * 22, cy - 30, 20, 26, 0, 0, Math.PI * 2);
      ctx.fill();

      // Small secondary shine — down-and-in white dot
      ctx.beginPath();
      ctx.ellipse(cx - side * 16, cy + 38, 9, 12, 0, 0, Math.PI * 2);
      ctx.fill();

      // Dark eyelash flourish above the outer eye — a curved arc adds
      // "closed-eye-when-smiling" feeling to the eye's upper outline.
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + side * 60, cy - 85);
      ctx.quadraticCurveTo(cx + side * 90, cy - 70, cx + side * 95, cy - 40);
      ctx.stroke();
    };
    // Two eyes with a nose-bridge gap. Y=220 is upper-middle of face area.
    // Centres at ±100 from canvas centre = ~0.18 world units apart.
    drawEye(156, 220, -1);
    drawEye(356, 220,  1);

    // ── Blush ─── soft pink translucent spots under each eye ─────────
    ctx.fillStyle = BLUSH;
    ctx.beginPath();
    ctx.ellipse(90, 360, 48, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(422, 360, 48, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Build the texture and plane. The plane is sized 0.90 units wide so
    // the drawn eyes end up ~0.18 wide each in world space — comparable
    // to the previous 3D-sphere eye but crisper.
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    // NOTE: keep default sRGB in three.js r167 (no explicit colorSpace set
    // here — the canvas is already sRGB and the renderer knows).

    const geo = new THREE.PlaneGeometry(0.90, 0.90);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.02,       // treat near-transparent pixels as fully clear
      side: THREE.DoubleSide, // in case the character rotates past 90°
      depthWrite: false,     // don't mask surrounding fur through the plane
    });
    const plane = new THREE.Mesh(geo, mat);
    // Plane centre at the upper-middle of the face. Just barely forward of
    // the skull surface at (0, 0.44, ~0.60) so it doesn't Z-fight with fur.
    plane.position.set(0, 0.42, 0.61);
    // Render after the skull so alpha compositing works cleanly.
    plane.renderOrder = 5;
    return plane;
  }

  // ── Torso ────────────────────────────────────────────────────────────────
  //  SMALL, chubby, round. Cream chest patch dominates the front.
  private _buildTorso(): void {
    const furMat   = tmat(PAL.fur,       { emissiveBoost: 0.09 });
    const creamMat = tmat(PAL.cream,     { emissiveBoost: 0.10 });
    const creamHi  = tmat(PAL.creamSoft, { emissiveBoost: 0.12 });

    this.chest = new THREE.Group();
    this.torso.add(this.chest);

    // Rounded plump torso — a wider-than-tall sphere for chibi silhouette
    const torsoGeo = new THREE.SphereGeometry(0.44, 32, 24);
    torsoGeo.scale(1.0, 0.9, 0.75);
    const torso = new THREE.Mesh(torsoGeo, furMat);
    addWithOutline(this.chest, torso, 0.024);

    // Cream chest / belly patch — big front oval
    const bellyGeo = new THREE.SphereGeometry(0.34, 28, 22);
    bellyGeo.scale(0.90, 1.15, 0.50);
    const belly = new THREE.Mesh(bellyGeo, creamMat);
    belly.position.set(0, -0.02, 0.20);
    addWithOutline(this.chest, belly, 0.022);

    // Chest ruff — bright cream tuft under the chin (small fluff)
    const ruffGeo = new THREE.SphereGeometry(0.24, 22, 18);
    ruffGeo.scale(1.0, 0.65, 0.85);
    const ruff = new THREE.Mesh(ruffGeo, creamHi);
    ruff.position.set(0, 0.32, 0.15);
    addWithOutline(this.chest, ruff, 0.022);

    // Outfit roles: torso shell = fur; belly patch + chest ruff = cream.
    this._tagPaletteRoles(this.chest, [
      [furMat, 'fur'],
      [creamMat, 'cream'],
      [creamHi, 'cream'],
    ]);
  }

  // ── Arms ─────────────────────────────────────────────────────────────────
  //  STUBBY. Short arms hanging by the sides, small dark paws.
  private _buildArms(): void {
    const furMat   = tmat(PAL.fur,      { emissiveBoost: 0.09 });
    const darkMat  = tmat(PAL.dark,     { emissiveBoost: 0.05 });
    const pawMat   = tmat(PAL.paw,      { emissiveBoost: 0.05 });
    const padMat   = tmat(PAL.pawPad,   { emissiveBoost: 0.10 });
    const padHi    = bmat(PAL.pawPadHi);

    const buildArm = (group: THREE.Group) => {
      // Fur arm — short, teardrop tapering to the paw
      const armGeo = new THREE.CylinderGeometry(0.15, 0.13, 0.50, 18);
      armGeo.translate(0, -0.25, 0);
      const arm = new THREE.Mesh(armGeo, furMat);
      addWithOutline(group, arm, 0.024);

      // Dark forearm "glove" — bottom half of arm goes dark
      const gloveGeo = new THREE.CylinderGeometry(0.135, 0.12, 0.24, 16);
      gloveGeo.translate(0, -0.42, 0);
      const glove = new THREE.Mesh(gloveGeo, darkMat);
      addWithOutline(group, glove, 0.026);

      // Paw — dark rounded ball at the end
      const pawGeo = new THREE.SphereGeometry(0.14, 22, 18);
      pawGeo.scale(1.05, 0.9, 1.10);
      const paw = new THREE.Mesh(pawGeo, pawMat);
      paw.position.y = -0.56;
      addWithOutline(group, paw, 0.028);

      // Palm pad — soft pink underneath
      const palmGeo = new THREE.SphereGeometry(0.055, 14, 10);
      palmGeo.scale(1.1, 0.5, 0.85);
      const palm = new THREE.Mesh(palmGeo, padMat);
      palm.position.set(0, -0.60, 0.07);
      group.add(palm);

      // Palm highlight
      const palmHiGeo = new THREE.SphereGeometry(0.022, 8, 6);
      palmHiGeo.scale(1.4, 0.4, 1.0);
      const palmHi = new THREE.Mesh(palmHiGeo, padHi);
      palmHi.position.set(0, -0.595, 0.09);
      group.add(palmHi);

      // Three small finger-pad dots
      const dotGeo = new THREE.SphereGeometry(0.018, 10, 8);
      for (let i = -1; i <= 1; i++) {
        const d = new THREE.Mesh(dotGeo, padMat);
        d.position.set(i * 0.045, -0.55, 0.12);
        group.add(d);
      }
    };

    buildArm(this.leftArm);
    buildArm(this.rightArm);

    // Outfit roles: upper arm = fur; dark glove + paw ball = accent (reads
    // as "gloves" when recolored). Pink palm pads stay untagged.
    for (const arm of [this.leftArm, this.rightArm]) {
      this._tagPaletteRoles(arm, [
        [furMat, 'fur'],
        [darkMat, 'accent'],
        [pawMat, 'accent'],
      ]);
    }
  }

  // ── Legs ─────────────────────────────────────────────────────────────────
  //  SHORT stubby legs with dark "socks" and rounded feet with pink pads.
  private _buildLegs(): void {
    const furMat  = tmat(PAL.fur,      { emissiveBoost: 0.09 });
    const darkMat = tmat(PAL.dark,     { emissiveBoost: 0.05 });
    const pawMat  = tmat(PAL.paw,      { emissiveBoost: 0.05 });
    const padMat  = tmat(PAL.pawPad,   { emissiveBoost: 0.10 });
    const padHi   = bmat(PAL.pawPadHi);

    const buildLeg = (group: THREE.Group) => {
      // Fluffy upper thigh — fur
      const thighGeo = new THREE.CylinderGeometry(0.20, 0.18, 0.28, 18);
      thighGeo.translate(0, -0.14, 0);
      const thigh = new THREE.Mesh(thighGeo, furMat);
      addWithOutline(group, thigh, 0.024);

      // Dark "sock" — lower leg goes dark (iconic fox marking)
      const sockGeo = new THREE.CylinderGeometry(0.17, 0.15, 0.28, 16);
      sockGeo.translate(0, -0.42, 0);
      const sock = new THREE.Mesh(sockGeo, darkMat);
      addWithOutline(group, sock, 0.026);

      // Foot — rounded dark box
      const footGeo = new THREE.BoxGeometry(0.30, 0.16, 0.38);
      footGeo.translate(0, -0.62, 0.06);
      const foot = new THREE.Mesh(footGeo, pawMat);
      addWithOutline(group, foot, 0.022);

      // Rounded foot top (fills box corners for a softer silhouette)
      const footTopGeo = new THREE.SphereGeometry(0.16, 20, 14);
      footTopGeo.scale(1.0, 0.7, 1.15);
      const footTop = new THREE.Mesh(footTopGeo, pawMat);
      footTop.position.set(0, -0.60, 0.06);
      addWithOutline(group, footTop, 0.025);

      // Big pink pad underneath the foot
      const padGeo = new THREE.SphereGeometry(0.065, 14, 10);
      padGeo.scale(1.3, 0.35, 1.0);
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(0, -0.71, 0.10);
      group.add(pad);

      // Pad highlight
      const padHiGeo = new THREE.SphereGeometry(0.028, 8, 6);
      padHiGeo.scale(1.3, 0.35, 1.0);
      const padHiMesh = new THREE.Mesh(padHiGeo, padHi);
      padHiMesh.position.set(0, -0.705, 0.12);
      group.add(padHiMesh);

      // Three small toe dots
      const toeGeo = new THREE.SphereGeometry(0.02, 10, 8);
      for (let i = -1; i <= 1; i++) {
        const t = new THREE.Mesh(toeGeo, padMat);
        t.position.set(i * 0.08, -0.71, 0.22);
        group.add(t);
      }
    };

    buildLeg(this.leftLeg);
    buildLeg(this.rightLeg);

    // Outfit roles: thigh = fur; dark sock + foot = accent (reads as
    // "boots" when recolored). Pink foot pads / toe dots stay untagged.
    for (const leg of [this.leftLeg, this.rightLeg]) {
      this._tagPaletteRoles(leg, [
        [furMat, 'fur'],
        [darkMat, 'accent'],
        [pawMat, 'accent'],
      ]);
    }
  }

  // ── Tail ─────────────────────────────────────────────────────────────────
  //  BIG fluffy fox tail. Droops down-and-back at rest (tail joint rotation.x
  //  already set in constructor). Roughly body-length. Fat orange base
  //  tapering to a BRIGHT WHITE TIP — the iconic fox marker.
  //
  //  Built as a stack of large fluff spheres along the tail group's +Y axis,
  //  each slightly smaller than the last, plus a couple of side fluff puffs
  //  for volume, ending in an oversized cream tip sphere.
  private _buildTail(): void {
    const furMat   = tmat(PAL.fur,      { emissiveBoost: 0.09 });
    const furDeep  = tmat(PAL.furDeep,  { emissiveBoost: 0.08 });
    const creamMat = tmat(PAL.cream,    { emissiveBoost: 0.11 });
    const creamHi  = tmat(PAL.creamSoft,{ emissiveBoost: 0.13 });

    // Main tail spine — 3 overlapping fluff spheres. Shorter overall length
    // than the previous 5-segment build; total spine ~0.54 units so the tail
    // reads as a stubby-cute plume rather than a long trailing drape.
    const SEGMENTS = 3;
    const segH = 0.18;
    let radius = 0.20;
    for (let i = 0; i < SEGMENTS; i++) {
      const geo = new THREE.SphereGeometry(radius, 24, 18);
      geo.scale(1.0, 1.05, 1.0);
      geo.translate(0, i * segH + segH / 2, 0);

      // First and last segments use main fur, middle uses slightly deeper
      // fur for subtle tonal variation.
      const material = i === 1 ? furDeep : furMat;
      const seg = new THREE.Mesh(geo, material);
      addWithOutline(this.tail, seg, 0.026);
      radius *= 0.90;
    }

    // Two side fluff puffs — one per side at the tail base for a fuller plume
    // silhouette without adding to the tail length.
    const sideFluff: [number, number, number, number][] = [
      [-0.15, 0.14, 0.02, 0.12],
      [ 0.15, 0.20, 0.02, 0.11],
    ];
    for (const [x, y, z, r] of sideFluff) {
      const geo = new THREE.SphereGeometry(r, 18, 14);
      geo.scale(0.85, 1.0, 0.85);
      const puff = new THREE.Mesh(geo, furMat);
      puff.position.set(x, y, z);
      addWithOutline(this.tail, puff, 0.026);
    }

    // ── White tip — the iconic fox marker. Sized down to match the shorter
    // tail so the tip reads as ~1/3 of the tail length instead of dominating.
    const tipY = SEGMENTS * segH;
    const tipMainGeo = new THREE.SphereGeometry(0.15, 24, 18);
    tipMainGeo.scale(1.05, 1.20, 1.05);
    const tipMain = new THREE.Mesh(tipMainGeo, creamMat);
    tipMain.position.set(0, tipY + 0.01, 0);
    addWithOutline(this.tail, tipMain, 0.028);

    // Bright secondary tip highlight
    const tipHiGeo = new THREE.SphereGeometry(0.11, 18, 14);
    tipHiGeo.scale(0.9, 1.0, 0.9);
    const tipHi = new THREE.Mesh(tipHiGeo, creamHi);
    tipHi.position.set(0, tipY + 0.07, 0.015);
    addWithOutline(this.tail, tipHi, 0.028);

    // Outfit roles: tail spine/fluff = fur, middle segment = furDeep,
    // white tip = cream.
    this._tagPaletteRoles(this.tail, [
      [furMat, 'fur'],
      [furDeep, 'furDeep'],
      [creamMat, 'cream'],
      [creamHi, 'cream'],
    ]);
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
   * Dress the rig in an outfit: absolute palette-role recolor + optional head
   * accessory. Additive to the frozen API (TR3, issue #35).
   *
   * Hazards handled (all learned in #27's applyPeerTint):
   *  - materials are shared across meshes within the rig → dedupe via a Set;
   *  - outline shells share the module-wide OUTLINE_MAT → skip it (recoloring
   *    it would repaint every rig's outlines at once);
   *  - offsetHSL is cumulative → absolute color.setHex only;
   *  - tmat() seeds emissive from the same hex as color → mirror the recolor
   *    into emissive so it holds up in dim light (only when it was seeded).
   *
   * Roles absent from paletteOverrides are restored to their pristine PAL
   * color, so outfit-to-outfit switches never leave stale colors and applying
   * the same outfit twice is exactly idempotent.
   */
  setOutfit(outfit: OutfitDef): void {
    const seen = new Set<THREE.Material>();
    this.visualGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const role = mesh.userData.paletteRole as PaletteRole | undefined;
      if (!role) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || m === OUTLINE_MAT || seen.has(m)) continue;
        seen.add(m);
        const mat = m as THREE.MeshToonMaterial;
        if (!mat.color) continue;
        // Capture pristine values BEFORE the first mutation — the exact
        // restore source for clearOutfit and un-overridden roles.
        let orig = this.outfitOriginals.get(mat);
        if (!orig) {
          orig = {
            color: mat.color.getHex(),
            emissive: mat.emissive ? mat.emissive.getHex() : 0,
            emissiveSeeded:
              !!mat.emissive && mat.emissive.getHex() === mat.color.getHex(),
          };
          this.outfitOriginals.set(mat, orig);
        }
        const target = outfit.paletteOverrides[role] ?? orig.color;
        mat.color.setHex(target);
        if (mat.emissive && orig.emissiveSeeded) mat.emissive.setHex(target);
      }
    });
    this.removeAccessory();
    if (outfit.accessory) this.attachAccessory(outfit.accessory);
  }

  /** Restore every outfit-touched material to its pristine color/emissive and
   *  detach any accessory. Exact inverse of setOutfit (no drift). */
  clearOutfit(): void {
    for (const [mat, orig] of this.outfitOriginals) {
      mat.color.setHex(orig.color);
      if (mat.emissive) mat.emissive.setHex(orig.emissive);
    }
    this.removeAccessory();
  }

  /**
   * Attach one procedural accessory to the HEAD group (single slot — replaces
   * any current accessory). Parented under this.head, so it inherits every
   * walk-bob / sit / facing transform with zero animation wiring.
   */
  attachAccessory(kind: AccessoryKind): void {
    this.removeAccessory();
    const g =
      kind === 'cap'   ? this._buildCapAccessory()   :
      kind === 'visor' ? this._buildVisorAccessory() :
                         this._buildScarfAccessory();
    g.name = `accessory:${kind}`;
    this.head.add(g);
    this.accessoryGroup = g;
  }

  /** Detach and dispose the current accessory (if any). Follows the despawn
   *  discipline from world.ts: dedupe geometries/materials via a Set and
   *  NEVER dispose the shared OUTLINE_MAT (outline shells reuse host geo). */
  removeAccessory(): void {
    const g = this.accessoryGroup;
    if (!g) return;
    this.head.remove(g);
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || disposed.has(mat)) continue;
        disposed.add(mat);
        mat.dispose();
      }
    });
    this.accessoryGroup = null;
  }

  /**
   * Advance the animation by one frame.
   * Call this inside your requestAnimationFrame / game-loop update.
   */
  update(): void {
    // Clamp the frame delta: a backgrounded tab pauses rAF, so on resume
    // getDelta() returns SECONDS. lerp(a, b, t) with t > 1 EXTRAPOLATES past
    // the target and amplifies each frame — the torso (carrying legs/feet)
    // exploded to ±1e17 world units after one alt-tab cycle ("legs and feet
    // shifted below ground"). Clamping both the delta and the lerp factor
    // makes every rig interpolation unconditionally stable.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const time  = this.clock.getElapsedTime();
    const state = STATES[this.currentState];

    const lerpSpeed = Math.min(10 * delta, 1);

    // ── 1. Root height interpolation (for sitting states) ────────────────────
    this.torso.position.y = THREE.MathUtils.lerp(
      this.torso.position.y,
      state.rootY - 0.15,  // chibi torso sits lower than adult
      lerpSpeed
    );

    // Whole-body recline (🛏️ sleep pose) — every other state converges back
    // to upright through the same lerp, so wake-up needs no special casing.
    this.torso.rotation.x = THREE.MathUtils.lerp(
      this.torso.rotation.x,
      state.bodyRotX ?? 0,
      lerpSpeed
    );

    // ── 2. Limb rotations + tail sway ────────────────────────────────────────
    if (this.currentState === 'walk') {
      const walkSpeed   = 8;
      const strideAngle = Math.PI / 4;

      const leftPhase  = Math.sin(time * walkSpeed)            * strideAngle;
      const rightPhase = Math.sin(time * walkSpeed + Math.PI)  * strideAngle;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  leftPhase,  lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, rightPhase, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  rightPhase, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, leftPhase,  lerpSpeed);

      this.torso.position.y = (state.rootY - 0.15) + Math.abs(Math.sin(time * walkSpeed)) * 0.09;

      // Tail sway — bigger amplitude on walk, tail wags side to side
      this.tail.rotation.y = Math.sin(time * walkSpeed * 0.5) * 0.35;

    } else if (this.currentState === 'swim') {
      // 🏊 Gentle paddle: arms alternate at a lazy cadence, legs stay tucked
      // (table value), torso bobs with the water. Same clamped-lerp discipline
      // as walk so an alt-tab resume can't extrapolate.
      const paddle = Math.sin(time * 3.0) * 0.45;
      const legTarget = state.legRotX ?? 0;
      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  legTarget, lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, legTarget, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  paddle,  lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -paddle, lerpSpeed);
      // Water bob rides ON TOP of the root lerp from section 1.
      this.torso.position.y += Math.sin(time * 2.0) * 0.03;
      // Tail drifts slowly like it's floating behind.
      this.tail.rotation.y = Math.sin(time * 1.2) * 0.2;

    } else {
      const legTarget = state.legRotX ?? 0;
      const armTarget = state.armRotX ?? 0;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  legTarget, lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, legTarget, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  armTarget, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, armTarget, lerpSpeed);

      // Idle tail — slow gentle sway
      const idleSway = Math.sin(time * 1.5) * 0.12;
      this.tail.rotation.y = THREE.MathUtils.lerp(this.tail.rotation.y, idleSway, lerpSpeed);
    }

    // Face expression — blink + smile. Asleep ⇒ eyes held fully closed (the
    // blink squash at its max) with a soft contented smile.
    const blinkPulse = this.currentState === 'sleep'
      ? 1
      : Math.pow(Math.max(0, Math.sin(time * 2.7)), 20);
    const smileTarget = this.currentState === 'walk' ? 1.0 : 0.65;
    this.smileAmount = THREE.MathUtils.lerp(this.smileAmount, smileTarget, 8 * delta);
    this._updateFaceRig(blinkPulse, this.smileAmount);

    // Breathing — subtle vertical scale on chest
    if (this.chest) {
      const breath = 1 + Math.sin(time * 1.4) * 0.025;
      this.chest.scale.y = breath;
    }

    // Occasional ear twitches during idle
    if (this.currentState !== 'walk' && this.leftEar && this.rightEar) {
      const twitchL = Math.max(0, Math.sin(time * 0.7 - 0.5) - 0.85) * 10;
      const twitchR = Math.max(0, Math.sin(time * 0.6 + 1.1) - 0.85) * 10;
      this.leftEar.rotation.x  = -0.10 + twitchL * -0.35;
      this.rightEar.rotation.x = -0.10 + twitchR * -0.35;
    } else if (this.leftEar && this.rightEar) {
      this.leftEar.rotation.x  = -0.10;
      this.rightEar.rotation.x = -0.10;
    }

    // ── 3. 8-way decoupled snapping ───────────────────────────────────────────
    this.masterGroup.rotation.y = this.logicalRotation;
    this.visualGroup.rotation.y = -this.logicalRotation;
    this.visualGroup.rotation.y += snapTo8Ways(this.logicalRotation);
  }

  private _updateFaceRig(blink: number, smile: number): void {
    if (!this.leftEye || !this.rightEye || !this.mouth) return;

    const eyeScaleY = THREE.MathUtils.lerp(1.0, 0.10, blink);
    this.leftEye.scale.y = eyeScaleY;
    this.rightEye.scale.y = eyeScaleY;

    this.mouth.scale.x = 1.0 + smile * 0.7;
    this.mouth.position.y = 0.17 + smile * 0.015;
  }

  // ── Accessory builders (TR3, issue #35) ────────────────────────────────────
  //  Small procedural props in the rig's own toon-outline style: same tmat()
  //  factory + addWithOutline() shells for opaque parts. All coordinates are
  //  HEAD-LOCAL (head origin = neck point; skull center y≈0.42, r≈0.62;
  //  ears at x=±0.28, y=0.94; face plane at z=0.61).

  /** Cap: low crown perched between the ears + forward brim + button. */
  private _buildCapAccessory(): THREE.Group {
    const g = new THREE.Group();
    const capMat  = tmat(0x2e6f9e, { emissiveBoost: 0.10 });  // steel blue
    const trimMat = tmat(0xf2e3c8, { emissiveBoost: 0.11 });  // parchment trim

    // Crown — squashed cylinder sitting on the skull dome, between the ears
    // (radius 0.30 just clears the ear bases at x=±0.28).
    const crownGeo = new THREE.CylinderGeometry(0.27, 0.33, 0.17, 20);
    const crown = new THREE.Mesh(crownGeo, capMat);
    crown.position.set(0, 1.04, 0.08);
    addWithOutline(g, crown, 0.03);

    // Dome top — rounds off the crown so the silhouette stays plushie-soft.
    const domeGeo = new THREE.SphereGeometry(0.27, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const dome = new THREE.Mesh(domeGeo, capMat);
    dome.position.set(0, 1.12, 0.08);
    g.add(dome);

    // Brim — flat rounded box jutting forward over the face.
    const brimGeo = new THREE.BoxGeometry(0.44, 0.045, 0.30);
    const brim = new THREE.Mesh(brimGeo, capMat);
    brim.position.set(0, 0.99, 0.42);
    brim.rotation.x = 0.12;   // slight downward tilt
    addWithOutline(g, brim, 0.025);

    // Button on top.
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), trimMat);
    button.position.set(0, 1.24, 0.08);
    g.add(button);
    return g;
  }

  /** Visor: thin translucent cyan band curved across the face. Translucent →
   *  no outline shell; renderOrder 6 so it composites over the face decal
   *  (renderOrder 5, both depthWrite-off). */
  private _buildVisorAccessory(): THREE.Group {
    const g = new THREE.Group();
    const visorMat = new THREE.MeshBasicMaterial({
      color: 0x63d6e8,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // Design-opacity marker: zoom.ts's first-person avatar fade scales
    // per-material opacity by (1 − ratio) and restores to this value rather
    // than a blanket 1.0 — without it, one first-person round trip would
    // leave the translucent visor a fully opaque cyan slab.
    visorMat.userData.baseOpacity = 0.35;
    // Open cylinder segment centered on +Z (thetaStart −0.45π..+0.45π), a
    // hair wider than the skull so it floats just off the fur.
    const bandGeo = new THREE.CylinderGeometry(
      0.66, 0.66, 0.20, 32, 1, true, -Math.PI * 0.45, Math.PI * 0.9
    );
    const band = new THREE.Mesh(bandGeo, visorMat);
    band.position.set(0, 0.47, 0.02);
    band.renderOrder = 6;
    g.add(band);

    // Slim dark frame rail along the visor's top edge (opaque anchor).
    const railGeo = new THREE.CylinderGeometry(
      0.665, 0.665, 0.04, 32, 1, true, -Math.PI * 0.48, Math.PI * 0.96
    );
    const rail = new THREE.Mesh(railGeo, tmat(0x30363f, { emissiveBoost: 0.06 }));
    rail.position.set(0, 0.585, 0.02);
    g.add(rail);
    return g;
  }

  /** Scarf: chunky torus band hugging the neck seam + a hanging front flap. */
  private _buildScarfAccessory(): THREE.Group {
    const g = new THREE.Group();
    const scarfMat = tmat(0xb8402e, { emissiveBoost: 0.10 });  // warm red
    // Torus lies in the XZ plane (rotation.x = π/2) right where the skull
    // meets the torso (head-local y≈−0.06); major radius 0.36 threads the
    // skull's ~0.42 cross-section radius at that height through the tube.
    const bandGeo = new THREE.TorusGeometry(0.36, 0.11, 12, 24);
    const band = new THREE.Mesh(bandGeo, scarfMat);
    band.rotation.x = Math.PI / 2;
    band.position.set(0, -0.06, 0.0);
    addWithOutline(g, band, 0.025);

    // Hanging flap off the front-right of the band, clear of the chest ruff.
    const flapGeo = new THREE.BoxGeometry(0.15, 0.30, 0.06);
    const flap = new THREE.Mesh(flapGeo, scarfMat);
    flap.position.set(0.15, -0.24, 0.40);
    flap.rotation.z = 0.18;
    addWithOutline(g, flap, 0.02);
    return g;
  }
}
